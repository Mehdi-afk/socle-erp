// SPDX-License-Identifier: LGPL-3.0-only
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { contentDisposition, detectFileType, sanitizeFileName } from './files.js';

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

describe('file names', () => {
  it('keep only a safe last component', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('..\\..\\Windows\\system.ini')).toBe('system.ini');
    expect(sanitizeFileName('C:\\Users\\a\\Facture n°42.pdf')).toBe('Facture n°42.pdf');
    expect(sanitizeFileName('.htaccess')).toBe('htaccess');
    expect(sanitizeFileName('a<b>:c"d|e?f*.txt')).toBe('a_b__c_d_e_f_.txt');
    expect(sanitizeFileName('facture\u202Efdp.exe')).toBe('facturefdp.exe');
    expect(sanitizeFileName('  ...  ')).toBe('fichier');
    expect(sanitizeFileName('')).toBe('fichier');
    expect(sanitizeFileName('عقد العمل.pdf')).toBe('عقد العمل.pdf');
    const long = sanitizeFileName(`${'x'.repeat(500)}.pdf`);
    expect(long).toHaveLength(200);
    expect(long.endsWith('.pdf')).toBe(true);
  });

  it('never contain a separator, a control character or a leading dot (any input)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (name) => {
        const clean = sanitizeFileName(name);
        expect(clean.length).toBeGreaterThan(0);
        expect(clean.length).toBeLessThanOrEqual(200);
        // eslint-disable-next-line no-control-regex -- checking that control characters are gone
        expect(clean).not.toMatch(/[/\\<>:"|?*\u0000-\u001f\u202a-\u202e]/);
        expect(clean.startsWith('.')).toBe(false);
      }),
    );
  });

  it('are sent as a download with an ASCII fallback and the UTF-8 name', () => {
    expect(contentDisposition('Facture "été".pdf')).toBe(
      `attachment; filename="Facture __t__.pdf"; filename*=UTF-8''Facture%20_%C3%A9t%C3%A9_.pdf`,
    );
  });
});

describe('file types', () => {
  it('come from the content, not from the name', () => {
    expect(detectFileType(text('%PDF-1.7\n'), 'photo.jpg')).toBe('application/pdf');
    expect(detectFileType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe(
      'image/png',
    );
    expect(detectFileType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(detectFileType(text('GIF89a...'))).toBe('image/gif');
    expect(detectFileType(text('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(detectFileType(bytes(0x50, 0x4b, 0x03, 0x04, 1), 'Devis.XLSX')).toContain(
      'spreadsheetml',
    );
    expect(detectFileType(bytes(0x50, 0x4b, 0x03, 0x04, 1), 'x.exe')).toBe('application/zip');
    expect(detectFileType(text('Bonjour, voici la liste'))).toBe('text/plain');
    expect(detectFileType(bytes(0x4d, 0x5a, 0x90, 0x00), 'invoice.pdf')).toBe(
      'application/octet-stream',
    );
    expect(detectFileType(new Uint8Array())).toBe('application/octet-stream');
  });

  it('never let a browser run markup', () => {
    for (const markup of ['<!DOCTYPE html><script>', '  <html>', '<svg onload=alert(1)>']) {
      expect(detectFileType(text(markup), 'notes.txt'), markup).toBe('application/octet-stream');
    }
  });
});
