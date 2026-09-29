// SPDX-License-Identifier: LGPL-3.0-only
import type { LucideIcon } from 'lucide-react';

export interface IconProps {
  /** A Lucide icon component, e.g. `Phone`. */
  readonly icon: LucideIcon;
  /** Size in pixels (default 18). */
  readonly size?: number;
  /**
   * Turn the icon in right-to-left languages: for arrows and chevrons that point in a direction.
   * Other icons keep their orientation.
   */
  readonly flip?: boolean;
}

/**
 * A thin-stroke icon (Lucide). It is decorative: the text or the accessible name of its
 * surroundings says what it means, so it is hidden from assistive technologies.
 */
export function Icon({ icon: Glyph, size = 18, flip = false }: IconProps): React.ReactElement {
  return (
    <Glyph
      className="ui-icon"
      data-flip={flip ? 'true' : undefined}
      size={size}
      strokeWidth={1.5}
      aria-hidden="true"
      focusable="false"
    />
  );
}
