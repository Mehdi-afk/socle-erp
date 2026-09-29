// SPDX-License-Identifier: LGPL-3.0-only
import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal, type LucideIcon } from 'lucide-react';

import { IconButton } from './button.js';
import { Icon } from './icon.js';
import './overlays.css';

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: LucideIcon;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  /** `danger` for a destructive action (delete). */
  readonly tone?: 'danger';
}

/** A menu entry: an action, or a separator between groups of actions. */
export type MenuEntry = MenuItem | 'separator';

export interface ActionMenuProps {
  /** What the menu is ("More actions"): the name of its button. */
  readonly label: string;
  readonly items: readonly MenuEntry[];
  /** The icon of the button (default: "…"). */
  readonly icon?: LucideIcon;
}

/**
 * The "…" menu: a button that opens a list of actions. Opens with Enter, Space or the arrow keys,
 * moves with the arrows, closes with Escape and gives the focus back to its button.
 */
export function ActionMenu({
  label,
  items,
  icon = MoreHorizontal,
}: ActionMenuProps): React.ReactElement {
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild>
        <IconButton icon={icon} label={label} tone="plain" />
      </RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content className="ui-menu" align="end" sideOffset={6}>
          {items.map((entry, index) =>
            entry === 'separator' ? (
              // Separators have no identity of their own.
              <RadixMenu.Separator
                key={`separator-${String(index)}`}
                className="ui-menu-separator"
              />
            ) : (
              <RadixMenu.Item
                key={entry.id}
                className="ui-menu-item"
                data-tone={entry.tone}
                disabled={entry.disabled ?? false}
                onSelect={entry.onSelect}
              >
                {entry.icon ? <Icon icon={entry.icon} /> : null}
                {entry.label}
              </RadixMenu.Item>
            ),
          )}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}
