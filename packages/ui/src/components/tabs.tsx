// SPDX-License-Identifier: LGPL-3.0-only
import * as RadixTabs from '@radix-ui/react-tabs';

import './tabs.css';

export interface TabItem {
  readonly id: string;
  readonly label: React.ReactNode;
  readonly content: React.ReactNode;
  readonly disabled?: boolean;
}

export interface TabsProps {
  readonly items: readonly TabItem[];
  /** What the set of tabs is about ("Contact sections"): the tab list is named. */
  readonly label: string;
  /** The selected tab, when the parent controls it. */
  readonly value?: string;
  /** The tab shown first when uncontrolled (default: the first). */
  readonly defaultValue?: string;
  readonly onValueChange?: (id: string) => void;
}

/**
 * Tabs: arrow keys move between them (and follow the reading direction), Home and End go to the
 * first and last, the panel is reachable from its tab. The list scrolls when it overflows.
 */
export function Tabs({
  items,
  label,
  value,
  defaultValue,
  onValueChange,
}: TabsProps): React.ReactElement {
  const initial = defaultValue ?? items.find((item) => item.disabled !== true)?.id;
  const controlled = value === undefined ? {} : { value };
  return (
    <RadixTabs.Root
      className="ui-tabs"
      {...(initial === undefined ? {} : { defaultValue: initial })}
      {...controlled}
      {...(onValueChange ? { onValueChange } : {})}
    >
      <RadixTabs.List className="ui-tab-list" aria-label={label}>
        {items.map((item) => (
          <RadixTabs.Trigger
            key={item.id}
            className="ui-tab"
            value={item.id}
            disabled={item.disabled ?? false}
          >
            {item.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {items.map((item) => (
        <RadixTabs.Content key={item.id} className="ui-tab-panel" value={item.id}>
          {item.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}
