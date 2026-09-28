# ADR 010 — PostgreSQL de test : utilitaire maison au lieu de Testcontainers

- **Statut** : accepté
- **Date** : 2026-09-28
- **Décideur** : Messaoudene Mehdi
- **Sections d'`ARCHITECTURE.md` concernées** : §2.4 (ligne « Tests »), §9.4

## Contexte

`ARCHITECTURE.md` §2.4 prévoit **Testcontainers** pour les tests d'intégration sur un PostgreSQL réel. À l'installation (point 4 de la phase 1), `@testcontainers/postgresql` et `testcontainers` 12.1 ont tiré **environ 130 paquets transitifs** (dockerode, docker-modem, ssh2, protobufjs, tar-fs…). Tout cela sert uniquement à lancer un conteneur `postgres` pendant les tests. Le constat, vérifié le 2026-09-28 :

- trois paquets demandent un script d'installation (`ssh2`, `cpu-features`, `protobufjs`) ;
- cinq paquets ont une licence hors de la liste autorisée : `tweetnacl` (Unlicense) et quatre paquets BlueOak-1.0.0 ;
- la surface de chaîne d'approvisionnement (§9.4) grossit fortement pour un besoin minime.

La consigne du propriétaire est aussi de tout développer dans le projet quand c'est raisonnable.

## Options envisagées

| Option | Avantages | Inconvénients |
|---|---|---|
| Testcontainers | Conforme à §2.4 tel quel ; outil connu | ~130 paquets ; exceptions de licence (Unlicense, BlueOak) ; scripts d'installation à refuser un par un |
| **Utilitaire maison** (`@socle/testing`, `startPostgres()`) qui pilote la commande `docker` | Zéro dépendance ; environ 130 lignes lisibles ; image épinglée par digest | Code à maintenir ; ne gère que PostgreSQL (seul besoin actuel) |
| Service PostgreSQL de la CI (`services:` GitHub Actions) | Rien à coder pour la CI | Rien en local ; configuration différente entre la CI et le poste |

## Décision

**Utilitaire maison**, dans `packages/testing/src/postgres.ts`. `startPostgres()` fait quatre choses :

1. Il exécute `docker run` avec `execFile`, sans shell, donc sans injection possible. L'image est `postgres:18.6-alpine` épinglée **par digest**. Le port est aléatoire et lié à `127.0.0.1` uniquement. Le mot de passe est aléatoire. Les données sont en `tmpfs`, avec `fsync` désactivé.
2. Il attend que le serveur final accepte les connexions TCP. L'image lance d'abord un serveur temporaire sur le socket Unix, puis redémarre : c'est pourquoi on sonde en TCP.
3. Il échoue bruyamment si Docker est absent. Un test d'intégration n'est **jamais** ignoré en silence.
4. Il supprime le conteneur à la fin. En cas de crash, `--rm` et l'étiquette `socle.test=postgres` permettent de retrouver les restes.

Chaque fichier de test démarre son serveur. Chaque test crée sa propre base, via `useTestDatabases()` dans `@socle/orm-pg`. La variable `DOCKER_BIN` permet d'indiquer le chemin de l'exécutable `docker`.

## Conséquences

- `ARCHITECTURE.md` §2.4 : la ligne « Tests » cite désormais l'utilitaire maison (ADR 010) au lieu de Testcontainers.
- Mettre à jour l'image demande de changer le tag et le digest dans `POSTGRES_IMAGE`. Un test vérifie que le digest est bien présent.
- Si un autre service devient nécessaire en test (MinIO, Gotenberg…), on étend le même utilitaire, ou on réévalue Testcontainers par un nouvel ADR.
