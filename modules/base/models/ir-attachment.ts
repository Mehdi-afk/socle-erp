// SPDX-License-Identifier: LGPL-3.0-only
//
// Attachments: metadata only, the content lives in S3 (ARCHITECTURE.md §9.3 "Fichiers").
// Users reach them through the server's attachment endpoints, which check the rights on the
// record the file belongs to; the generic RPC does not expose this model to them. A file can
// only be downloaded once the antivirus found it clean.
import { defineModel, f } from '@socle/framework';

export default defineModel({
  name: 'ir.attachment',
  description: { fr: 'Pièce jointe', en: 'Attachment', ar: 'مرفق' },
  mixins: ['company.scoped'],
  order: 'createdAt desc',
  offline: { syncable: false },
  fields: {
    name: f.char({ required: true, label: { fr: 'Nom', en: 'Name', ar: 'الاسم' } }),
    resModel: f.char({ required: true, index: true, readonly: true }),
    resId: f.char({ required: true, index: true, readonly: true }),
    /** Detected from the content, never from the name. */
    mimetype: f.char({ readonly: true, label: { fr: 'Type', en: 'Type', ar: 'النوع' } }),
    size: f.integer({ readonly: true, label: { fr: 'Taille', en: 'Size', ar: 'الحجم' } }),
    /** SHA-256 (hex) of the content. */
    checksum: f.char({ readonly: true, size: 64 }),
    storeKey: f.char({ readonly: true, groups: ['base.group_system'] }),
    scanStatus: f.selection(
      [
        ['pending', "En attente d'analyse"],
        ['clean', 'Sain'],
        ['infected', 'Infecté'],
        ['error', 'Analyse impossible'],
      ],
      {
        default: 'pending',
        readonly: true,
        label: { fr: 'Antivirus', en: 'Antivirus', ar: 'مكافحة الفيروسات' },
      },
    ),
    scanSignature: f.char({ readonly: true }),
    scanAttempts: f.integer({ default: 0, readonly: true }),
    scannedAt: f.datetime({ readonly: true }),
  },
});
