// SPDX-License-Identifier: LGPL-3.0-only
import type { LucideIcon } from 'lucide-react';

import './button.css';
import { Icon } from './icon.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface CommonProps extends Omit<
  React.ComponentPropsWithoutRef<'button'>,
  'type' | 'children' | 'aria-label'
> {
  /** `button` unless it submits a form. */
  readonly type?: 'button' | 'submit' | 'reset';
  readonly size?: 'md' | 'sm';
  /** The action is running: the button says so to assistive technologies and ignores clicks. */
  readonly loading?: boolean;
  readonly ref?: React.Ref<HTMLButtonElement>;
}

export interface ButtonProps extends CommonProps {
  readonly variant?: ButtonVariant;
  readonly children: React.ReactNode;
  /** An icon before the text. */
  readonly icon?: LucideIcon;
}

/** A pill-shaped button with a text. The main action of a screen is `primary` (the accent). */
export function Button({
  variant = 'secondary',
  size = 'md',
  type = 'button',
  loading = false,
  icon,
  children,
  disabled,
  onClick,
  ...rest
}: ButtonProps): React.ReactElement {
  return (
    <button
      {...rest}
      type={type}
      className="ui-button"
      data-variant={variant}
      data-size={size}
      data-loading={loading ? 'true' : undefined}
      aria-busy={loading ? 'true' : undefined}
      disabled={disabled}
      onClick={(event) => {
        if (loading) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      {icon ? <Icon icon={icon} /> : null}
      <span>{children}</span>
    </button>
  );
}

export interface IconButtonProps extends CommonProps {
  readonly icon: LucideIcon;
  /**
   * What the button does. Required: a button with an icon only has no other name, and this is what
   * screen readers read and what the tooltip shows.
   */
  readonly label: string;
  /** `accent`: the round quick-action button; `plain`: an icon in a quiet button. */
  readonly tone?: 'accent' | 'plain';
  /** Whether the icon is a direction (arrow, chevron) that turns in right-to-left languages. */
  readonly flip?: boolean;
}

/** A round button with an icon only (call, message, print…). Its name is mandatory. */
export function IconButton({
  icon,
  label,
  tone = 'accent',
  flip = false,
  size = 'md',
  type = 'button',
  loading = false,
  disabled,
  onClick,
  ...rest
}: IconButtonProps): React.ReactElement {
  return (
    <button
      {...rest}
      type={type}
      className="ui-button"
      data-variant={tone === 'accent' ? 'primary' : 'ghost'}
      data-shape="round"
      data-size={size}
      data-loading={loading ? 'true' : undefined}
      aria-busy={loading ? 'true' : undefined}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(event) => {
        if (loading) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      <Icon icon={icon} flip={flip} />
    </button>
  );
}
