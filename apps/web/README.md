# Connexion du client web

`@socle/web` charge les métadonnées autorisées pour la session et fournit une source de données en ligne pour les vues génériques. L’application web complète, son écran de connexion et le raccordement à la réplique hors ligne restent à construire.

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

Les boutons de vue conservent leurs métadonnées d’affichage. Leur exécution métier dépend d’un gestionnaire d’actions que cette connexion ne fournit pas.

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
```

Les deux dernières commandes exigent Docker et utilisent PostgreSQL réel avec le serveur Fastify. Elles vérifient le catalogue filtré, le contrat RPC et les transitions de session ; elles ne valident pas encore une navigation dans une application web complète.

Avant de terminer un changement, exécuter aussi les contrôles du dépôt décrits dans [CONTRIBUTING.md](../../CONTRIBUTING.md), notamment `pnpm typecheck`, `pnpm lint` et `pnpm test`.
