// SPDX-License-Identifier: LGPL-3.0-only
import { formatCount } from '../theme.js';

import './badge.css';

export interface BadgeProps {
  readonly count: number;
  /** Above this the badge shows `max+` (default 99). */
  readonly max?: number;
  /** What the count is ("unread notifications"), read after the number. */
  readonly label?: string;
  /** `accent`: on the accent, to draw the eye; `neutral`: quiet. */
  readonly tone?: 'accent' | 'neutral';
}

/** A counter in a pill. */
export function Badge({ count, max = 99, label, tone = 'accent' }: BadgeProps): React.ReactElement {
  return (
    <span className="ui-badge" data-tone={tone}>
      <span aria-hidden={label === undefined ? undefined : 'true'}>{formatCount(count, max)}</span>
      {label === undefined ? null : (
        <span className="ui-sr-only">{`${String(count)} ${label}`}</span>
      )}
    </span>
  );
}

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface StatusPillProps {
  readonly tone: StatusTone;
  /** The state, in words. It is required: a colour alone is never enough. */
  readonly children: React.ReactNode;
}

/** A state shown as a coloured dot **and** its label. */
export function StatusPill({ tone, children }: StatusPillProps): React.ReactElement {
  return (
    <span className="ui-pill" data-tone={tone}>
      <span className="ui-pill-dot" aria-hidden="true" />
      {children}
    </span>
  );
}
