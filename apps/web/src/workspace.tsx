// SPDX-License-Identifier: LGPL-3.0-only
import * as Dialog from '@radix-ui/react-dialog';
import { Button, EmptyState, SelectField, type Preferences } from '@socle/ui';
import { FormView, ListView, ViewEngineProvider, type FormEditState } from '@socle/view-engine';
import { ArrowLeft, ChevronRight, Database, LogOut } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Brand, authMessage } from './app.js';
import { copyFor } from './copy.js';
import { backTo, catalogEntries, navigate, routeView, type WebRoute } from './navigation.js';
import { PreferenceControls } from './preferences.js';
import type { WebClient } from './rpc-data-source.js';
import { watchSession } from './session-data.js';

export default function Workspace({
  client,
  preferences,
  onPreferences,
  onExpired,
  onLogout,
}: {
  readonly client: WebClient;
  readonly preferences: Preferences;
  readonly onPreferences: (value: Preferences) => void;
  readonly onExpired: () => void;
  readonly onLogout: () => Promise<void>;
}): React.ReactElement {
  const copy = copyFor(preferences.language);
  const entries = useMemo(
    () => catalogEntries(client, preferences.language),
    [client, preferences.language],
  );
  const [stack, setStack] = useState<readonly WebRoute[]>(() =>
    entries[0] === undefined ? [] : [{ model: entries[0].model }],
  );
  const [editing, setEditing] = useState<FormEditState>({ dirty: false, saving: false });
  const [pending, setPending] = useState<(() => void) | undefined>();
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState<unknown>();
  const mainRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | undefined>(undefined);
  const mountedRef = useRef(false);
  const data = useMemo(() => watchSession(client.data, onExpired), [client, onExpired]);
  const context = useMemo(
    () => ({
      registry: client.registry,
      data,
      language: preferences.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      density: preferences.density,
    }),
    [client.registry, data, preferences.language, preferences.density],
  );
  const route = stack.at(-1);
  const entry = entries.find((item) => item.model === route?.model);
  const view = route === undefined ? undefined : routeView(entries, route);
  const blocked = editing.saving || loggingOut;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
  }, [route?.model, route?.id]);
  useEffect(() => {
    document.title = `${entry?.label ?? copy.home} — Socle ERP`;
  }, [entry?.label, copy.home]);

  useEffect(() => {
    if (!editing.dirty && !editing.saving) return;
    const prevent = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', prevent);
    return () => {
      window.removeEventListener('beforeunload', prevent);
    };
  }, [editing.dirty, editing.saving]);

  function guard(action: () => void): void {
    if (blocked) return;
    if (editing.dirty) {
      restoreFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      setPending(() => action);
    } else action();
  }
  function go(destination: WebRoute): void {
    if (routeView(entries, destination) === undefined) return;
    const next = navigate(stack, destination);
    if (next === stack) return;
    guard(() => {
      setStack(next);
      setError(undefined);
    });
  }
  function back(index: number): void {
    const next = backTo(stack, index);
    if (next !== stack)
      guard(() => {
        setStack(next);
        setError(undefined);
      });
  }
  const reportEdit = useCallback((value: FormEditState) => {
    setEditing(value);
  }, []);
  async function logout(): Promise<void> {
    setLoggingOut(true);
    setError(undefined);
    try {
      await onLogout();
    } catch (failure) {
      if (mountedRef.current) {
        setError(failure);
        setLoggingOut(false);
      }
    }
  }

  return (
    <div className="web-workspace">
      <aside className="web-sidebar">
        <Brand />
        <nav aria-label={copy.data} className="web-model-nav">
          <h2>{copy.data}</h2>
          {entries.map((item) => (
            <button
              type="button"
              key={item.model}
              aria-current={item.model === route?.model ? 'page' : undefined}
              disabled={blocked}
              onClick={() => {
                go({ model: item.model });
              }}
            >
              <Database size={18} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <Button
          icon={LogOut}
          variant="ghost"
          disabled={blocked}
          loading={loggingOut}
          onClick={() => {
            guard(() => {
              void logout();
            });
          }}
        >
          {copy.logout}
        </Button>
      </aside>
      <div className="web-workspace-body">
        <header className="web-workspace-header">
          <nav aria-label={copy.home} className="web-breadcrumbs">
            <span>{copy.home}</span>
            {stack.map((item, index) => (
              <span className="web-crumb" key={`${String(index)}:${item.model}:${item.id ?? ''}`}>
                <ChevronRight size={14} aria-hidden="true" />
                {index === stack.length - 1 ? (
                  <span aria-current="page">
                    {entries.find((candidate) => candidate.model === item.model)?.label}
                    {item.id === undefined ? '' : ` · ${copy.record}`}
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={blocked}
                    onClick={() => {
                      back(index);
                    }}
                  >
                    {entries.find((candidate) => candidate.model === item.model)?.label}
                    {item.id === undefined ? '' : ` · ${copy.record}`}
                  </button>
                )}
              </span>
            ))}
          </nav>
          <PreferenceControls value={preferences} onChange={onPreferences} />
        </header>
        <div className="web-mobile-navigation">
          <SelectField
            label={copy.view}
            value={route?.model ?? ''}
            options={entries.map((item) => ({ value: item.model, label: item.label }))}
            disabled={blocked}
            onChange={(event) => {
              go({ model: event.target.value });
            }}
          />
          <Button
            icon={LogOut}
            disabled={blocked}
            onClick={() => {
              guard(() => {
                void logout();
              });
            }}
          >
            {copy.logout}
          </Button>
        </div>
        <main className="web-workspace-main" ref={mainRef} tabIndex={-1} inert={loggingOut}>
          {error === undefined ? null : (
            <p className="web-error" role="alert">
              {authMessage(error, preferences.language)}
            </p>
          )}
          {entry === undefined || view === undefined || route === undefined ? (
            <EmptyState title={copy.noViews}>{copy.noViewsHint}</EmptyState>
          ) : (
            <ViewEngineProvider context={context}>
              {route.id === undefined ? (
                <>
                  <h1 className="web-list-title">{entry.label}</h1>
                  <ListView
                    key={route.model}
                    arch={view.arch}
                    model={route.model}
                    label={entry.label}
                    defaultOrder={client.registry
                      .get(route.model)
                      .order.map(
                        (term) => `${term.field}${term.direction === 'desc' ? ' desc' : ''}`,
                      )
                      .join(', ')}
                    {...(entry.form === undefined
                      ? {}
                      : {
                          onOpen: (id: string) => {
                            go({ model: route.model, id });
                          },
                        })}
                  />
                </>
              ) : (
                <>
                  <h1 className="ui-sr-only">
                    {entry.label} · {copy.record}
                  </h1>
                  <Button
                    icon={ArrowLeft}
                    size="sm"
                    disabled={blocked}
                    onClick={() => {
                      const previous = stack.length - 2;
                      if (previous >= 0) back(previous);
                      else go({ model: route.model });
                    }}
                  >
                    {copy.back}
                  </Button>
                  <FormView
                    key={`${route.model}:${route.id}`}
                    arch={view.arch}
                    model={route.model}
                    id={route.id}
                    onEditStateChange={reportEdit}
                    onOpenRelated={(model, id) => {
                      go({ model, id });
                    }}
                  />
                </>
              )}
            </ViewEngineProvider>
          )}
        </main>
      </div>
      <Dialog.Root
        open={pending !== undefined}
        onOpenChange={(open) => {
          if (!open) setPending(undefined);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="web-dialog-overlay" />
          <Dialog.Content
            className="web-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
              else mainRef.current?.focus({ preventScroll: true });
              restoreFocusRef.current = undefined;
            }}
          >
            <Dialog.Title>{copy.dirty}</Dialog.Title>
            <Dialog.Description>{copy.dirtyHint}</Dialog.Description>
            <div className="web-dialog-actions">
              <Dialog.Close asChild>
                <Button>{copy.stay}</Button>
              </Dialog.Close>
              <Button
                variant="danger"
                onClick={() => {
                  const action = pending;
                  restoreFocusRef.current = undefined;
                  setPending(undefined);
                  action?.();
                }}
              >
                {copy.discard}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
