# CLAUDE.md — règles de travail de Claude Code sur Socle ERP

Référence unique : [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Tout écart passe d'abord par un ADR (`docs/adr/NNN-titre.md`) accepté par le mainteneur.

## Règles de travail

1. **Questions avant d'agir** : en cas d'ambiguïté, demander au lieu de deviner ; regrouper les questions en début de phase.
2. **Chirurgical** : ne modifier que ce que la tâche exige ; pas de refactoring opportuniste.
3. **Langue** : échanges en français ; code, identifiants et commits en anglais ; documentation utilisateur en français (puis EN/AR).
4. **Rapport de changements** : tenir à jour `rapport_changes_erp.xlsx` **hors dépôt** (dossier parent du clone, jamais commité) — une ligne par modification : date, phase, fichier(s), description, raison, lien PR.
5. **Aperçu avant commit** : pour toute modification d'interface ou de comportement, lancer l'application et montrer le résultat (capture ou description précise + commande de reproduction).
6. **Git** : jamais de commit direct sur `main` ; une branche par tâche (`feat/`, `fix/`, `sec/`, `docs/`, `chore/`) ; Conventional Commits ; commits signés ; une PR par lot cohérent ; fusion en *squash*. **Interdits** : `--no-verify`, `--force` sur une branche partagée, désactiver un contrôle de CI.
7. **Secrets** : ne jamais lire, afficher ni commiter un secret. Seul `.env.example` (valeurs factices) est versionné.
8. **Tests** : une tâche est terminée seulement si `pnpm typecheck && pnpm lint && pnpm test` passent. Règles métier = fonctions pures testées. Chaque bug corrigé = un test de non-régression.
9. **SPDX** en première ligne de chaque fichier source : `// SPDX-License-Identifier: LGPL-3.0-only` (cœur) ou `// SPDX-License-Identifier: LicenseRef-Socle-Pro` (Pro).
10. **Dépendances** : justifier chaque ajout (besoin, licence, maintenance, alternatives). Autorisées : MIT, BSD, ISC, Apache-2.0, MPL-2.0, LGPL. Interdites : GPL, AGPL, SSPL, BSL, FSL, Commons Clause. Un logiciel GPL/AGPL n'est admis que comme service séparé appelé par le réseau.
11. **Fin de phase** : s'arrêter, produire le compte rendu, attendre « Phase validée ».

## Règles de code sécurisé (bloquantes en revue)

- Aucun SQL brut hors du gabarit `sql` de Kysely ; noms de tables/colonnes dynamiques validés contre le registre (liste blanche).
- Validation Zod de toute entrée externe ; ordre : **CORS → rate limit → parse → validate → authN → authZ → action**.
- Refus par défaut ; aucune décision de droit uniquement côté client ; le serveur rejoue et revalide toute mutation de synchro.
- Pas d'`eval`, `new Function`, `dangerouslySetInnerHTML` sans DOMPurify, ni de désérialisation non validée.
- Chemins de fichiers normalisés et confinés (rejet de `..`, chemins absolus, liens symboliques).
- Requêtes HTTP sortantes uniquement via le client unique à liste blanche d'hôtes (anti-SSRF).
- Argent : entiers en unités mineures + code devise, jamais de `number` flottant ; taux : `decimal.js`.
- Dates : UTC en base, fuseau de l'utilisateur à l'affichage.
- Logs : jamais de mot de passe, jeton, donnée `sensitive` ou personnelle en clair (redaction pino).
- Règles fiscales = données datées, jamais des constantes codées en dur.
- `packages/framework` : aucune dépendance Node ni DOM.
- Les modules n'importent que l'API publique (`@public`) des paquets `@socle/*`, jamais un chemin interne.
- Workflows GitHub : actions épinglées par SHA, `permissions: contents: read` par défaut ; un workflow `pull_request_target` ne doit jamais exécuter le code de la PR.

## Commandes usuelles

```bash
corepack enable                 # active pnpm
pnpm install --frozen-lockfile  # installation reproductible
pnpm typecheck                  # tsc --noEmit, mode strict
pnpm lint                       # ESLint (+ règles sécurité)
pnpm test                       # Vitest
pnpm format                     # Prettier
git switch -c feat/<sujet>      # nouvelle branche de travail
gh pr create --fill             # ouvrir la PR
```
