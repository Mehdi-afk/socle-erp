// SPDX-License-Identifier: LGPL-3.0-only
import { Button, Card, SelectField, Skeleton, StatusPill, TextField } from '@socle/ui';
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';

import { useMessages, useViewContext } from './context.js';
import type { FormEditState } from './form-view.js';
import { formatValue } from './format.js';
import { resolveText } from './text.js';
import { activityTypeName, threadCopy } from './thread-copy.js';
import type { ThreadMessage, ThreadPage } from './types.js';
import './thread-panel.css';

interface Props {
  readonly model: string;
  readonly id: string;
  readonly revision: number;
  readonly disabled: boolean;
  readonly onEditState: (value: FormEditState) => void;
}

/** Generic conversation on a declared chatter node; data and authorization are supplied outside. */
export function ThreadPanel({
  model,
  id,
  revision,
  disabled,
  onEditState,
}: Props): React.ReactElement | null {
  const view = useViewContext();
  const { thread } = view.data;
  const messages = useMessages();
  const copy = threadCopy(view.language);
  const [page, setPage] = useState<ThreadPage>();
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<'comment' | 'note'>('comment');
  const [summary, setSummary] = useState('');
  const [typeId, setTypeId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<'saved' | 'refreshFailed'>();
  const activeRef = useRef(false);
  const isActive = (): boolean => activeRef.current;
  const [instant, setInstant] = useState(() => new Date());
  const busyRef = useRef(false);
  const requestRef = useRef(0);
  const textId = useId();
  const dirty = body !== '' || summary !== '' || dueDate !== '' || typeId !== '' || feedback !== '';
  const notify = useEffectEvent(onEditState);
  useEffect(() => {
    notify({ dirty, saving: busy });
  }, [dirty, busy]);
  useEffect(
    () => () => {
      notify({ dirty: false, saving: false });
    },
    [],
  );
  useEffect(() => {
    const timer = setInterval(() => {
      setInstant(new Date());
    }, 60_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!thread) return;
    const version = ++requestRef.current;
    thread
      .read(model, id)
      .then((value) => {
        if (activeRef.current && requestRef.current === version) {
          setPage(value);
          setFailed(false);
        }
      })
      .catch(() => {
        if (activeRef.current && requestRef.current === version) setFailed(true);
      });
    return () => {
      requestRef.current += 1;
    };
  }, [thread, model, id, revision]);

  async function refresh(): Promise<void> {
    if (!thread) return;
    const version = ++requestRef.current;
    const value = await thread.read(model, id);
    if (activeRef.current && version === requestRef.current) {
      setPage(value);
      setFailed(false);
      setNotice(undefined);
    }
  }

  async function mutate(
    work: () => Promise<void>,
    accepted: () => void = () => undefined,
  ): Promise<void> {
    if (busyRef.current || disabled) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    setNotice(undefined);
    let committed = false;
    try {
      await work();
      committed = true;
      if (!isActive()) return;
      // Clear the accepted draft before the read; a failed refresh cannot invite a duplicate post.
      accepted();
      await refresh();
      if (isActive()) setNotice('saved');
    } catch {
      if (activeRef.current) {
        if (committed) setNotice('refreshFailed');
        else setFailed(true);
      }
    } finally {
      busyRef.current = false;
      if (activeRef.current) setBusy(false);
    }
  }

  async function older(): Promise<void> {
    if (!thread || !page?.before || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const version = ++requestRef.current;
    try {
      const previous = await thread.read(model, id, page.before);
      if (activeRef.current && version === requestRef.current)
        setPage((latest) =>
          latest
            ? {
                ...latest,
                before: previous.before,
                messages: [
                  ...previous.messages,
                  ...latest.messages.filter(
                    (item) => !previous.messages.some((old) => old.id === item.id),
                  ),
                ],
              }
            : previous,
        );
    } catch {
      if (activeRef.current && version === requestRef.current) setFailed(true);
    } finally {
      busyRef.current = false;
      if (activeRef.current) setBusy(false);
    }
  }

  if (!thread) return null;
  const blocked = busy || disabled;
  const canPost = page?.canPost === true;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: view.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const localDay = ['year', 'month', 'day']
    .map((part) => today.find((item) => item.type === part)?.value)
    .join('-');
  const dateFormat = new Intl.DateTimeFormat(view.language, {
    timeZone: view.timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <div className="ve-thread" aria-busy={busy}>
      {failed ? <p role="alert">{messages.saveError}</p> : null}
      {notice ? <p role="status">{copy[notice]}</p> : null}
      {failed || notice === 'refreshFailed' ? (
        <Button
          variant="secondary"
          disabled={blocked}
          onClick={() => {
            void refresh().catch(() => {
              if (activeRef.current) setFailed(true);
            });
          }}
        >
          {messages.retry}
        </Button>
      ) : null}
      {!page && !failed ? <Skeleton label={messages.loading} lines={3} /> : null}
      {page ? (
        <>
          <Card
            title={copy.title}
            actions={
              canPost ? (
                <Button
                  variant="ghost"
                  disabled={blocked}
                  onClick={() => {
                    void mutate(() => thread.follow(model, id, !page.following));
                  }}
                >
                  {page.following ? copy.unfollow : copy.follow}
                </Button>
              ) : undefined
            }
          >
            {page.following ? <p>{copy.following}</p> : null}
            {page.before ? (
              <Button
                variant="secondary"
                disabled={blocked}
                onClick={() => {
                  void older();
                }}
              >
                {copy.older}
              </Button>
            ) : null}
            {page.messages.length === 0 ? (
              <p>{copy.empty}</p>
            ) : (
              <ol className="ve-thread-messages">
                {page.messages.map((message) => (
                  <li key={message.id} className="ve-thread-message" data-kind={message.kind}>
                    <div className="ve-thread-meta">
                      <strong>
                        {message.kind === 'note'
                          ? copy.note
                          : message.kind === 'tracking'
                            ? copy.changed
                            : copy.message}
                      </strong>
                      <time dateTime={message.createdAt}>
                        {dateFormat.format(new Date(message.createdAt))}
                      </time>
                    </div>
                    {message.kind === 'tracking' ? (
                      <Tracking message={message} model={model} />
                    ) : (
                      <p className="ve-thread-text" dir="auto">
                        {message.body}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {canPost ? (
              <form
                className="ve-thread-compose"
                onSubmit={(event) => {
                  event.preventDefault();
                  void mutate(
                    () => thread.post(model, id, body, kind),
                    () => {
                      setBody('');
                    },
                  );
                }}
              >
                {page.internal ? (
                  <SelectField
                    label={copy.kind}
                    value={kind}
                    disabled={blocked}
                    options={[
                      { value: 'comment', label: copy.message },
                      { value: 'note', label: copy.note },
                    ]}
                    onChange={(event) => {
                      setKind(event.target.value === 'note' ? 'note' : 'comment');
                    }}
                  />
                ) : null}
                <div className="ui-control">
                  <label className="ui-label" htmlFor={textId}>
                    {kind === 'note' ? copy.note : copy.message}
                  </label>
                  <textarea
                    id={textId}
                    className="ui-input ve-thread-input"
                    value={body}
                    maxLength={10_000}
                    required
                    disabled={blocked}
                    dir="auto"
                    onChange={(event) => {
                      setBody(event.target.value);
                    }}
                  />
                </div>
                <Button type="submit" disabled={blocked || !body.trim()} loading={busy}>
                  {copy.send}
                </Button>
              </form>
            ) : null}
          </Card>
          <Card title={copy.activities}>
            {page.activities.length === 0 ? (
              <p>{copy.noActivities}</p>
            ) : (
              <ul className="ve-thread-activities">
                {page.activities.map((activity) => {
                  const status =
                    activity.dueDate < localDay
                      ? 'overdue'
                      : activity.dueDate === localDay
                        ? 'today'
                        : 'planned';
                  return (
                    <li key={activity.id}>
                      <div className="ve-thread-meta">
                        <strong dir="auto">{activity.summary}</strong>
                        <StatusPill
                          tone={
                            status === 'overdue'
                              ? 'danger'
                              : status === 'today'
                                ? 'warning'
                                : 'neutral'
                          }
                        >
                          {copy[status]}
                        </StatusPill>
                      </div>
                      <time dateTime={activity.dueDate}>
                        {new Intl.DateTimeFormat(view.language, {
                          timeZone: 'UTC',
                          dateStyle: 'medium',
                        }).format(new Date(`${activity.dueDate}T12:00:00Z`))}
                      </time>
                      {canPost ? (
                        <div className="ve-thread-actions">
                          <Button
                            size="sm"
                            disabled={blocked}
                            onClick={() => {
                              void mutate(
                                () => thread.finish(model, id, activity.id, 'done', feedback),
                                () => {
                                  setFeedback('');
                                },
                              );
                            }}
                          >
                            {copy.done}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={blocked}
                            onClick={() => {
                              void mutate(() =>
                                thread.finish(model, id, activity.id, 'cancelled', ''),
                              );
                            }}
                          >
                            {copy.cancel}
                          </Button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {canPost ? (
              <>
                {page.activities.length > 0 ? (
                  <TextField
                    label={copy.feedback}
                    value={feedback}
                    disabled={blocked}
                    maxLength={10_000}
                    onChange={(event) => {
                      setFeedback(event.target.value);
                    }}
                  />
                ) : null}
                <form
                  className="ve-thread-compose"
                  aria-label={copy.activity}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void mutate(
                      () => thread.schedule(model, id, { summary, typeId, dueDate }),
                      () => {
                        setSummary('');
                        setTypeId('');
                        setDueDate('');
                      },
                    );
                  }}
                >
                  <TextField
                    label={copy.summary}
                    value={summary}
                    required
                    maxLength={254}
                    disabled={blocked}
                    onChange={(event) => {
                      setSummary(event.target.value);
                    }}
                  />
                  <div className="ve-thread-fields">
                    <SelectField
                      label={copy.type}
                      value={typeId}
                      required
                      disabled={blocked}
                      placeholder={messages.choose}
                      options={page.types.map((type) => ({
                        value: type.id,
                        label: activityTypeName(type.code, type.name, view.language),
                      }))}
                      onChange={(event) => {
                        setTypeId(event.target.value);
                      }}
                    />
                    <TextField
                      type="date"
                      label={copy.due}
                      value={dueDate}
                      required
                      disabled={blocked}
                      onChange={(event) => {
                        setDueDate(event.target.value);
                      }}
                    />
                  </div>
                  <Button
                    type="submit"
                    disabled={blocked || !summary.trim() || !typeId || !dueDate}
                  >
                    {copy.schedule}
                  </Button>
                </form>
              </>
            ) : null}
          </Card>
        </>
      ) : null}
    </div>
  );
}

function Tracking({
  message,
  model,
}: {
  readonly message: ThreadMessage;
  readonly model: string;
}): React.ReactElement {
  const view = useViewContext();
  const messages = useMessages();
  const context = {
    language: view.language,
    timeZone: view.timeZone,
    yes: messages.yes,
    no: messages.no,
  };
  return (
    <dl className="ve-thread-changes">
      {Object.entries(message.changes ?? {}).map(([field, change]) => {
        const definition = view.registry.field(model, field);
        if (!definition || definition.sensitive) return null;
        return (
          <div key={field}>
            <dt>{resolveText(definition.label, view.language, field)}</dt>
            <dd>
              <span dir="auto">{formatValue(definition, change.before, context) || '—'}</span> →{' '}
              <span dir="auto">{formatValue(definition, change.after, context) || '—'}</span>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
