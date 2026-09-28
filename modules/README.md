# Modules community

Modules LGPL de Socle ERP (`base`, `web`, `contacts`, `sale`…). Anatomie d'un module : `docs/ARCHITECTURE.md` §3.3. Premier module : phase 2.

## Créer un module

```sh
node apps/cli/bin/socle.mjs scaffold module mon_module
pnpm install
```

Le squelette s'installe tel quel : un modèle, ses droits, une vue formulaire, une vue liste et un test.

## Ce que la CLI charge

Chaque fichier exporte **par défaut** ce que son emplacement contient :

| Emplacement | Export par défaut |
|---|---|
| `manifest.ts` | `defineManifest({...})` |
| `models/*.ts` | une définition (`defineModel`) ou une extension (`extendModel`), ou un tableau de celles-ci |
| `views/*.ts` | une vue (`defineView`) ou une extension (`extendView`), ou un tableau de celles-ci |
| `security/groups.ts`, `access.ts`, `rules.ts` | un tableau de groupes, de droits d'accès ou de règles d'enregistrement |
| `migrations/<version>/pre.ts`, `post.ts` | une fonction `async (context) => {}` (`MigrationContext` de `@socle/orm-pg`) |

Règles de chargement :

- Les fichiers `*.test.ts` sont ignorés, de même que tout ce qui n'est pas dans un de ces emplacements (`tests/`, `README.md`…).
- Un lien symbolique qui sort du dossier des modules est refusé.

## Installer sur un client (tenant)

```sh
export SOCLE_DATABASE_URL=postgres://…/postgres   # jamais commité (.env ignoré)
node apps/cli/bin/socle.mjs db create acme
node apps/cli/bin/socle.mjs module install acme mon_module
node apps/cli/bin/socle.mjs help
```
