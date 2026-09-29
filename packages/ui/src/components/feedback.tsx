// SPDX-License-Identifier: LGPL-3.0-only
import type { LucideIcon } from 'lucide-react';

import './feedback.css';
import { Icon } from './icon.js';

export interface EmptyStateProps {
  readonly icon?: LucideIcon;
  /** What is missing ("No contact yet"). */
  readonly title: string;
  /** What to do about it. */
  readonly children?: React.ReactNode;
  /** The button that fixes it ("Add a contact"). */
  readonly action?: React.ReactNode;
}

/** What a list or a card shows when there is nothing to show yet. */
export function EmptyState({ icon, title, children, action }: EmptyStateProps): React.ReactElement {
  return (
    <div className="ui-empty">
      {icon ? (
        <div className="ui-empty-icon">
          <Icon icon={icon} size={28} />
        </div>
      ) : null}
      <p className="ui-empty-title">{title}</p>
      {children === undefined ? null : <p className="ui-empty-text">{children}</p>}
      {action === undefined ? null : <div className="ui-empty-action">{action}</div>}
    </div>
  );
}

export interface SkeletonProps {
  /** Number of placeholder lines (default 3). */
  readonly lines?: number;
  /** Announced to assistive technologies while it is displayed (default "Loading"). */
  readonly label?: string;
}

/** Grey bars where content is coming: the page keeps its shape while it loads. */
export function Skeleton({ lines = 3, label = 'Loading' }: SkeletonProps): React.ReactElement {
  return (
    <div className="ui-skeleton" role="status" aria-live="polite">
      <span className="ui-sr-only">{label}</span>
      {Array.from({ length: lines }, (_, index) => (
        // The bars are identical and never reorder.
        <span key={index} className="ui-skeleton-line" aria-hidden="true" />
      ))}
    </div>
  );
}
