# Adaptateur RPC du client web

`@socle/web` fournit pour l’instant une source de données en ligne pour les vues génériques. Il ne fournit pas encore l’application web complète, son écran de connexion, le chargement des métadonnées ni une réplique hors ligne.

## Brancher les vues

L’application fournit le `ModelRegistry` correspondant aux modules installés et attend la connexion avant de monter les vues. Les métadonnées locales ne donnent aucun droit : le serveur applique ses ACL, ses règles d’enregistrement et ses contrôles de champs à chaque RPC.

```ts
import type { ModelRegistry } from '@socle/framework';
import type { ViewContext } from '@socle/view-engine/data-source';
import { connectRpcDataSource } from '@socle/web';

async function connectViews(registry: ModelRegistry, signal: AbortSignal) {
  const data = await connectRpcDataSource({ registry, language: 'fr', signal });
  const context: ViewContext = {
    registry,
    data,
    language: 'fr',
    timeZone: 'Africa/Algiers',
    density: 'comfortable',
  };

  // Passer context au ViewEngineProvider lorsque la connexion est prête.
  return { context, dispose: () => data.dispose() };
}
```

La page et l’API doivent partager la même origine. La factory appelle `GET /auth/session`, puis les routes relatives `/rpc/:model/:method`. Le navigateur gère le cookie de session `HttpOnly` ; l’adaptateur conserve seulement le jeton CSRF en mémoire et le joint aux RPC, y compris aux lectures en POST. Aucun jeton n’est persisté ni exposé par l’API publique de la source. L’option `fetch` est injectable pour les tests.

Le sous-chemin public `@socle/view-engine/data-source` expose les contrats de données et `WriteFailure` sans charger React ni les feuilles de style. L’adaptateur réutilise la version de Zod déjà présente dans le workspace, sous licence MIT, pour valider les entrées et réponses externes.

## Durée de vie et erreurs

Après une connexion, un renouvellement de session, un changement d’utilisateur ou de société, fermer l’ancienne source avec `dispose()`, démonter ses vues puis créer une nouvelle source et de nouvelles vues. Un `AbortSignal` permet aussi d’annuler une connexion encore en cours et de fermer la source ensuite. Une navigation entre liste et fiche peut garder la même source lorsque le contexte reste identique ; la fermeture à chaque navigation dépend du cycle de vie choisi par l’application.

`dispose()` annule les requêtes en attente, efface le jeton CSRF et refuse les réponses tardives. Une réponse `401` ou une erreur CSRF ferme également la source. L’adaptateur ne renouvelle pas automatiquement la session et ne rejoue aucune requête sous une nouvelle identité.

Les échecs sont des `RpcDataError`, avec un `code` stable, le statut lors d’une erreur HTTP et un message sûr en français, anglais ou arabe. Ils sont compatibles avec `WriteFailure` pour l’affichage dans les formulaires. Les messages techniques du serveur ne sont pas affichés et aucun détail d’erreur par champ n’est inventé : le protocole RPC actuel n’en fournit pas.

Abandonner une requête n’annule pas un commit déjà accepté par le serveur. Après une écriture dont le résultat est incertain, établir une nouvelle connexion et relire l’enregistrement avant de décider de réessayer. Il n’y a ni reprise automatique des écritures, ni file d’attente hors ligne.

## Contrat des opérations

- `read` normalise les identifiants UUID en minuscules, les déduplique, les découpe en lots de 1 000 et restitue les résultats dans l’ordre demandé. Une erreur reste une erreur ; elle n’est pas transformée en liste vide.
- `search` utilise deux RPC, `searchRead` et `searchCount`. Le total et la page ne constituent donc pas un instantané atomique : des modifications concurrentes peuvent les décaler.
- `displayNames` utilise un champ texte `name`, sinon `code`, seulement s’il n’est ni sensible ni restreint par un groupe ; sinon il affiche l’identifiant.
- `write` transmet les valeurs d’un seul enregistrement et attend l’accusé `{ ok: true }`. La relecture des valeurs normalisées ou calculées après sauvegarde relève du formulaire.

Les lectures ne restituent que les champs demandés. Les réponses mal formées, les identifiants dupliqués ou non sollicités sont rejetés.

## Vérifier le branchement

Depuis la racine du dépôt, avec les dépendances installées :

```sh
pnpm --filter @socle/web typecheck
pnpm --filter @socle/web test
pnpm --filter @socle/acceptance exec vitest run src/web-rpc.test.ts
```

La dernière commande exige Docker et utilise PostgreSQL réel avec le serveur Fastify. Elle vérifie le contrat RPC et les transitions de session ; elle ne valide pas encore une navigation dans une application web complète.

Avant de terminer un changement, exécuter aussi les contrôles du dépôt décrits dans [CONTRIBUTING.md](../../CONTRIBUTING.md), notamment `pnpm typecheck`, `pnpm lint` et `pnpm test`.
