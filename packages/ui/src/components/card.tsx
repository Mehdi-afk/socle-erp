// SPDX-License-Identifier: LGPL-3.0-only
import { useId } from 'react';

import './card.css';

export interface CardProps {
  /** The heading of the card. Without a title the card is a plain container. */
  readonly title?: React.ReactNode;
  /** The level of the title in the page outline (default `h2`). */
  readonly titleLevel?: 'h2' | 'h3' | 'h4';
  /** Buttons and menus at the end of the header (edit, add…). */
  readonly actions?: React.ReactNode;
  /** `accent`: the soft accent background of the "confidential data" card. */
  readonly tone?: 'default' | 'accent';
  readonly children: React.ReactNode;
}

/** A white, generously rounded card: the container of every group of data. */
export function Card({
  title,
  titleLevel = 'h2',
  actions,
  tone = 'default',
  children,
}: CardProps): React.ReactElement {
  const titleId = useId();
  const Heading = titleLevel;
  return (
    <section
      className="ui-card"
      data-tone={tone === 'accent' ? 'accent' : undefined}
      aria-labelledby={title === undefined ? undefined : titleId}
    >
      {title === undefined && actions === undefined ? null : (
        <header className="ui-card-header">
          {title === undefined ? null : (
            <Heading id={titleId} className="ui-card-title">
              {title}
            </Heading>
          )}
          {actions === undefined ? null : <div className="ui-card-actions">{actions}</div>}
        </header>
      )}
      <div className="ui-card-body">{children}</div>
    </section>
  );
}

export interface FieldListProps {
  readonly children: React.ReactNode;
}

/** The label/value pairs of a card, separated by hairlines (a description list). */
export function FieldList({ children }: FieldListProps): React.ReactElement {
  return <dl className="ui-fields">{children}</dl>;
}

export interface FieldItemProps {
  readonly label: React.ReactNode;
  /** The value; nothing (or an empty string) shows the "not set" mark. */
  readonly children?: React.ReactNode;
  /** Text read by assistive technologies for an empty value (default "Not set"). */
  readonly emptyLabel?: string;
}

const isEmpty = (value: React.ReactNode): boolean =>
  value === undefined || value === null || value === false || value === '';

/** One label and its value. */
export function FieldItem({
  label,
  children,
  emptyLabel = 'Not set',
}: FieldItemProps): React.ReactElement {
  return (
    <div className="ui-field">
      <dt className="ui-field-label">{label}</dt>
      <dd className="ui-field-value">
        {isEmpty(children) ? (
          <>
            <span aria-hidden="true">—</span>
            <span className="ui-sr-only">{emptyLabel}</span>
          </>
        ) : (
          children
        )}
      </dd>
    </div>
  );
}
