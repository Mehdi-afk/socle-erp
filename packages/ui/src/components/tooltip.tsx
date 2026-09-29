// SPDX-License-Identifier: LGPL-3.0-only
import { useDirection } from '@radix-ui/react-direction';
import * as RadixTooltip from '@radix-ui/react-tooltip';

import './overlays.css';

export interface TooltipProps {
  /** The text shown on hover **and** on keyboard focus. */
  readonly content: React.ReactNode;
  /** The element that has it: one focusable element (a button, a link). */
  readonly children: React.ReactElement;
  readonly side?: 'top' | 'bottom' | 'start' | 'end';
}

/**
 * A short explanation next to an element. It complements the element's own name, it never
 * replaces it: essential information does not live in a tooltip. Must be inside a `UiProvider`.
 */
export function Tooltip({ content, children, side = 'top' }: TooltipProps): React.ReactElement {
  // `start` and `end` follow the reading direction.
  const rtl = useDirection() === 'rtl';
  const placement =
    side === 'start' ? (rtl ? 'right' : 'left') : side === 'end' ? (rtl ? 'left' : 'right') : side;
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className="ui-tooltip" side={placement} sideOffset={6}>
          {content}
          <RadixTooltip.Arrow className="ui-tooltip-arrow" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
