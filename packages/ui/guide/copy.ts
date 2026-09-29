// SPDX-License-Identifier: LGPL-3.0-only
//
// The words of the guide itself and the sample data of its screens, in the three languages of the
// client. The components take their text from their callers; nothing here is part of the design
// system.

export type Language = 'fr' | 'en' | 'ar';
export const LANGUAGES: readonly Language[] = ['fr', 'en', 'ar'];

export interface Copy {
  readonly title: string;
  readonly intro: string;
  readonly theme: string;
  readonly themes: Readonly<Record<'hybrid' | 'dark' | 'light', string>>;
  readonly language: string;
  readonly density: string;
  readonly densities: Readonly<Record<'comfortable' | 'compact', string>>;
  readonly colors: string;
  readonly contrast: string;
  readonly contrastHelp: string;
  readonly pair: string;
  readonly ratio: string;
  readonly required: string;
  readonly passes: string;
  readonly fails: string;
  readonly categories: string;
  readonly semantic: string;
  readonly typography: string;
  readonly shapes: string;
  readonly buttons: string;
  readonly primary: string;
  readonly secondary: string;
  readonly ghost: string;
  readonly danger: string;
  readonly running: string;
  readonly disabled: string;
  readonly call: string;
  readonly message: string;
  readonly print: string;
  readonly moreActions: string;
  readonly edit: string;
  readonly archive: string;
  readonly delete: string;
  readonly cards: string;
  readonly generalData: string;
  readonly confidentialData: string;
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly city: string;
  readonly notes: string;
  readonly taxId: string;
  readonly bankAccount: string;
  readonly show: string;
  readonly badges: string;
  readonly states: string;
  readonly participants: string;
  readonly navigation: string;
  readonly sections: string;
  readonly tabGeneral: string;
  readonly tabAddress: string;
  readonly tabNotes: string;
  readonly view: string;
  readonly day: string;
  readonly week: string;
  readonly month: string;
  readonly fields: string;
  readonly emailHint: string;
  readonly emailError: string;
  readonly country: string;
  readonly choose: string;
  readonly subscribed: string;
  readonly active: string;
  readonly feedback: string;
  readonly noContact: string;
  readonly noContactText: string;
  readonly addContact: string;
  readonly loading: string;
  readonly focus: string;
  readonly focusText: string;
  readonly accent: string;
  readonly accentHelp: string;
  readonly accentAccepted: string;
  readonly accentRefused: string;
  readonly textOnAccent: string;
  readonly sample: string;
  readonly person: string;
  readonly others: readonly string[];
}

export const COPY: Readonly<Record<Language, Copy>> = {
  fr: {
    title: 'Guide de style',
    intro:
      'Jetons, composants et états du design system de Socle. Changez le thème, la langue (l’arabe passe l’interface de droite à gauche) et la densité pour vérifier chaque cas.',
    theme: 'Thème',
    themes: { hybrid: 'Hybride', dark: 'Sombre', light: 'Clair' },
    language: 'Langue',
    density: 'Densité',
    densities: { comfortable: 'Confortable', compact: 'Compacte' },
    colors: 'Couleurs',
    contrast: 'Contrastes',
    contrastHelp:
      'Chaque paire texte/fond utilisée par les composants, calculée en direct dans le thème choisi.',
    pair: 'Paire',
    ratio: 'Contraste',
    required: 'Minimum',
    passes: 'Conforme',
    fails: 'Insuffisant',
    categories: 'Catégories',
    semantic: 'Couleurs d’état',
    typography: 'Typographie',
    shapes: 'Formes et espacements',
    buttons: 'Boutons',
    primary: 'Principal',
    secondary: 'Secondaire',
    ghost: 'Discret',
    danger: 'Danger',
    running: 'En cours',
    disabled: 'Désactivé',
    call: 'Appeler',
    message: 'Écrire un message',
    print: 'Imprimer',
    moreActions: 'Plus d’actions',
    edit: 'Modifier',
    archive: 'Archiver',
    delete: 'Supprimer',
    cards: 'Cartes et paires libellé/valeur',
    generalData: 'Données générales',
    confidentialData: 'Données confidentielles',
    name: 'Nom',
    email: 'Email',
    phone: 'Téléphone',
    city: 'Ville',
    notes: 'Notes',
    taxId: 'Identifiant fiscal',
    bankAccount: 'Compte bancaire',
    show: 'Afficher',
    badges: 'Badges, pastilles d’état, avatars',
    states: 'États',
    participants: 'Participants',
    navigation: 'Navigation',
    sections: 'Sections du contact',
    tabGeneral: 'Général',
    tabAddress: 'Adresse',
    tabNotes: 'Notes',
    view: 'Vue du calendrier',
    day: 'Jour',
    week: 'Semaine',
    month: 'Mois',
    fields: 'Champs de saisie',
    emailHint: 'Nous ne le partageons pas.',
    emailError: 'Saisissez une adresse valide.',
    country: 'Pays',
    choose: 'Choisir…',
    subscribed: 'Abonné à la lettre d’information',
    active: 'Actif',
    feedback: 'États vides et chargement',
    noContact: 'Aucun contact pour l’instant',
    noContactText: 'Les contacts que vous ajouterez apparaîtront ici.',
    addContact: 'Ajouter un contact',
    loading: 'Chargement',
    focus: 'Anneau de focus',
    focusText:
      'Au clavier, chaque élément interactif reçoit un double anneau : l’un des deux ressort sur tous les fonds.',
    accent: 'Accent de la société',
    accentHelp:
      'Saisissez une couleur : elle n’est acceptée que si le texte posé dessus reste lisible.',
    accentAccepted: 'Accent accepté',
    accentRefused: 'Accent refusé',
    textOnAccent: 'Texte sur l’accent',
    sample: 'Exemple',
    person: 'Amel Benali',
    others: ['Karim Haddad', 'Sara Mansouri', 'Yacine Belkacem', 'Lina Cherif'],
  },
  en: {
    title: 'Style guide',
    intro:
      'Tokens, components and states of the Socle design system. Change the theme, the language (Arabic turns the interface right to left) and the density to check each case.',
    theme: 'Theme',
    themes: { hybrid: 'Hybrid', dark: 'Dark', light: 'Light' },
    language: 'Language',
    density: 'Density',
    densities: { comfortable: 'Comfortable', compact: 'Compact' },
    colors: 'Colours',
    contrast: 'Contrast',
    contrastHelp:
      'Every text/background pair the components use, computed live in the chosen theme.',
    pair: 'Pair',
    ratio: 'Contrast',
    required: 'Minimum',
    passes: 'Passes',
    fails: 'Too low',
    categories: 'Categories',
    semantic: 'State colours',
    typography: 'Typography',
    shapes: 'Shapes and spacing',
    buttons: 'Buttons',
    primary: 'Primary',
    secondary: 'Secondary',
    ghost: 'Ghost',
    danger: 'Danger',
    running: 'Running',
    disabled: 'Disabled',
    call: 'Call',
    message: 'Write a message',
    print: 'Print',
    moreActions: 'More actions',
    edit: 'Edit',
    archive: 'Archive',
    delete: 'Delete',
    cards: 'Cards and label/value pairs',
    generalData: 'General data',
    confidentialData: 'Confidential data',
    name: 'Name',
    email: 'Email',
    phone: 'Phone',
    city: 'City',
    notes: 'Notes',
    taxId: 'Tax id',
    bankAccount: 'Bank account',
    show: 'Show',
    badges: 'Badges, status pills, avatars',
    states: 'States',
    participants: 'Participants',
    navigation: 'Navigation',
    sections: 'Contact sections',
    tabGeneral: 'General',
    tabAddress: 'Address',
    tabNotes: 'Notes',
    view: 'Calendar view',
    day: 'Day',
    week: 'Week',
    month: 'Month',
    fields: 'Form fields',
    emailHint: 'We never share it.',
    emailError: 'Enter a valid address.',
    country: 'Country',
    choose: 'Choose…',
    subscribed: 'Subscribed to the newsletter',
    active: 'Active',
    feedback: 'Empty and loading states',
    noContact: 'No contact yet',
    noContactText: 'Contacts you add will appear here.',
    addContact: 'Add a contact',
    loading: 'Loading',
    focus: 'Focus ring',
    focusText:
      'With the keyboard, every interactive element gets a double ring: one of the two stands out on any background.',
    accent: 'Company accent',
    accentHelp: 'Type a colour: it is accepted only if the text on it stays readable.',
    accentAccepted: 'Accent accepted',
    accentRefused: 'Accent refused',
    textOnAccent: 'Text on the accent',
    sample: 'Sample',
    person: 'Amel Benali',
    others: ['Karim Haddad', 'Sara Mansouri', 'Yacine Belkacem', 'Lina Cherif'],
  },
  ar: {
    title: 'دليل الأنماط',
    intro:
      'الرموز والمكوّنات والحالات في نظام تصميم «سوكل». غيّر السمة واللغة (العربية تجعل الواجهة من اليمين إلى اليسار) والكثافة للتحقق من كل حالة.',
    theme: 'السمة',
    themes: { hybrid: 'مختلطة', dark: 'داكنة', light: 'فاتحة' },
    language: 'اللغة',
    density: 'الكثافة',
    densities: { comfortable: 'مريحة', compact: 'مدمجة' },
    colors: 'الألوان',
    contrast: 'التباين',
    contrastHelp: 'كل زوج نص/خلفية تستعمله المكوّنات، محسوب مباشرة في السمة المختارة.',
    pair: 'الزوج',
    ratio: 'التباين',
    required: 'الحد الأدنى',
    passes: 'مطابق',
    fails: 'غير كافٍ',
    categories: 'الفئات',
    semantic: 'ألوان الحالة',
    typography: 'الخطوط',
    shapes: 'الأشكال والمسافات',
    buttons: 'الأزرار',
    primary: 'رئيسي',
    secondary: 'ثانوي',
    ghost: 'خفيف',
    danger: 'خطر',
    running: 'قيد التنفيذ',
    disabled: 'معطّل',
    call: 'اتصال',
    message: 'كتابة رسالة',
    print: 'طباعة',
    moreActions: 'مزيد من الإجراءات',
    edit: 'تعديل',
    archive: 'أرشفة',
    delete: 'حذف',
    cards: 'البطاقات وأزواج العنوان/القيمة',
    generalData: 'بيانات عامة',
    confidentialData: 'بيانات سرية',
    name: 'الاسم',
    email: 'البريد الإلكتروني',
    phone: 'الهاتف',
    city: 'المدينة',
    notes: 'ملاحظات',
    taxId: 'المعرّف الجبائي',
    bankAccount: 'الحساب البنكي',
    show: 'إظهار',
    badges: 'الشارات وحالات الأوضاع والصور الرمزية',
    states: 'الحالات',
    participants: 'المشاركون',
    navigation: 'التنقل',
    sections: 'أقسام جهة الاتصال',
    tabGeneral: 'عام',
    tabAddress: 'العنوان',
    tabNotes: 'ملاحظات',
    view: 'عرض التقويم',
    day: 'يوم',
    week: 'أسبوع',
    month: 'شهر',
    fields: 'حقول الإدخال',
    emailHint: 'لا نشاركه مع أحد.',
    emailError: 'أدخل عنواناً صالحاً.',
    country: 'البلد',
    choose: 'اختر…',
    subscribed: 'مشترك في النشرة الإخبارية',
    active: 'نشط',
    feedback: 'الحالات الفارغة والتحميل',
    noContact: 'لا توجد جهات اتصال بعد',
    noContactText: 'ستظهر هنا جهات الاتصال التي تضيفها.',
    addContact: 'إضافة جهة اتصال',
    loading: 'جارٍ التحميل',
    focus: 'حلقة التركيز',
    focusText:
      'عند استعمال لوحة المفاتيح يحصل كل عنصر تفاعلي على حلقة مزدوجة: إحداهما تظهر على أي خلفية.',
    accent: 'لون الشركة',
    accentHelp: 'اكتب لوناً: لا يُقبل إلا إذا بقي النص المكتوب عليه مقروءاً.',
    accentAccepted: 'تم قبول اللون',
    accentRefused: 'تم رفض اللون',
    textOnAccent: 'النص على لون الشركة',
    sample: 'مثال',
    person: 'أمل بن علي',
    others: ['كريم حداد', 'سارة منصوري', 'ياسين بلقاسم', 'لينا شريف'],
  },
};
