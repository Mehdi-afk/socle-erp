# ADR 001 — TypeScript de bout en bout

- **Statut** : accepté
- **Date** : 2026-09-28
- **Décideur** : Messaoudene Mehdi
- **Sections d'`ARCHITECTURE.md` concernées** : §0 (D5, D7), §2

## Contexte

Socle ERP est offline-first sur **toute** l'application (D7) : la logique métier (champs calculés, contraintes, règles de droits) doit s'exécuter à la fois sur le serveur et dans le navigateur hors ligne. Il doit aussi reproduire l'extensibilité d'Odoo (composition dynamique de modèles chargés par modules).

## Options envisagées

| Option | Avantages | Inconvénients |
|---|---|---|
| **TypeScript** (Node + navigateur) | Un seul code de modèle, isomorphe ; typage strict ; stack maîtrisée ; score 84/100 (§2.2) | Chaîne d'approvisionnement npm exposée ; bibliothèques Factur-X moins mûres |
| Python (comme Odoo) | Héritage dynamique naturel ; écosystème compta mûr | Toute la logique métier à réécrire en JS pour le hors ligne |
| Java / Kotlin | Robustesse, outillage sécurité | Lourd seul ; partage client/serveur partiel |
| C#, PHP, Go | — | Hors ligne ou modularité insuffisants (§2.3) |

## Décision

**TypeScript de bout en bout** (Node.js 24 LTS côté serveur, navigateur et Tauri côté client), car c'est le seul choix qui permet d'écrire chaque règle métier **une seule fois** pour le serveur et le client hors ligne.

## Conséquences

- Positives : même définition de modèle partout ; refactorings sûrs ; un seul langage pour les contributeurs.
- Négatives / dette acceptée : chaîne d'approvisionnement npm à verrouiller ; Factur-X délégué au service Mustang en conteneur.
- Sécurité : `minimumReleaseAge` 7 jours, `trustPolicy`, `blockExoticSubdeps`, `allowBuilds`, lockfile gelé, OSV-Scanner, Dependabot temporisé (§9.4, ADR 008).
- Précision de version (phase 0) : **TypeScript 6.0.x** est épinglé, car typescript-eslint ne supporte pas encore TypeScript 7 (portage natif). Le passage à TS 7 fera l'objet d'un ADR.
- Argent en entiers d'unités mineures ; taux avec `decimal.js`.
- Mise à jour d'`ARCHITECTURE.md` nécessaire : non.

## Références

- `ARCHITECTURE.md` §2.1 à §2.4.
