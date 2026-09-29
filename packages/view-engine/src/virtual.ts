// SPDX-License-Identifier: LGPL-3.0-only
//
// Virtual scrolling: a list of 10 000 rows draws only the few that are on screen (plus a margin),
// inside a container as tall as the whole list, so the scroll bar and the position are those of the
// full list. Rows have a fixed height (the density), so where a row is is arithmetic.

export interface WindowInput {
  /** How far the list is scrolled, in pixels. */
  readonly scrollTop: number;
  /** Height of the visible area, in pixels. */
  readonly viewportHeight: number;
  /** Height of one row, in pixels (48 or 32 depending on the density). */
  readonly rowHeight: number;
  /** Number of rows in the whole list. */
  readonly total: number;
  /** Extra rows drawn above and below, so that fast scrolling shows no blank (default 6). */
  readonly overscan?: number;
}

export interface RowWindow {
  /** Index of the first row to draw. */
  readonly start: number;
  /** Index after the last row to draw. */
  readonly end: number;
  /** Space before the first drawn row, in pixels. */
  readonly offset: number;
  /** Height of the whole list, in pixels. */
  readonly height: number;
}

/**
 * The rows to draw for a scroll position. Always a range inside `0…total`; empty for an empty list;
 * covers every row that is even partly visible.
 */
export function windowOf(input: WindowInput): RowWindow {
  const { rowHeight, total } = input;
  const overscan = input.overscan ?? 6;
  const height = Math.max(0, total) * rowHeight;
  if (total <= 0 || rowHeight <= 0) return { start: 0, end: 0, offset: 0, height: 0 };
  const top = Math.min(Math.max(0, input.scrollTop), Math.max(0, height - 1));
  const first = Math.floor(top / rowHeight);
  const visible = Math.ceil(Math.max(0, input.viewportHeight) / rowHeight) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(total, first + visible + overscan);
  return { start, end, offset: start * rowHeight, height };
}
