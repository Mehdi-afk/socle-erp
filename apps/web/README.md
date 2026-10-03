# Connexion du client web

Le client web propose la connexion, la restauration de session et une navigation entre les listes et fiches autorisées. Il charge les métadonnées du serveur et sauvegarde les modifications via les RPC existants. Ce premier parcours fonctionne en ligne ; le raccordement à la réplique chiffrée reste à livrer.

## Lancer et essayer le client

Depuis la racine du dépôt, avec Node 24, les dépendances installées et Docker disponible :

```sh
pnpm --filter @socle/acceptance exec playwright install chromium
pnpm --filter @socle/acceptance demo:web
```

La commande lance PostgreSQL temporaire, installe le vrai module `base`, puis démarre Fastify et Vite sur des ports locaux. Ouvrir l’URL `http://localhost:…` affichée. Les comptes **publics et factices**, `manager@demo.test` et `reader@demo.test`, utilisent `public-web-demo-password`. Le premier peut modifier les contacts, le second peut seulement les consulter. Choisir « Contact », ouvrir « Atelier Atlas », modifier une carte, enregistrer, revenir à la liste puis recharger la page : la valeur reste sauvegardée dans PostgreSQL. Appuyer sur **Entrée** dans le terminal pour fermer les services et supprimer ces données temporaires, y compris sous Windows.

Pour une API de développement déjà disponible sur `http://127.0.0.1:8069`, `pnpm --filter @socle/web dev` utilise les proxys `/auth/`, `/web/metadata` et `/rpc/`. Configurer côté API le tenant et l’origine exacte du navigateur. Vite ne lit aucun fichier `.env` et ne modifie ni les cookies, ni le jeton CSRF, ni l’en-tête `Origin`. Le harness de démonstration fixe le tenant à ses seules données factices ; il ne constitue pas un proxy de production.

`pnpm --filter @socle/web build` produit les fichiers statiques dans `apps/web/dist`. En déploiement, servir ces fichiers et l’API derrière la même origine HTTPS, avec repli SPA pour `/login`. Les en-têtes HTML, notamment la CSP, doivent être définis par ce serveur statique : la CSP restrictive des réponses API ne sert pas de politique à la page. Le serveur statique de production n’est pas livré par ce lot. Le build et son budget initial de 300 Kio gzip, hors polices, sont vérifiés par les tests.

## Connexion et navigation

- Mot de passe, vérification TOTP, code de secours, code par e-mail et passkey : seules les méthodes annoncées pour le défi sont proposées. L’inscription MFA propose TOTP et l’e-mail lorsqu’il est disponible. La clé TOTP est ajoutée manuellement à l’application d’authentification ; les dix codes de secours doivent être conservés avant de poursuivre.
- Les fournisseurs OIDC configurés sont chargés publiquement. Aucun bouton SSO n’est inventé. Le callback retire immédiatement le défi de l’adresse avant toute restauration de session ; un callback MFA ne restaure pas l’éventuelle ancienne identité.
- Les entrées de navigation proviennent des vues listes accessibles du catalogue, avec leurs libellés traduits. Une ligne ouvre sa fiche si une vue formulaire existe. Le fil d’Ariane conserve une pile en mémoire ; le retour à la liste recharge ses données. Le tri, la sélection et le défilement de cette liste ne sont pas conservés après son démontage.
- Une carte simplement ouverte n’est pas un brouillon modifié. Une valeur différente, même invalide, protège la navigation et la déconnexion par un dialogue d’abandon. Les transitions sont bloquées pendant l’enregistrement. Le rechargement ou la fermeture de l’onglet utilise l’avertissement natif du navigateur quand il est disponible ; il n’assure pas la conservation d’une page fermée par le système mobile ([limites de `beforeunload`](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event)).
- Une réponse 401 ou un refus CSRF démonte les vues et ferme l’ancienne source avant la reconnexion. La déconnexion révoque la session serveur ; la fiche devient inerte pendant cet appel et une expiration concurrente ne permet pas de reconnecter une autre identité avant sa fin. Un échec n’est pas silencieusement interprété comme une déconnexion réussie.

Les préférences de thème, densité et langue restent locales à cette instance de page : hybride, confortable et français au départ, avec anglais et arabe RTL. Le fuseau d’affichage vient du navigateur en attendant le profil utilisateur. Les valeurs métier utilisent les traductions du module, avec le repli prévu par le moteur. Aucune identité humaine n’est déduite d’un identifiant technique.

### Édition dans une liste

Sélectionner une seule ligne puis **Modifier la ligne**, ou placer le focus sur sa ligne et presser **F2**. Les champs scalaires autorisés deviennent des contrôles dans les cellules : texte court, nombres, montants dans la devise existante, dates, choix et booléens. Les relations, textes longs, champs calculés, sensibles ou en lecture seule restent consultables ; leur édition passe par la fiche lorsqu’elle est disponible. Le serveur applique à nouveau ses droits et contraintes à la sauvegarde.

**Enregistrer**, **Entrée** depuis une cellule ou **Ctrl/Cmd+S** soumettent uniquement les valeurs modifiées. **Annuler** ou **Échap** annulent le brouillon sans écrire. Une seule ligne est éditée à la fois ; le tri, la sélection et l’ouverture d’une ligne sont suspendus jusqu’à la fermeture de cet éditeur. Le brouillon reste en mémoire si le défilement virtuel masque sa ligne. Navigation et déconnexion utilisent la même protection des modifications que les fiches.

Une erreur de validation conserve les saisies et place le focus sur le champ concerné. Après une écriture acceptée, la liste est relue pour recalculer l’ordre, le filtre et le total. Si cette lecture échoue, **Réessayer** relance seulement la lecture : la sauvegarde acceptée n’est pas répétée. Après une panne d’écriture dont l’issue est incertaine, reconnecter et relire avant toute nouvelle tentative. Aucun brouillon ne survit au rechargement de la page.

Reproduire : `pnpm --filter @socle/acceptance demo:web`, compte factice gestionnaire, **Contact**, cocher une ligne, **Modifier la ligne**, changer le nom et enregistrer. Le test `pnpm --filter @socle/acceptance test:browser -t "edits a list row"` couvre aussi le refus des champs obligatoires, les brouillons, PostgreSQL, le compte lecteur, l’arabe mobile et axe.

Les menus et actions métier, le choix de société, l’authentification initiale par passkey, son inscription, la récupération de mot de passe, les autres types de vues et la navigation partageable par URL restent à livrer. Les actions sans gestionnaire sont désactivées ; les champs sensibles restent masqués sans gestionnaire de révélation. Ce parcours ne présente pas d’état de synchronisation fictif.

Le sous-chemin `@socle/web/auth` expose le transport d’authentification navigateur et nécessite les types DOM. La racine `@socle/web` conserve le transport de données utilisable sans charger React, CSS ou WebAuthn dans les consommateurs Node.

## Conversations et calendrier

Avec le module `mail` installé, les vues contenant un nœud `chatter` affichent le fil et les activités personnelles. Les boutons **Notifications** et **Mes activités** ouvrent la boîte de notifications et le calendrier des échéances, avec semaine, mois et filtre par type. Un événement ouvre sa fiche en passant par la protection des brouillons.

Le transport `/mail/` partage la source, la session et le CSRF des RPC. Les messages restent du texte, les notes internes et les opérations d’écriture sont autorisées par le serveur. Les brouillons restent en mémoire lors d’un changement d’onglet ; une publication acceptée les efface avant la relecture. L’interface ne rejoue pas une mutation après une panne réseau.

Ce premier lot ne fournit pas d’envoi d’e-mails, de rappels, de pièces jointes dans le fil ni de synchronisation hors ligne. Les activités sont assignées à soi-même, à la journée. Voir [le module mail](../../modules/mail/README.md) pour les plafonds, les contrôles d’accès et le traitement RGPD. La démonstration `demo:web` installe également ce module ; le proxy de développement doit transmettre `/mail/` vers la même API.

## Brancher les vues

L’application attend `connectWebClient()` avant de monter les vues. La connexion fournit un `ModelCatalog` sans code de module, un catalogue de vues et la source de données. Ces métadonnées ne donnent aucun droit : le serveur applique ses ACL, ses règles d’enregistrement et ses contrôles de champs à chaque RPC.

```ts
import type { ViewContext } from '@socle/view-engine/data-source';
import { connectWebClient } from '@socle/web';

async function connectViews(signal: AbortSignal) {
  const client = await connectWebClient({ language: 'fr', signal });
  const context: ViewContext = {
    registry: client.registry,
    data: client.data,
    language: 'fr',
    timeZone: 'Africa/Algiers',
    density: 'comfortable',
  };

  // Passer context au ViewEngineProvider lorsque la connexion est prête.
  return { context, views: client.views, dispose: () => client.dispose() };
}
```

La page et l’API doivent partager la même origine. La factory appelle une fois `GET /auth/session`, puis `POST /web/metadata` avec un corps vide `{}`. Ce second appel et les routes relatives `/rpc/:model/:method` utilisent le même jeton CSRF. Une identité différente dans la réponse de métadonnées fait échouer la connexion. Le navigateur gère le cookie de session `HttpOnly` ; seul le jeton CSRF reste en mémoire. Aucun jeton n’est persisté ni exposé par l’API publique. L’option `fetch` est injectable pour les tests.

`connectRpcDataSource({ registry, ...options })` reste disponible quand l’application possède déjà son catalogue. Il accepte aussi les registres ORM existants, qui satisfont structurellement le contrat `ModelCatalog`.

Le sous-chemin public `@socle/view-engine/data-source` expose les contrats de données et `WriteFailure` sans charger React ni les feuilles de style. L’adaptateur réutilise la version de Zod déjà présente dans le workspace, sous licence MIT, pour valider les entrées et réponses externes.

## Métadonnées reçues

Le serveur conserve les vues composées lors du chargement des modules et produit un instantané versionné pour chaque requête authentifiée. Il ne partage pas une projection entre utilisateurs. Le client valide le format, les références et les limites avant de construire ses catalogues.

- Seuls les modèles concrets autorisés en lecture et leurs champs visibles sont publiés. Les relations dont la cible ou une dépendance indispensable est masquée sont retirées.
- Les champs calculés, liés ou non stockés sont en lecture seule. L’absence de droit global d’écriture rend aussi les champs non éditables. Le tri et la recherche utilisent l’indicateur de stockage explicite.
- Les vues `form` et `list` sont filtrées par groupes, y compris leur racine et leurs sous-vues relationnelles. Les références d’en-tête cachées ou sensibles sont retirées. Seuls les attributs pris en charge par le moteur sont conservés.
- Les capacités `create`, `write` et `unlink` décrivent les ACL globales. Elles ne préjugent jamais des droits sur un enregistrement.
- Aucun corps de méthode, nom de calcul, valeur par défaut, contrainte ou règle d’enregistrement ne traverse ce protocole. Les labels multilingues sont conservés ; les menus et les autres types de vues ne font pas encore partie de cette version.

Les boutons de vue conservent leurs métadonnées d’affichage. Leur exécution métier dépend d’un gestionnaire d’actions que cette connexion ne fournit pas ; le moteur les désactive en son absence.

## Durée de vie et erreurs

Après une connexion, un renouvellement de session, un changement d’utilisateur ou de société, fermer l’ancienne source avec `dispose()`, démonter ses vues puis créer une nouvelle source et de nouvelles vues. Un `AbortSignal` permet aussi d’annuler une connexion encore en cours et de fermer la source ensuite. Une navigation entre liste et fiche peut garder la même source lorsque le contexte reste identique ; la fermeture à chaque navigation dépend du cycle de vie choisi par l’application.

`dispose()` annule les requêtes en attente, efface le jeton CSRF et refuse les réponses tardives. Une réponse `401` ou une erreur CSRF ferme également la source. L’adaptateur ne renouvelle pas automatiquement la session et ne rejoue aucune requête sous une nouvelle identité.

Les échecs sont des `RpcDataError`, avec un `code` stable, le statut lors d’une erreur HTTP et un message sûr en français, anglais ou arabe. Ils sont compatibles avec `WriteFailure` pour l’affichage dans les formulaires. Les messages techniques du serveur ne sont pas affichés et aucun détail d’erreur par champ n’est inventé : le protocole RPC actuel n’en fournit pas.

Abandonner une requête n’annule pas un commit déjà accepté par le serveur. Après une écriture dont le résultat est incertain, établir une nouvelle connexion et relire l’enregistrement avant de décider de réessayer. Il n’y a ni reprise automatique des écritures, ni file d’attente hors ligne.

## Contrat des opérations

- `read` normalise les identifiants UUID en minuscules, les déduplique, les découpe en lots de 1 000 et restitue les résultats dans l’ordre demandé. Une erreur reste une erreur ; elle n’est pas transformée en liste vide.
- `search` utilise deux RPC, `searchRead` et `searchCount`. Le total et la page ne constituent donc pas un instantané atomique : des modifications concurrentes peuvent les décaler.
- `displayNames` utilise un champ texte `name`, sinon `code`, s’il est visible dans le catalogue et non sensible ; sinon il affiche l’identifiant. Avec un registre ORM fourni directement, les champs restreints par groupe sont également écartés, car cette source ne connaît pas les groupes de la session.
- `write` transmet les valeurs d’un seul enregistrement et attend l’accusé `{ ok: true }`. La relecture des valeurs normalisées ou calculées après sauvegarde relève du formulaire.

Les lectures ne restituent que les champs demandés. Les réponses mal formées, les identifiants dupliqués ou non sollicités sont rejetés.

## Vérifier le branchement

Depuis la racine du dépôt, avec les dépendances installées :

```sh
pnpm --filter @socle/web typecheck
pnpm --filter @socle/web test
pnpm --filter @socle/acceptance exec vitest run src/web-rpc.test.ts
pnpm --filter @socle/acceptance exec vitest run src/web-metadata.test.ts
pnpm --filter @socle/acceptance test:browser
```

Les commandes acceptance exigent Docker et utilisent PostgreSQL réel avec Fastify. La suite `test:browser` ajoute Chromium, le vrai client React et les cookies natifs : sauvegarde puis rechargement, déconnexion, protection des brouillons, compte lecteur, expiration active, mobile arabe et axe. Elle s’exécute aussi en CI. Les tests DOM couvrent les étapes MFA et les réponses tardives ; une cérémonie passkey réelle et un fournisseur OIDC externe ne sont pas exercés par cette fixture.

Avant de terminer un changement, exécuter aussi les contrôles du dépôt décrits dans [CONTRIBUTING.md](../../CONTRIBUTING.md), notamment `pnpm typecheck`, `pnpm lint` et `pnpm test`.
