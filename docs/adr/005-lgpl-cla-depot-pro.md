# ADR 005 — LGPL-3.0 pour le cœur, CLA et dépôt Pro séparé

- **Statut** : accepté (textes juridiques à faire valider par un juriste)
- **Date** : 2026-09-28
- **Décideur** : Messaoudene Mehdi
- **Sections d'`ARCHITECTURE.md` concernées** : §0 (D2, D3, D10), §11

## Contexte

Le modèle économique est open-core (cœur libre à 80 %, modules payants à 20 %). Les intégrateurs tiers doivent pouvoir vendre leurs propres modules propriétaires (D10), comme sur l'Odoo Apps Store. Le mainteneur veut garder la possibilité de changer de licence plus tard.

## Options envisagées

| Option | Avantages | Inconvénients |
|---|---|---|
| **LGPL-3.0-only** (comme Odoo Community) | Modules propriétaires autorisés par la licence elle-même ; adoption facilitée | Un concurrent peut vendre le cœur modifié en SaaS sans publier ses modifications |
| AGPL-3.0 | Protège contre le SaaS concurrent | Modules propriétaires impossibles sans exception rédigée ; souvent banni en entreprise |
| MIT / Apache-2.0 | Adoption maximale | Aucune obligation de reverser les modifications du cœur |
| Licence « source-available » (BSL, FSL) | Protection commerciale | Pas open source ; rejet par la communauté |

## Décision

- Cœur sous **LGPL-3.0-only** (`LICENSE` + `COPYING` pour le texte GPL-3.0 auquel elle renvoie).
- Modules Pro sous licence propriétaire **`LicenseRef-Socle-Pro`**, dans le **dépôt privé séparé** `Mehdi-afk/socle-erp-pro`, qui consomme le cœur comme dépendance versionnée (sous-module Git épinglé sur un tag pendant le développement).
- **CLA** obligatoire pour les contributions externes (`CLA.md`), qui autorise le relicenciement par le mainteneur. Le contrôle est **développé dans le projet** (workflow `cla.yml`, signatures dans la branche `cla-signatures`), sans service tiers, à la demande du mainteneur.
- En-têtes **SPDX** obligatoires, vérifiés en local et en CI.

## Conséquences

- Positives : écosystème de modules tiers possible sans rien rédiger de plus ; image rassurante pour les intégrateurs et les grands comptes.
- Négatives / dette acceptée : pas de protection contre un SaaS concurrent ; la protection commerciale repose sur la marque, la marketplace, les modules Pro, la conformité à jour et le SaaS.
- Obligation de **remplaçabilité du cœur** : paquets `@socle/*` séparés des modules ; côté navigateur, un bundle par module (ou reconstruction documentée), jamais un bundle mélangeant le cœur et du code propriétaire.
- Licences des dépendances du cœur : MIT, BSD, ISC, Apache-2.0, MPL-2.0, LGPL uniquement ; GPL/AGPL seulement en service séparé ; contrôle `check:licenses` en CI (exceptions justifiées dans `scripts/license-exceptions.json`).
- Mise à jour d'`ARCHITECTURE.md` nécessaire : non.

## Références

- `ARCHITECTURE.md` §11 ; `CLA.md` et `LICENSE-PRO.md` (marqués « À faire valider par un juriste »).
