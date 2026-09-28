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
| `data/*.ts` | `defineData(modèle, enregistrements)` ou un tableau de ceux-ci : chargés à l'installation, mis à jour à chaque mise à jour du module (sauf `{ noupdate: true }`) ; références par `ref('module.id')` |
| `demo/*.ts` | même format, chargé **uniquement** avec `socle module install <client> <module> --demo` |

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

## Données de module

Chaque enregistrement porte un identifiant local (`fr`), qui devient un identifiant externe stable (`base.fr`). À l'installation, l'enregistrement est créé. À chaque mise à jour, il est remis à jour, ou recréé s'il a été supprimé ; les enregistrements `noupdate` sont laissés tels que l'administrateur les a modifiés. À la désinstallation, les enregistrements qu'un module a ajoutés aux modèles d'autres modules sont supprimés.

## Règles d'enregistrement sur un mixin

Une règle déclarée sur un modèle abstrait (par exemple la règle « société autorisée » sur `company.scoped`) s'applique à **tous** les modèles qui l'utilisent comme mixin : même règle dans l'ORM et dans la sécurité au niveau des lignes de PostgreSQL.
