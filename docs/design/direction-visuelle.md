# Direction visuelle du client web

- **Statut** : proposition (étape A du lot 2.3), en attente de validation du mainteneur.
- **Portée** : `packages/ui` (design system), `packages/view-engine` (moteur de vues), module `web` (coque).
- **Source** : trois maquettes d'un designer tiers, utilisées **comme inspiration seulement**. Elles ne sont pas versionnées (`inspiration-ui/` est ignoré par Git). Ce document décrit le langage visuel retenu avec nos propres mots. Il ne reprend ni les noms, ni les logos, ni les illustrations, ni les textes, ni les données des maquettes.

## 1. Principes

1. **Coque sombre, contenu clair.** La navigation et le fond de l'application sont anthracite. Les données s'affichent sur des cartes blanches très arrondies. On garde le confort de lecture d'une interface claire, et la coque sombre fait ressortir le contenu.
2. **Un seul accent vif.** Un jaune-vert acide marque ce qui compte : action principale, badge, élément actif, jour courant. Il sert toujours de **fond** (texte encre dessus), jamais de couleur de texte ou d'icône sur fond clair.
3. **Le violet pour « où je suis ».** Un violet profond signale l'entrée de menu active, toujours accompagné d'un second indicateur (voir §5).
4. **Les pastels pour « de quel type ».** Les couleurs douces classent les choses : types d'activités, étiquettes, séries de graphiques. Elles ne signalent jamais un état ni une action.
5. **De l'air, peu de traits.** Les séparations sont des filets presque invisibles ; la hiérarchie vient de l'espacement et de la typographie, pas des bordures.
6. **Tout est générique.** Aucune fiche n'est dessinée pour un modèle particulier. Le moteur de vues applique ce langage à toute vue `form`, `list`, `calendar`, `kanban`, `pivot` ou `graph` de n'importe quel module.
7. **L'ERP d'abord.** Quand l'esthétique des maquettes gêne un usage intensif (densité, lisibilité, clavier), l'usage l'emporte. Les écarts sont listés au §5.

## 2. Jetons de design (tokens)

Tous les composants lisent des variables CSS. Aucune couleur n'est écrite en dur dans un composant ; une règle stylelint le bloque.

### 2.1 Couleurs — thème « hybride » (par défaut)

| Jeton | Valeur | Rôle |
|---|---|---|
| `--color-canvas` | `#212025` | Fond de l'application, derrière les cartes |
| `--color-shell` | `#2B2B2D` | Barre latérale, panneaux sombres |
| `--color-shell-text` | `#FFFFFF` | Texte principal dans la coque (14,1 : 1) |
| `--color-shell-muted` | `#A1A1A6` | Texte secondaire dans la coque (5,5 : 1) |
| `--color-surface` | `#FFFFFF` | Cartes de contenu |
| `--color-surface-sunken` | `#F6F6F4` | Zones en retrait dans une carte (en-tête de liste intégrée, survol de ligne) |
| `--color-ink` | `#1B1B1D` | Texte sur fond clair et sur l'accent |
| `--color-label` | `#6B6E72` | Libellés (5,1 : 1 sur blanc ; 4,7 : 1 sur l'accent pâle) |
| `--color-line` | `#EFEFEF` | Filets de séparation (décoratifs) |
| `--color-accent` | `#EBFF65` | Accent : fond des actions principales, badges, élément actif (surchargeable par société) |
| `--color-on-accent` | `#1B1B1D` | Texte et icônes posés sur l'accent (15,6 : 1), calculé automatiquement |
| `--color-accent-soft` | `#EFFCAA` | Fond de la carte « Données confidentielles », surlignage |
| `--color-nav-active` | `#4C458A` | Fond de l'entrée de menu active (texte blanc : 8,3 : 1) |
| `--color-link` | `#2F55C8` | Liens dans le contenu (à valider au contraste ≥ 4,5 : 1 sur blanc et sur les surfaces grises) |
| `--color-focus-outer` / `--color-focus-inner` | `#1B1B1D` / `#FFFFFF` | Anneau de focus double, visible sur tous les fonds |
| `--color-category-1` … `--color-category-8` | pêche `#FEE3AA`, bleu `#CEE5FF`, rose `#FCCCE7`, + 5 autres à définir | Catégories (calendrier, étiquettes, graphiques) ; toutes ≥ 7 : 1 avec l'encre |

**Couleurs sémantiques**, distinctes de l'accent et proposées ici :
- `--color-success`, `--color-warning`, `--color-danger`, `--color-info` ;
- chacune avec une variante `-soft` (fond de pastille ou d'alerte) et une variante `-text` (texte lisible sur blanc, ≥ 4,5 : 1).

Les valeurs exactes seront fixées à l'étape B et vérifiées par un test automatique de contraste.

### 2.2 Thèmes « sombre » et « clair »

| Jeton | Sombre | Clair |
|---|---|---|
| `--color-canvas` | `#212025` | `#F3F3F1` |
| `--color-shell` | `#2B2B2D` | `#FFFFFF` (avec filet) |
| `--color-surface` | `#2B2B2D` | `#FFFFFF` |
| `--color-ink` | `#F2F2F3` | `#1B1B1D` |
| `--color-label` | `#A1A1A6` | `#6B6E72` |
| `--color-accent-soft` | vert olive très sombre, à définir | `#EFFCAA` |
| Catégories | pastels désaturés et assombris (texte clair dessus) | identiques à l'hybride |

Le thème est porté par l'attribut `data-theme` sur la racine. La préférence utilisateur l'emporte sur le réglage du système.

### 2.3 Typographie

- **Latin** : Inter (licence OFL), police variable woff2, auto-hébergée. Découpée par `unicode-range` : latin, latin étendu.
- **Arabe** : Noto Sans Arabic (OFL), auto-hébergée, découpée par `unicode-range`. Elle ne se charge que si la page contient de l'arabe.
- Aucune police chargée depuis un CDN.

| Jeton | Taille / graisse | Usage |
|---|---|---|
| `--font-title` | 28–32 px, 400 | Titre de fiche sur le bandeau (grand et léger) |
| `--font-heading` | 20 px, 500 | Titre de carte |
| `--font-body` | 14 px, 400 | Valeurs, cellules |
| `--font-label` | 13 px, 400, couleur `--color-label` | Libellés, en-têtes de colonnes |
| `--font-small` | 12 px, 500 | Badges, sous-titres |

Les tableaux, montants, dates et compteurs utilisent des chiffres tabulaires. En arabe, l'interligne augmente d'environ 10 % pour les signes diacritiques.

### 2.4 Formes, espacements, mouvement

| Jeton | Valeur |
|---|---|
| `--radius-card` | 24 px (16 px sous 820 px de large) |
| `--radius-field` | 12 px |
| `--radius-pill` | 999 px (boutons principaux, badges, contrôle segmenté) |
| `--space-1` … `--space-12` | multiples de 4 px ; marge intérieure de carte 24 px (16 px en mode compact) |
| `--shadow-card` | aucune, ou une ombre très diffuse sur le thème clair |
| `--duration-fast` / `--duration-base` | 150 ms / 200 ms, ramenés à 0 si `prefers-reduced-motion` |
| `--density-row` | 48 px (confortable) / 32 px (compact) |

Toutes les dispositions utilisent des **propriétés logiques** (`margin-inline-start`, `inset-inline-end`…). Aucune règle `left`/`right` n'est écrite en dur ; stylelint le contrôle.

## 3. Correspondance maquettes → moteur de vues

### 3.1 Coque (barre latérale)

| Élément observé | Dans Socle ERP |
|---|---|
| Carte utilisateur en haut (avatar, nom, fonction), bouton de sortie | Utilisateur connecté ; le bouton ouvre un menu : préférences, sécurité (MFA, passkeys, sessions, appareils), déconnexion |
| Entrée « Recherche » | Ouvre la recherche globale **Ctrl+K** (même effet que le raccourci) |
| Entrée « Notifications » avec compteur sur fond accent | Notifications du module `mail` ; compteur plafonné à « 99+ » |
| Groupes repliables avec icône, chevron et sous-entrées | **Menus générés depuis les modules installés** et filtrés par les droits ; état replié mémorisé par utilisateur |
| Sous-entrée active sur fond violet | Entrée active : fond `--color-nav-active`, texte blanc **et** barre d'accent côté début de ligne (voir §5) |
| Séparateurs fins entre groupes | Sections de menu déclarées par les modules (applications, puis entrées générales) |
| Illustration et solde en bas | **Remplacés** par le sélecteur de société et l'**indicateur de synchronisation** (en ligne, hors ligne, N en attente, conflits) qui ouvre le Centre de synchronisation |
| — | Mode replié en icônes seules, avec infobulles ; en arabe la barre passe à droite automatiquement |
| — | Sous 820 px : barre du bas (4 entrées + « Plus »), la barre latérale devient la page « Plus » |

### 3.2 Vue formulaire

| Élément observé | Élément générique |
|---|---|
| Fil d'Ariane au-dessus du titre | Pile d'actions : chaque niveau est cliquable, les niveaux intermédiaires se résument en « … » s'ils sont trop nombreux |
| Grand visuel abstrait derrière l'en-tête | **Bandeau** : notre propre visuel SVG, teinté par l'accent de la société (§4) ; désactivable, absent en mode compact |
| Avatar, nom sur deux lignes, fonction | **En-tête de fiche** déclaré dans la vue : `header: { avatar, title, subtitle }` |
| Boutons ronds sur accent (appel, message, envoi, impression) | **Actions rapides** dérivées des champs téléphone et email, de `mail.thread` et des rapports d'impression du modèle. Infobulle et nom accessible obligatoires : ce sont des boutons à icône seule |
| Compteur dans une pilule blanche | **Boutons statistiques** (« 12 factures », « 3 activités »), ajoutés par les modules via `extendView` ; un clic ouvre la liste filtrée |
| Carte « données générales » : titre, crayon, paires libellé/valeur séparées par des filets | Chaque **`group`** de la vue devient une carte. Le crayon fait basculer **cette carte** en édition, avec les boutons Enregistrer et Annuler dans la carte |
| Carte « données confidentielles » sur fond accent pâle | Tous les champs **`sensitive: true`** sont regroupés automatiquement dans une carte « Données confidentielles ». Valeurs masquées par défaut (« •••• ») et affichées au clic, chaque affichage étant journalisé dans `ir.audit`. Carte absente pour les groupes non autorisés |
| Pastille verte « disponible » | Widget **`status_badge`** pour les champs `selection` : couleur déclarée par valeur, **toujours accompagnée du libellé** |
| Pièce jointe avec icône et bouton de téléchargement | Widget **`attachment`** : nom assaini, taille, état antivirus (en attente, sain, infecté) ; téléchargement désactivé tant que le fichier n'est pas sain |
| Onglets soulignés sur le fond sombre | **`notebook` / `page`** ; onglets défilants s'ils débordent ; navigation au clavier par flèches |
| Carte avec titre, bouton principal « Ajouter… + » et menu « … » | Champ **`one2many` / `many2many`** en liste intégrée : bouton d'ajout, menu d'actions (exporter, supprimer la sélection) |
| Lignes du tableau avec lien souligné | Valeurs de type URL ou relation rendues en liens (`--color-link`), ouverture dans un nouvel onglet pour les URL externes |
| Avatars empilés « +2 » | Widget **`many2many_avatars`** (liste complète dans une infobulle au survol ou au focus) |
| — | **Chatter** (`mail.thread`) : onglet « Activité » ; panneau latéral au-delà de 1 280 px |
| — | Boutons d'état métier (« Confirmer ») : pilules dans la barre d'en-tête, pilotées par l'état de l'enregistrement |
| — | Indicateur « modifié, non synchronisé » sur la fiche tant qu'une mutation est en attente |

### 3.3 Vue calendrier

| Élément observé | Élément générique |
|---|---|
| Panneau sombre semi-transparent sur le bandeau | Panneau `--color-shell` avec verre dépoli léger ; version opaque si `backdrop-filter` est absent ou si la transparence est réduite |
| Titre « mois, année » | Période affichée, au format de la langue et du fuseau de l'utilisateur (`Intl`) |
| Sélecteur Jour / Semaine / Mois, élément actif sur accent | **Contrôle segmenté** ; flèches précédent / suivant et bouton « Aujourd'hui » |
| Mini-calendrier : jour courant sur accent, semaine sélectionnée surlignée | **Mini-calendrier** ; premier jour de la semaine selon la langue (lundi en FR, samedi en DZ) |
| Filtres « événements » à cases colorées | Filtres par valeur du champ de couleur de la vue (`colorField`) |
| Filtres « calendriers » par personne | Filtres par valeur du champ responsable (`userField`), « Mes éléments » coché par défaut |
| Bouton principal en bas du panneau | Action de création déclarée par la vue |
| Colonnes jour avec numéro, grille horaire | Grille ; l'heure courante est marquée d'une ligne ; les heures sont affichées dans le fuseau de l'utilisateur |
| Événements en cartes pastel : titre, horaire, avatars | **Carte d'événement** : couleur issue de `colorField`, titre, horaire, participants ; glisser-déposer et redimensionnement enregistrés par l'ORM (fonctionnent hors ligne) |

### 3.4 Vue liste

Carte blanche, en-têtes 13 px gris, lignes séparées par des filets, avatars et pastilles d'état. Elle propose deux densités :
- **confortable** (48 px) par défaut ;
- **compacte** (32 px), en préférence par utilisateur.

On y retrouve :
- une ligne de sélection avec barre d'actions groupées ;
- le tri et le regroupement par colonne, l'édition en ligne ;
- le défilement virtualisé ;
- l'en-tête de colonnes collant.

### 3.5 Kanban, pivot, graphique

Même langage, sans maquette de référence :
- **kanban** : colonnes aux en-têtes en pilule, cartes blanches de rayon 24 px, étiquettes pastel, action principale sur accent ;
- **pivot** : tableau de carte à chiffres tabulaires ;
- **graphiques** : séries prises dans la palette de catégories, **jamais l'accent seul**, légende textuelle toujours présente.

## 4. Bandeau d'en-tête

- Création originale : 2 ou 3 formes courbes superposées en SVG, dégradés et reflet.
- Aucune image externe ; **40 Ko au plus**.
- Les teintes sont calculées depuis l'accent de la société :
  - une teinte voisine plus froide ;
  - une teinte complémentaire atténuée ;
  - fondu vers `--color-canvas`.
- Hauteur 160 px sur ordinateur ; réduit à une bande de 56 px quand on fait défiler la fiche.
- Désactivable dans les préférences ; absent en mode compact ; animation lente seulement si le mouvement n'est pas réduit.

## 5. Écarts proposés par rapport aux maquettes

| # | Maquette | Proposition | Raison |
|---|---|---|---|
| 1 | Libellés gris clair (≈ 3,2 : 1) | `--color-label` `#6B6E72` (5,1 : 1) | WCAG 2.2 AA |
| 2 | Texte secondaire gris dans la coque (≈ 4,4 : 1) | `#A1A1A6` (5,5 : 1) | WCAG 2.2 AA |
| 3 | Menu actif signalé par la seule couleur violette (1,7 : 1 sur la coque) | Fond violet, texte blanc et barre d'accent de 3 px au début de la ligne | Un indicateur qui ne repose pas que sur la couleur |
| 4 | Onglet actif souligné en blanc | Souligné de 2 px en accent, texte blanc ; onglets inactifs en `--color-shell-muted` | Distinguer l'onglet actif sans ambiguïté |
| 5 | Actions rapides en icônes seules | Nom accessible et infobulle obligatoires | Lecteurs d'écran, découverte |
| 6 | Pastille d'état : couleur seule possible | Point coloré **et** libellé | Daltonisme |
| 7 | Espacements généreux partout | Mode compact (lignes de 32 px, marges de 16 px) | Usage intensif de l'ERP |
| 8 | Bandeau haut en permanence | Réduit au défilement, absent en compact | Place utile pour les données |
| 9 | Rayon 24 px en toutes tailles | 16 px sous 820 px | Écrans étroits |
| 10 | Aucune couleur d'état | Couleurs sémantiques distinctes de l'accent (§2.1) | L'accent ne doit pas signifier « succès » |
| 11 | Édition non représentée | Bascule par carte, avec raccourcis clavier (Échap pour annuler, Ctrl+S pour enregistrer) | Productivité |
| 12 | Focus non représenté | Anneau double encre et blanc sur tout élément interactif | Navigation clavier sur tous les fonds |
| 13 | Données sensibles visibles d'emblée | Masquées par défaut, affichage journalisé | Sécurité et loi 25-11 (journal des accès) |

## 6. Inventaire des composants (`packages/ui`)

- **Coque** : barre latérale, barre du bas mobile, en-tête de fiche avec bandeau, fil d'Ariane, sélecteur de société, indicateur de synchronisation, menu utilisateur.
- **Contenu** : carte, paire libellé/valeur, liste intégrée avec barre d'outils, état vide, squelette de chargement.
- **Actions** : bouton (principal, secondaire, fantôme, rond d'action rapide, danger), bouton statistique, menu « … », contrôle segmenté, onglets.
- **Saisie** : champs texte, nombre, montant (devise et décimales par devise), date et date-heure (fuseau), sélection, relation many2one avec recherche, case, interrupteur, étiquettes.
- **Affichage** : badge, pastille d'état, avatar et avatars empilés, pièce jointe, mini-calendrier, carte d'événement.
- **Superpositions** : modale, tiroir latéral, notification (toast), infobulle, palette Ctrl+K.

Chaque composant fournit ses états :
- survol, focus, actif, désactivé, chargement, erreur ;
- version RTL ;
- trois thèmes ;
- deux densités lorsqu'elles s'appliquent.

Les icônes viennent de Lucide (ISC), en trait fin. Les flèches et chevrons sont retournés en RTL, les autres icônes non.

## 7. Vérifications automatiques prévues

- **Contraste** : test qui calcule le contraste de chaque paire de jetons utilisée, dans les trois thèmes et pour l'accent personnalisé. La CI échoue sous 4,5 : 1 pour le texte et sous 3 : 1 pour les éléments graphiques porteurs de sens.
- **Accent de société** : la même fonction pure refuse un accent qui n'atteint pas 4,5 : 1 avec l'encre ou avec le blanc, et choisit la couleur de texte à poser dessus.
- **Couleurs en dur** : stylelint refuse toute couleur écrite en dur hors des fichiers de jetons, et toute propriété physique (`left`, `right`, `margin-left`…).
- **Accessibilité et rendu** : axe-core dans les tests Playwright ; captures de référence en français et en arabe.
