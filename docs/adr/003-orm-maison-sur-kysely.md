# ADR 003 — ORM maison piloté par métadonnées, sur Kysely

- **Statut** : accepté
- **Date** : 2026-09-28
- **Décideur** : Messaoudene Mehdi
- **Sections d'`ARCHITECTURE.md` concernées** : §2.4, §4

## Contexte

Les modules ajoutent des modèles et des champs **à l'installation** (`defineModel`, `extendModel`) ; le schéma n'est donc connu qu'à l'exécution, et diffère d'un client à l'autre. Le même modèle doit fonctionner sur PostgreSQL (serveur) et sur SQLite WASM (client hors ligne). Les règles d'enregistrement doivent être compilées en `WHERE` SQL sur les deux moteurs.

## Options envisagées

| Option | Avantages | Inconvénients |
|---|---|---|
| **ORM maison sur Kysely** | Schéma dynamique ; même API sur PG et SQLite ; Kysely typé, dialecte SQLite disponible, requêtes paramétrées | Coût de développement ; maintenance à notre charge |
| Prisma | Outillage riche | Schéma statique généré au build : incompatible avec des modules installés à chaud ; moteur non isomorphe |
| Drizzle | Léger, typé | Schéma déclaré statiquement en code |
| TypeORM / MikroORM | Mûrs | Modèle par classes décorées, peu adapté à la composition dynamique ; SQLite WASM non natif |

## Décision

**ORM maison piloté par les métadonnées du registre**, qui génère ses requêtes avec **Kysely** (query builder typé) sur deux adaptateurs : `packages/orm-pg` et `packages/orm-sqlite`. Le cœur de l'ORM (`packages/framework/orm`) reste isomorphe, sans dépendance Node ni DOM.

## Conséquences

- Positives : extensibilité à la Odoo ; une seule sémantique de domaines de recherche sur les deux moteurs.
- Négatives / dette acceptée : l'ORM est le composant le plus coûteux de la phase 1 ; différentiel de schéma limité aux changements **additifs**, le reste passant par des migrations manuelles `pre`/`post`.
- Sécurité : aucun SQL brut hors du gabarit `sql` de Kysely ; tout identifiant dynamique (table, colonne) est validé contre le registre (liste blanche). Règle Semgrep `socle-no-raw-sql` active depuis la phase 0.
- Licence : Kysely est sous MIT.
- Mise à jour d'`ARCHITECTURE.md` nécessaire : non.

## Références

- `ARCHITECTURE.md` §2.4, §4.2 à §4.7.
