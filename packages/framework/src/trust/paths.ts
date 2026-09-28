// SPDX-License-Identifier: LGPL-3.0-only

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * True when `path` is a safe, normalized, relative POSIX path inside a module:
 * no absolute path, no drive letter, no backslash, no empty, `.` or `..` segment.
 * (ARCHITECTURE.md §9.2: every file path is normalized and confined to its root.)
 * @public
 */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 255) return false;
  const segments = path.split('/');
  return segments.every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..');
}
