# Dépendances du client web et de ses tests

Le premier écran de connexion et la navigation de `apps/web` réutilisent la pile acceptée par [l’ADR 015](adr/015-pile-du-client-web.md). Les versions ci-dessous correspondent aux dépendances installées pour ce lot. Le fichier `pnpm-lock.yaml` fixe leurs versions transitives ; les contrôles de licences et de chaîne d’approvisionnement restent obligatoires.

## Code livré au navigateur

| Paquet | Version | Licence | Besoin et choix |
|---|---|---|---|
| `react`, `react-dom` | 19.3.0 | MIT | Rendu du client, déjà utilisé par `@socle/ui` et le moteur de vues. Conserver React évite un second moteur d’interface ; le client n’a pas besoin du rendu serveur de Next.js. |
| `@radix-ui/react-dialog` | 1.1.23 | MIT | Confirmation avant d’abandonner un brouillon, avec modalité, navigation clavier et restauration du focus. Réutiliser la primitive déjà choisie pour le design system évite une nouvelle implémentation du dialogue. |
| `lucide-react` | 1.47.0 | ISC | Icônes cohérentes avec le design system, sans charger une autre collection ou des images distantes. |
| `zod` | 4.6.5 | MIT | Validation des réponses d’authentification, des callbacks OIDC et des préférences. Même bibliothèque que les contrats serveur et le transport RPC ; pas de validateur supplémentaire. |
| `@socle/framework`, `@socle/ui`, `@socle/view-engine` | workspace | LGPL-3.0-only | Catalogues filtrés, composants et vues génériques existants. L’application ne recopie pas ces contrats et ne reconstruit pas de classes ORM côté navigateur. |

L’authentification utilise `fetch` et les API WebAuthn natives du navigateur. Il n’y a pas de SDK OAuth/WebAuthn ajouté, ni de bibliothèque de routage ou de stockage d’état pour la navigation locale actuelle. L’OIDC reste géré par les routes serveur. Les polices auto-hébergées viennent de `@socle/ui` ; leur licence SIL OFL 1.1 et les exceptions transitives existantes sont documentées dans l’ADR 015 et `scripts/license-exceptions.json`.

## Construction et vérification

Le module `mail` réutilise `zod` 4.6.5 (MIT), `@socle/framework` et `@socle/module-base` (LGPL-3.0-only). Le serveur référence ce nouveau paquet workspace ; aucun paquet tiers, SDK de messagerie ou bibliothèque de calendrier n’est ajouté. Les services partagent les contrats ORM et RGPD publics, les composants utilisent le design system existant et `Intl`. Les tests réutilisent Vitest, Playwright, axe et PostgreSQL déjà présents. Le verrouillage des versions et les contrôles de licences restent identiques.

| Paquet | Version | Licence | Besoin et alternative |
|---|---|---|---|
| `vite`, `@vitejs/plugin-react` | 8.3.0 / 6.1.1 | MIT | Serveur local et construction de production de l’application React. Même outil que le guide UI et la démonstration du moteur ; aucune seconde chaîne de compilation. |
| `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom` | 16.3.3 / 14.6.7 / 7.0.1 | MIT | Tests des interactions et des états asynchrones via les contrôles visibles. Les assertions portent sur le comportement et l’accessibilité, sans snapshots de structure JSX. |
| `jsdom` | 30.1.1 | MIT | DOM des tests rapides de composants. Il complète les tests dans un vrai navigateur ; il ne mesure pas le contraste ni la mise en page. |
| `@types/node`, `@types/react`, `@types/react-dom` | 24.13.6 / 19.3.0 / 19.3.0 | MIT | Types stricts des scripts, tests et composants, sans code ajouté au bundle navigateur. |
| `playwright` — paquet d’acceptation | 1.63.0 | Apache-2.0 | Parcours Chromium avec cookies réels, serveur Fastify et PostgreSQL jetable. Réutilisé pour vérifier connexion, édition, navigation, expiration et rendu mobile. |
| `axe-core` — tests UI et paquet d’acceptation | 4.13.0 | MPL-2.0 | Analyse d’accessibilité existante, appelée directement. Aucun adaptateur de tests additionnel. |

Vitest reste l’exécuteur de tests du workspace. Les outils de développement ne sont pas livrés dans les assets de l’application. Leurs mises à jour passent par le processus existant : versions verrouillées, Dependabot, revue et contrôles CI ; aucune politique de chaîne d’approvisionnement n’est assouplie pour ce client.

`apps/web/src/build.test.ts` construit l’application dans un répertoire temporaire hors dépôt. Le test additionne les tailles gzip des JavaScript chargés initialement, de leurs imports statiques transitifs et des CSS associés, avec déduplication. Le budget est de **300 Kio hors polices**. Il vérifie aussi que l’espace de travail est un import dynamique distinct et qu’aucun substitut Vite de module Node n’est émis. Les avertissements de construction font échouer le test, sauf l’indication standard de Vite sur les chunks dépassant 500 Ko bruts : le budget contractuel est mesuré sur le chargement initial compressé. Le répertoire temporaire est résolu et contrôlé avant sa suppression récursive.
