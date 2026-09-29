// SPDX-License-Identifier: LGPL-3.0-only
//
// The words of the engine itself (not of the models): buttons, empty states, announcements. French,
// English and Arabic; a language that is not here gets English.

export interface Messages {
  readonly yes: string;
  readonly no: string;
  readonly empty: string;
  readonly emptyTitle: string;
  readonly loading: string;
  readonly loadError: string;
  readonly retry: string;
  readonly selectRow: string;
  readonly selectAll: string;
  readonly selected: (count: number) => string;
  readonly clearSelection: string;
  readonly sortBy: (label: string) => string;
  readonly openRecord: string;
  readonly rowsCount: (count: number) => string;
  readonly notSet: string;
  readonly call: string;
  readonly writeTo: string;
  readonly openLink: string;
  readonly confidentialTitle: string;
  readonly masked: string;
  readonly reveal: (label: string) => string;
  readonly hide: (label: string) => string;
  readonly revealError: string;
  readonly notFound: string;
  readonly sections: string;
}

const fr: Messages = {
  yes: 'Oui',
  no: 'Non',
  empty: 'Aucun enregistrement ne correspond.',
  emptyTitle: 'Rien à afficher',
  loading: 'Chargement',
  loadError: 'Impossible de charger les données.',
  retry: 'Réessayer',
  selectRow: 'Sélectionner la ligne',
  selectAll: 'Sélectionner toutes les lignes chargées',
  selected: (count) => `${String(count)} sélectionné${count > 1 ? 's' : ''}`,
  clearSelection: 'Tout désélectionner',
  sortBy: (label) => `Trier par ${label}`,
  openRecord: 'Ouvrir',
  rowsCount: (count) =>
    `${new Intl.NumberFormat('fr').format(count)} enregistrement${count > 1 ? 's' : ''}`,
  notSet: 'Non renseigné',
  call: 'Appeler',
  writeTo: 'Écrire',
  openLink: 'Ouvrir le lien',
  confidentialTitle: 'Données confidentielles',
  masked: 'Masqué',
  reveal: (label) => `Afficher : ${label}`,
  hide: (label) => `Masquer : ${label}`,
  revealError: 'Impossible d’afficher cette donnée.',
  notFound: 'Cet enregistrement n’existe pas ou vous n’y avez pas accès.',
  sections: 'Sections',
};

const en: Messages = {
  yes: 'Yes',
  no: 'No',
  empty: 'No record matches.',
  emptyTitle: 'Nothing to show',
  loading: 'Loading',
  loadError: 'The data could not be loaded.',
  retry: 'Try again',
  selectRow: 'Select the row',
  selectAll: 'Select all loaded rows',
  selected: (count) => `${String(count)} selected`,
  clearSelection: 'Clear selection',
  sortBy: (label) => `Sort by ${label}`,
  openRecord: 'Open',
  rowsCount: (count) =>
    `${new Intl.NumberFormat('en').format(count)} record${count === 1 ? '' : 's'}`,
  notSet: 'Not set',
  call: 'Call',
  writeTo: 'Write',
  openLink: 'Open the link',
  confidentialTitle: 'Confidential data',
  masked: 'Hidden',
  reveal: (label) => `Show: ${label}`,
  hide: (label) => `Hide: ${label}`,
  revealError: 'This data could not be shown.',
  notFound: 'This record does not exist or you cannot access it.',
  sections: 'Sections',
};

const ar: Messages = {
  yes: 'نعم',
  no: 'لا',
  empty: 'لا توجد سجلات مطابقة.',
  emptyTitle: 'لا شيء لعرضه',
  loading: 'جارٍ التحميل',
  loadError: 'تعذّر تحميل البيانات.',
  retry: 'إعادة المحاولة',
  selectRow: 'تحديد السطر',
  selectAll: 'تحديد كل الأسطر المحمّلة',
  selected: (count) => `${String(count)} محدد`,
  clearSelection: 'إلغاء التحديد',
  sortBy: (label) => `الفرز حسب ${label}`,
  openRecord: 'فتح',
  rowsCount: (count) => `${new Intl.NumberFormat('ar').format(count)} سجل`,
  notSet: 'غير مُدخل',
  call: 'اتصال',
  writeTo: 'مراسلة',
  openLink: 'فتح الرابط',
  confidentialTitle: 'بيانات سرية',
  masked: 'مخفي',
  reveal: (label) => `إظهار: ${label}`,
  hide: (label) => `إخفاء: ${label}`,
  revealError: 'تعذّر إظهار هذه البيانات.',
  notFound: 'هذا السجل غير موجود أو لا يمكنك الوصول إليه.',
  sections: 'الأقسام',
};

const TABLE: Readonly<Record<string, Messages>> = { fr, en, ar };

/** The engine's own words in a language (its base language, else English). */
export function messagesFor(language: string): Messages {
  const base = language.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return Object.hasOwn(TABLE, base) ? (TABLE[base] as Messages) : en;
}
