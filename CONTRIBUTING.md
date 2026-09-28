# Contribuer à Socle ERP

Merci de votre intérêt ! Le projet est en phase de fondation : l'API n'est pas encore stable.

## Avant de commencer

1. Lisez [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) : c'est la référence. Toute proposition qui s'en écarte passe d'abord par un ADR (`docs/adr/NNN-titre.md`, modèle : [`000-template.md`](docs/adr/000-template.md)).
2. Pour une évolution non triviale, ouvrez d'abord une **issue** ou une **discussion**.
3. Une vulnérabilité ne se signale **jamais** publiquement : voir [`SECURITY.md`](SECURITY.md).
4. Respectez le [code de conduite](CODE_OF_CONDUCT.md).

## Accord de licence (CLA)

Toute contribution externe exige la signature du [CLA](CLA.md). Le contrôle `cla` de votre pull request vous indique la marche à suivre ; elle ne sera pas fusionnée sans signature.

## Environnement

- Node.js 24 LTS, pnpm (via `corepack enable`), Docker (tests d'intégration).
- [gitleaks](https://github.com/gitleaks/gitleaks) dans le `PATH` (Windows : `winget install Gitleaks.Gitleaks`) : les hooks lefthook, installés par `pnpm install`, l'appellent avant chaque commit.
- Commits **signés** (SSH ou GPG).

## Règles

- **Branches** : jamais de commit direct sur `main`. Une branche par tâche : `feat/…`, `fix/…`, `sec/…`, `docs/…`, `chore/…`.
- **Commits** : [Conventional Commits](https://www.conventionalcommits.org/) en anglais (`feat(orm): add many2many field`).
- **Pull requests** : une PR par lot cohérent, fusion en *squash*, checklist sécurité du modèle de PR remplie.
- **Tests** : `pnpm typecheck && pnpm lint && pnpm test` doivent passer. Chaque règle métier est une fonction pure testée ; chaque bug corrigé reçoit un test de non-régression.
- **API publique** : tout symbole exporté par un paquet `@socle/*` porte `@public` ; après un changement volontaire de l'API, lancez `pnpm api:update` et commitez le rapport `api/*.api.md` (la CI échoue sinon).
- **En-tête SPDX** en première ligne de chaque fichier source : `// SPDX-License-Identifier: LGPL-3.0-only`.
- **Dépendances** : justifiez tout ajout (besoin, licence, maintenance, alternatives). Licences admises : MIT, BSD, ISC, Apache-2.0, MPL-2.0, LGPL. **Interdites** : GPL, AGPL et licences « source-available ».
- **Langue** : code, identifiants et commits en anglais ; documentation utilisateur en français (puis EN/AR).
- Ne désactivez jamais un contrôle (hook, CI) pour « faire passer » une modification.
