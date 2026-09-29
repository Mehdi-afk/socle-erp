// SPDX-License-Identifier: LGPL-3.0-only
//
// Uploaded files (ARCHITECTURE.md §9.3 "Fichiers"): the name a user gives is only a label,
// never a path; the type is what the content really is, never what the name or the browser
// claims.

const FORBIDDEN = /[<>:"/\\|?*]/g;
// Control characters, including the Unicode bidirectional overrides used to disguise
// extensions ("invoice\u202Efdp.exe").
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const INVISIBLE = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const MAX_NAME = 200;

/**
 * A safe display name for an uploaded file: last path component only, no control or
 * direction-override character, no character forbidden on common file systems, no leading
 * dot, at most 200 characters (extension kept). Never empty.
 */
export function sanitizeFileName(name: string): string {
  const last = name.split(/[/\\]/).pop() ?? '';
  let clean = last
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(FORBIDDEN, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (clean.length > MAX_NAME) {
    const dot = clean.lastIndexOf('.');
    const extension = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : '';
    clean = `${clean.slice(0, MAX_NAME - extension.length)}${extension}`;
  }
  return clean === '' ? 'fichier' : clean;
}

const startsWith = (data: Uint8Array, bytes: readonly number[], offset = 0): boolean =>
  data.length >= offset + bytes.length && bytes.every((byte, i) => data[offset + i] === byte);

const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0));

/** True for valid UTF-8 without NUL bytes (a text file). */
function isText(data: Uint8Array): boolean {
  if (data.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

const OFFICE: Readonly<Record<string, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
};

/**
 * The real type of a file from its first bytes. A ZIP container is refined by the name's
 * extension among office formats only (their content is ZIP); anything unknown is
 * `application/octet-stream`, served as a download, never rendered.
 */
export function detectFileType(data: Uint8Array, name = ''): string {
  if (startsWith(data, ascii('%PDF-'))) return 'application/pdf';
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(data, ascii('GIF87a')) || startsWith(data, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(data, ascii('RIFF')) && startsWith(data, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(data, [0x50, 0x4b, 0x03, 0x04])) {
    const extension = /\.([a-z]{3,4})$/i.exec(name)?.[1]?.toLowerCase() ?? '';
    return Object.hasOwn(OFFICE, extension) ? (OFFICE[extension] as string) : 'application/zip';
  }
  if (data.length > 0 && isText(data.subarray(0, 4096))) {
    const head = new TextDecoder().decode(data.subarray(0, 512)).trimStart().toLowerCase();
    // Markup that a browser would execute is never served as such.
    if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<svg'))
      return 'application/octet-stream';
    return 'text/plain';
  }
  return 'application/octet-stream';
}

/** `Content-Disposition` for a download, with the UTF-8 name (RFC 6266 / RFC 5987). */
export function contentDisposition(name: string): string {
  const safe = sanitizeFileName(name);
  const fallback = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
