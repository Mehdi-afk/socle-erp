# ADR 002 — Une base PostgreSQL par client

- **Statut** : accepté
- **Date** : 2026-09-28
- **Décideur** : Messaoudene Mehdi
- **Sections d'`ARCHITECTURE.md` concernées** : §0 (D1), §2.4, §3, §9.3

## Contexte

Le produit est distribué en SaaS **et** en auto-hébergement (D1) avec une image identique. Les clients exigent isolation, export complet de leurs données et, en Algérie, la possibilité de garder les données dans le pays (loi 25-11). Les modules installés diffèrent d'un client à l'autre, donc le schéma aussi.

## Options envisagées

| Option | Avantages | Inconvénients |
|---|---|---|
| **Une base par client** (modèle Odoo) | Isolation forte ; schéma propre à chaque client (modules différents) ; sauvegarde, restauration et export par client ; auto-hébergement = cas particulier à 1 client | Nombre de connexions, migrations à orchestrer base par base |
| Schéma par client dans une base partagée | Moins de bases | Isolation moindre ; sauvegarde par client plus complexe |
| Tables partagées + `tenant_id` + RLS | Économique à grande échelle | Une erreur de filtre = fuite inter-clients ; schéma unique incompatible avec des modules par client |

## Décision

**Une base PostgreSQL 18 par client**, résolue par sous-domaine, avec un **pool de connexions par base**.

## Conséquences

- Positives : isolation par construction ; export et restauration simples ; même fonctionnement en SaaS et en auto-hébergé.
- Négatives / dette acceptée : orchestration des migrations sur N bases (CLI `socle`, file pg-boss) ; surveillance du nombre de connexions (PgBouncer à évaluer au-delà de quelques centaines de clients).
- Sécurité : tests automatisés d'isolation croisée obligatoires (critère de la phase 1) ; RLS conservée en défense en profondeur **à l'intérieur** d'une base (utilisateurs, sociétés).
- Mise à jour d'`ARCHITECTURE.md` nécessaire : non.

## Références

- `ARCHITECTURE.md` §0 (D1), §9.3 (multi-client).
