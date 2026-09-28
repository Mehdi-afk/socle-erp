# ADR 014 — Paquet `@socle/runtime` : modules et clients à l'exécution

- **Statut** : accepté (mainteneur, 2026-09-28)
- **Date** : 2026-09-28
- **Décideur** : Messaoudene Mehdi
- **Sections d'`ARCHITECTURE.md` concernées** : §3.2 (structure du monorepo), §4.4 (construction du registre)

## Contexte

Trois programmes ont besoin de la même chose : **le serveur**, **le worker** (tâches de fond : analyse antivirus, tâches planifiées, emails) et **la CLI**. Pour chaque client, il leur faut :
- sa base de données ;
- ses modules installés ;
- le registre et la politique de sécurité composés à partir de ces modules.

Jusqu'ici, seule la CLI savait charger les modules depuis le disque. Le serveur recevait un registre préparé par l'appelant.

## Options envisagées

| Option | Avantages | Inconvénients |
|---|---|---|
| Le serveur et le worker dépendent de `apps/cli` | Rien à déplacer | Une application qui dépend d'une autre : couplage à l'envers, la CLI n'est pas une bibliothèque |
| Dupliquer le chargement dans chaque application | — | Trois copies qui divergeront |
| **Un paquet `packages/runtime`** partagé | Une seule implémentation, testée une fois | Un paquet de plus |

## Décision

Créer **`@socle/runtime`**, réservé à Node (jamais chargé dans le navigateur). Il contient :
- le **chargeur de modules** depuis le disque, déplacé depuis la CLI ;
- `compose` et `moduleData` : registre, politique de sécurité et données d'un ensemble de modules ;
- les **clients** :
  - nom ↔ base (`acme-sarl` ↔ `socle_acme_sarl`) ;
  - `listTenants` (les clients d'un serveur PostgreSQL) ;
  - `createTenantSource`, qui retrouve la base d'un client et ses modules installés, et compose une seule fois chaque ensemble distinct de modules.

`@socle/framework` reste isomorphe : il ne lit jamais le disque.

## Conséquences

- La CLI, le serveur (point d'entrée de production, lot 2.9) et le worker (lot 2.1) utilisent `@socle/runtime`.
- `ARCHITECTURE.md` §3.2 est à compléter avec la ligne `runtime/`.
- La règle ESLint sur les chemins de fichiers non littéraux est désactivée pour ce paquet, pour les mêmes raisons que la CLI : les chemins viennent de la configuration de l'opérateur et sont confinés dans le code, avec des tests.
