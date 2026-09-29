// SPDX-License-Identifier: LGPL-3.0-only
import { categoryOf, formatCount, initialsOf } from '../theme.js';

import './avatar.css';

export interface AvatarProps {
  /** The person's name: read by assistive technologies, and the source of the initials. */
  readonly name: string;
  /** A photo; without it, the initials on a pastel colour. */
  readonly src?: string | undefined;
  readonly size?: 'sm' | 'md' | 'lg';
}

/** A round avatar. Its colour tells people apart (it never carries a meaning). */
export function Avatar({ name, src, size = 'md' }: AvatarProps): React.ReactElement {
  return (
    <span
      className="ui-avatar"
      role="img"
      aria-label={name}
      data-size={size}
      data-category={src === undefined ? String(categoryOf(name)) : undefined}
    >
      {src === undefined ? (
        <span aria-hidden="true">{initialsOf(name)}</span>
      ) : (
        <img className="ui-avatar-image" src={src} alt="" />
      )}
    </span>
  );
}

export interface AvatarStackProps {
  readonly people: readonly { readonly name: string; readonly src?: string | undefined }[];
  /** Avatars shown before the "+N" chip (default 3). */
  readonly max?: number;
  /** What the group is ("Participants"). */
  readonly label: string;
  readonly size?: 'sm' | 'md';
}

/** Overlapping avatars, with a "+N" chip that lists the others. */
export function AvatarStack({
  people,
  max = 3,
  label,
  size = 'sm',
}: AvatarStackProps): React.ReactElement {
  const shown = people.slice(0, max);
  const hidden = people.slice(max);
  return (
    <ul className="ui-avatar-stack" aria-label={label}>
      {shown.map((person) => (
        <li key={person.name}>
          <Avatar name={person.name} src={person.src} size={size} />
        </li>
      ))}
      {hidden.length === 0 ? null : (
        <li>
          <span
            className="ui-avatar ui-avatar-more"
            role="img"
            data-size={size}
            aria-label={`${formatCount(hidden.length)}: ${hidden.map((p) => p.name).join(', ')}`}
            title={hidden.map((p) => p.name).join(', ')}
          >
            <span aria-hidden="true">+{formatCount(hidden.length)}</span>
          </span>
        </li>
      )}
    </ul>
  );
}
