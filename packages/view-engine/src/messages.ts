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
  readonly edit: (title: string) => string;
  readonly save: string;
  readonly saving: string;
  readonly cancel: string;
  readonly saved: string;
  readonly saveError: string;
  readonly refreshError: string;
  readonly choose: string;
  readonly searchRelated: (label: string) => string;
  readonly problem: {
    readonly invalid: string;
    readonly required: (label: string) => string;
    readonly integer: string;
    readonly number: string;
    readonly date: string;
    readonly decimals: (max: number) => string;
  };
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
  edit: (title) => `Modifier : ${title}`,
  save: 'Enregistrer',
  saving: 'Enregistrement…',
  cancel: 'Annuler',
  saved: 'Modifications enregistrées.',
  saveError: 'Les modifications n’ont pas pu être enregistrées. Réessayez.',
  refreshError: 'Modifications enregistrées, mais la fiche n’a pas pu être actualisée.',
  choose: 'Choisir…',
  searchRelated: (label) => `Rechercher : ${label}`,
  problem: {
    invalid: 'Cette valeur n’est pas valide.',
    required: (label) => `Le champ « ${label} » est obligatoire.`,
    integer: 'Saisissez un nombre entier.',
    number: 'Saisissez un nombre.',
    date: 'Saisissez une date valide (AAAA-MM-JJ).',
    decimals: (max) => `Au plus ${String(max)} décimale${max > 1 ? 's' : ''}.`,
  },
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
  edit: (title) => `Edit: ${title}`,
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  saved: 'Changes saved.',
  saveError: 'Your changes could not be saved. Please try again.',
  refreshError: 'Changes saved, but the record could not be refreshed.',
  choose: 'Choose…',
  searchRelated: (label) => `Search: ${label}`,
  problem: {
    invalid: 'This value is not valid.',
    required: (label) => `“${label}” is required.`,
    integer: 'Enter a whole number.',
    number: 'Enter a number.',
    date: 'Enter a valid date (YYYY-MM-DD).',
    decimals: (max) => `At most ${String(max)} decimal places.`,
  },
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
  edit: (title) => `تعديل: ${title}`,
  save: 'حفظ',
  saving: 'جارٍ الحفظ…',
  cancel: 'إلغاء',
  saved: 'تم حفظ التغييرات.',
  saveError: 'تعذّر حفظ التغييرات. حاول مجددًا.',
  refreshError: 'تم حفظ التغييرات، لكن تعذّر تحديث عرض السجل.',
  choose: 'اختر…',
  searchRelated: (label) => `البحث: ${label}`,
  problem: {
    invalid: 'هذه القيمة غير صالحة.',
    required: (label) => `الحقل «${label}» مطلوب.`,
    integer: 'أدخل عددًا صحيحًا.',
    number: 'أدخل عددًا.',
    date: 'أدخل تاريخًا صالحًا (YYYY-MM-DD).',
    decimals: (max) => `الحد الأقصى للمنازل العشرية: ${String(max)}.`,
  },
};

const TABLE: Readonly<Record<string, Messages>> = { fr, en, ar };

/** The engine's own words in a language (its base language, else English). */
export function messagesFor(language: string): Messages {
  const base = language.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return Object.hasOwn(TABLE, base) ? (TABLE[base] as Messages) : en;
}
