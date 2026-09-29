// SPDX-License-Identifier: LGPL-3.0-only
import { DirectionProvider } from '@radix-ui/react-direction';
import * as RadixTooltip from '@radix-ui/react-tooltip';

export interface UiProviderProps {
  /** The reading direction of the page: keyboard arrows and pop-ups follow it. */
  readonly dir?: 'ltr' | 'rtl';
  readonly children: React.ReactNode;
}

/**
 * Wraps the application once: it tells the interactive components which way the page reads (arrow
 * keys in tabs and menus swap in right-to-left languages) and shares the tooltip timing.
 */
export function UiProvider({ dir = 'ltr', children }: UiProviderProps): React.ReactElement {
  return (
    <DirectionProvider dir={dir}>
      <RadixTooltip.Provider delayDuration={400} skipDelayDuration={200}>
        {children}
      </RadixTooltip.Provider>
    </DirectionProvider>
  );
}
