// SPDX-License-Identifier: LGPL-3.0-only
//
// The `form` view of any model, in reading mode: a header (avatar, title, subtitle, quick actions),
// cards of label/value pairs, notebook pages as tabs, embedded lists for one2many fields, and, always
// last, the card of confidential data whose values stay masked until the user asks for them one by
// one (the request is the caller's `onReveal`, which the server records in the audit trail).
import type { ViewNode } from '@socle/framework';
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  FieldItem,
  FieldList,
  IconButton,
  Skeleton,
  Tabs,
} from '@socle/ui';
import { Eye, EyeOff, FileQuestion, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { useMessages, useViewContext } from './context.js';
import { FieldValue } from './field-value.js';
import {
  layoutOf,
  type FormBlock,
  type FormField,
  type FormLayout,
  type FormRelation,
} from './form-model.js';
import './form-view.css';
import { ListView } from './list-view.js';
import { useLookups, type Lookups } from './lookups.js';
import type { RecordValues } from './types.js';

export interface FormViewProps {
  /** The `form` node of the view (after the user's rights are applied). */
  readonly arch: ViewNode;
  readonly model: string;
  readonly id: string;
  /** A quick action of the header was chosen. */
  readonly onAction?: ((method: string, id: string) => void) | undefined;
  /** Asks for the real value of a confidential field (recorded by the server). */
  readonly onReveal?: ((field: string, id: string) => Promise<string>) | undefined;
  /** An embedded record was chosen. */
  readonly onOpenRelated?: ((model: string, id: string) => void) | undefined;
  /** Extra controls at the end of the header (the "Edit" button, for instance). */
  readonly toolbar?: React.ReactNode;
}

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'missing' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly record: RecordValues };

/** Reads the record, then draws it. Changing `id` starts again from a clean state. */
export function FormView(props: FormViewProps): React.ReactElement {
  return <FormRecord key={`${props.model}:${props.id}`} {...props} />;
}

function FormRecord({
  arch,
  model,
  id,
  onAction,
  onReveal,
  onOpenRelated,
  toolbar,
}: FormViewProps): React.ReactElement {
  const view = useViewContext();
  const messages = useMessages();
  const meta = view.registry.get(model);
  const layout = useMemo(() => layoutOf(arch, meta, view.language), [arch, meta, view.language]);
  const lookups = useLookups(view);
  const { ensure } = lookups;
  const [state, setState] = useState<State>({ status: 'loading' });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let current = true;
    view.data
      .read(model, [id], layout.fields)
      .then(async ([record]) => {
        if (!current) return;
        if (!record) {
          setState({ status: 'missing' });
          return;
        }
        setState({ status: 'ready', record });
        await ensure(model, [record], layout.fields);
      })
      .catch(() => {
        if (current) setState({ status: 'failed' });
      });
    return () => {
      current = false;
    };
  }, [view.data, model, id, layout, ensure, retry]);

  if (state.status === 'loading') {
    return (
      <div className="ve-form">
        <Skeleton lines={6} label={messages.loading} />
      </div>
    );
  }
  if (state.status === 'missing') {
    return (
      <EmptyState icon={FileQuestion} title={messages.emptyTitle}>
        {messages.notFound}
      </EmptyState>
    );
  }
  if (state.status === 'failed') {
    return (
      <div className="ve-form" role="alert">
        <p>{messages.loadError}</p>
        <Button
          variant="secondary"
          onClick={() => {
            setState({ status: 'loading' });
            setRetry((count) => count + 1);
          }}
        >
          {messages.retry}
        </Button>
      </div>
    );
  }

  return (
    <div className="ve-form">
      <FormHeader
        layout={layout}
        record={state.record}
        onAction={
          onAction &&
          ((method) => {
            onAction(method, id);
          })
        }
        toolbar={toolbar}
      />
      <Blocks
        blocks={layout.blocks}
        record={state.record}
        model={model}
        id={id}
        lookups={lookups}
        onOpenRelated={onOpenRelated}
      />
      {layout.confidential.length > 0 ? (
        <Confidential
          fields={layout.confidential}
          record={state.record}
          id={id}
          onReveal={onReveal}
        />
      ) : null}
    </div>
  );
}

const textOf = (record: RecordValues, field: FormField | undefined): string => {
  const value = field ? record[field.name] : undefined;
  return typeof value === 'string' ? value : '';
};

function FormHeader({
  layout,
  record,
  onAction,
  toolbar,
}: {
  readonly layout: FormLayout;
  readonly record: RecordValues;
  readonly onAction: ((method: string) => void) | undefined;
  readonly toolbar: React.ReactNode;
}): React.ReactElement | null {
  const { title, subtitle, avatar, actions } = layout.header;
  const name = textOf(record, title);
  if (!title && !subtitle && actions.length === 0 && toolbar === undefined) return null;
  return (
    <header className="ve-form-header">
      {avatar || title ? <Avatar name={name || textOf(record, avatar)} size="lg" /> : null}
      <div className="ve-form-heading">
        {title ? <h1 className="ve-form-title">{name}</h1> : null}
        {subtitle ? <p className="ve-form-subtitle">{textOf(record, subtitle)}</p> : null}
      </div>
      <div className="ve-form-actions">
        {actions.map((action) => (
          <Button
            key={action.method}
            variant={action.primary ? 'primary' : 'secondary'}
            onClick={() => {
              onAction?.(action.method);
            }}
          >
            {action.label}
          </Button>
        ))}
        {toolbar}
      </div>
    </header>
  );
}

interface BlocksProps {
  readonly blocks: readonly FormBlock[];
  readonly record: RecordValues;
  readonly model: string;
  readonly id: string;
  readonly lookups: Lookups;
  readonly onOpenRelated: ((model: string, id: string) => void) | undefined;
}

function Blocks({ blocks, ...rest }: BlocksProps): React.ReactElement {
  const messages = useMessages();
  return (
    <>
      {blocks.map((block, index) => {
        const key = `${block.kind}-${String(index)}`;
        switch (block.kind) {
          case 'card':
            return (
              <Card key={key} {...(block.title === undefined ? {} : { title: block.title })}>
                <FieldsList
                  fields={block.fields}
                  record={rest.record}
                  model={rest.model}
                  lookups={rest.lookups}
                />
              </Card>
            );
          case 'relation':
            return (
              <Card key={key} title={block.title}>
                <Embedded relation={block.relation} id={rest.id} onOpen={rest.onOpenRelated} />
              </Card>
            );
          case 'columns':
            return (
              <div key={key} className="ve-form-columns">
                <Blocks blocks={block.blocks} {...rest} />
              </div>
            );
          case 'tabs':
            return (
              <Tabs
                key={key}
                label={messages.sections}
                items={block.pages.map((page) => ({
                  id: page.id,
                  label: page.label,
                  content: (
                    <div className="ve-form-page">
                      <Blocks blocks={page.blocks} {...rest} />
                    </div>
                  ),
                }))}
              />
            );
        }
      })}
    </>
  );
}

function FieldsList({
  fields,
  record,
  model,
  lookups,
}: {
  readonly fields: readonly FormField[];
  readonly record: RecordValues;
  readonly model: string;
  readonly lookups: Lookups;
}): React.ReactElement {
  const view = useViewContext();
  const messages = useMessages();
  const meta = view.registry.get(model);
  return (
    <FieldList>
      {fields.map((field) => (
        <FieldItem key={field.name} label={field.label} emptyLabel={messages.notSet}>
          <span data-type={field.definition.type} className="ve-form-value">
            <FieldValue
              definition={field.definition}
              value={record[field.name]}
              widget={field.widget}
              tones={field.tones}
              displayName={
                field.definition.comodel === undefined
                  ? undefined
                  : lookups.nameOf(field.definition.comodel, record[field.name])
              }
              currency={
                field.definition.type === 'monetary'
                  ? lookups.currencyOf(
                      record[meta.fields.get(field.name)?.currencyField ?? 'currencyId'],
                    )
                  : undefined
              }
              record={record}
            />
          </span>
        </FieldItem>
      ))}
    </FieldList>
  );
}

function Embedded({
  relation,
  id,
  onOpen,
}: {
  readonly relation: FormRelation;
  readonly id: string;
  readonly onOpen: ((model: string, id: string) => void) | undefined;
}): React.ReactElement {
  return (
    <div className="ve-form-embedded">
      <ListView
        arch={relation.arch}
        model={relation.comodel}
        label={relation.field.label}
        domain={[[relation.inverse, '=', id]]}
        onOpen={
          onOpen &&
          ((related) => {
            onOpen(relation.comodel, related);
          })
        }
      />
    </div>
  );
}

const MASK = '••••••••';

function Confidential({
  fields,
  record,
  id,
  onReveal,
}: {
  readonly fields: readonly FormField[];
  readonly record: RecordValues;
  readonly id: string;
  readonly onReveal: ((field: string, id: string) => Promise<string>) | undefined;
}): React.ReactElement {
  const messages = useMessages();
  const [revealed, setRevealed] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());

  const show = (name: string): void => {
    if (!onReveal) return;
    onReveal(name, id)
      .then((value) => {
        setFailed((previous) => new Set([...previous].filter((other) => other !== name)));
        setRevealed((previous) => new Map(previous).set(name, value));
      })
      .catch(() => {
        setFailed((previous) => new Set(previous).add(name));
      });
  };
  const hide = (name: string): void => {
    setRevealed((previous) => {
      const next = new Map(previous);
      next.delete(name);
      return next;
    });
  };

  return (
    <Card
      title={messages.confidentialTitle}
      tone="accent"
      actions={<ShieldCheck aria-hidden="true" />}
    >
      <FieldList>
        {fields.map((field) => {
          const empty =
            record[field.name] === null ||
            record[field.name] === undefined ||
            record[field.name] === '';
          const value = revealed.get(field.name);
          return (
            <FieldItem key={field.name} label={field.label} emptyLabel={messages.notSet}>
              {empty ? null : (
                <span className="ve-secret">
                  {value === undefined ? (
                    <>
                      <span aria-hidden="true">{MASK}</span>
                      <span className="ui-sr-only">{messages.masked}</span>
                    </>
                  ) : (
                    <bdi dir="ltr">{value}</bdi>
                  )}
                  {onReveal ? (
                    <IconButton
                      icon={value === undefined ? Eye : EyeOff}
                      label={
                        value === undefined
                          ? messages.reveal(field.label)
                          : messages.hide(field.label)
                      }
                      onClick={() => {
                        if (value === undefined) show(field.name);
                        else hide(field.name);
                      }}
                    />
                  ) : null}
                  {failed.has(field.name) ? (
                    <span role="alert" className="ve-secret-error">
                      {messages.revealError}
                    </span>
                  ) : null}
                </span>
              )}
            </FieldItem>
          );
        })}
      </FieldList>
    </Card>
  );
}
