// SPDX-License-Identifier: LGPL-3.0-only
import type { FieldDefinition } from '@socle/framework';
import { Avatar, StatusPill, type StatusTone } from '@socle/ui';

import { useMessages, useViewContext } from './context.js';
import { formatValue, type Currency } from './format.js';
import { emailHref, phoneHref, webHref } from './links.js';
import type { RecordValues } from './types.js';

export type Widget = 'phone' | 'email' | 'url' | 'status_badge' | 'avatar';

const TONES: ReadonlySet<string> = new Set(['success', 'warning', 'danger', 'info', 'neutral']);

export interface FieldValueProps {
  readonly definition: FieldDefinition;
  readonly value: unknown;
  /** How the view asks the value to be shown (`widget` attribute of the field node). */
  readonly widget?: string | undefined;
  /** For `status_badge`: the tone of each value (`{ done: 'success' }`). */
  readonly tones?: Readonly<Record<string, unknown>> | undefined;
  /** The name of the related record, for a many2one. */
  readonly displayName?: string | undefined;
  readonly currency?: Currency | undefined;
  /** The record, for the avatar of a person. */
  readonly record?: RecordValues | undefined;
}

/**
 * One value of one field, shown the way its type and its widget ask. Phone numbers, email and web
 * addresses become links only when they have a safe shape; states are a coloured dot **and** their
 * label; an empty value is a dash that assistive technologies read as "Not set".
 */
export function FieldValue({
  definition,
  value,
  widget,
  tones,
  displayName,
  currency,
}: FieldValueProps): React.ReactElement {
  const view = useViewContext();
  const messages = useMessages();
  const text = formatValue(
    definition,
    value,
    { language: view.language, timeZone: view.timeZone, yes: messages.yes, no: messages.no },
    { displayName, currency },
  );

  if (text === '') {
    return (
      <>
        <span aria-hidden="true">—</span>
        <span className="ui-sr-only">{messages.notSet}</span>
      </>
    );
  }

  if (widget === 'status_badge' && definition.type === 'selection') {
    const tone = typeof value === 'string' ? tones?.[value] : undefined;
    return (
      <StatusPill
        tone={(typeof tone === 'string' && TONES.has(tone) ? tone : 'neutral') as StatusTone}
      >
        {text}
      </StatusPill>
    );
  }

  if (widget === 'avatar') {
    return (
      <span className="ve-person">
        <Avatar name={text} size="sm" />
        <span>{text}</span>
      </span>
    );
  }

  if (widget === 'phone') {
    const href = phoneHref(text);
    return <bdi dir="ltr">{href === undefined ? text : <a href={href}>{text}</a>}</bdi>;
  }
  if (widget === 'email') {
    const href = emailHref(text);
    return <bdi dir="ltr">{href === undefined ? text : <a href={href}>{text}</a>}</bdi>;
  }
  if (widget === 'url') {
    const href = webHref(text);
    return (
      <bdi dir="ltr">
        {href === undefined ? (
          text
        ) : (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {text}
          </a>
        )}
      </bdi>
    );
  }

  return <>{text}</>;
}
