# ADR 008 — Dependabot au lieu de Renovate

- **Statut** : accepté
- **Date** : 2026-09-28
- **Décideur** : Messaoudene Mehdi
- **Sections d'`ARCHITECTURE.md` concernées** : §9.4 (« Renovate groupé et temporisé »)

> Numérotation : le numéro 007 est réservé au spike de chiffrement SQLite demandé en phase 1.

## Contexte

`ARCHITECTURE.md` §9.4 prévoit Renovate pour les mises à jour de dépendances. Renovate nécessite l'installation d'une application tierce (Mend Renovate) sur le compte GitHub. Le mainteneur souhaite que tout soit, dans la mesure du possible, développé dans le projet ou natif, sans outil externe.

## Options envisagées

| Option | Avantages | Inconvénients |
|---|---|---|
| **Dependabot** | Natif GitHub, rien à installer ; délai minimal (`cooldown`) ; regroupement ; alertes de sécurité déjà actives | Configuration moins riche que Renovate ; prise en charge des lockfiles des toutes dernières versions de pnpm à surveiller |
| Renovate (application Mend) | Très configurable, `minimumReleaseAge`, `lockFileMaintenance` | Application tierce avec droits d'écriture sur le dépôt |
| Renovate auto-hébergé (GitHub Action) | Pas d'application tierce | Jeton à privilèges à gérer, maintenance d'un workflow de plus |

## Décision

**Dependabot** (`.github/dependabot.yml`) : mises à jour hebdomadaires, regroupées (npm non majeures ; actions GitHub), **cooldown de 7 jours**, TypeScript bloqué sous 6.1. `renovate.json` est supprimé.

## Conséquences

- Positives : aucune application tierce ; un seul outil pour les alertes et les mises à jour.
- Négatives / dette acceptée : pas d'équivalent de `lockFileMaintenance` ; si Dependabot ne sait pas mettre à jour le lockfile de pnpm 12, ses PR échoueront en CI (`--frozen-lockfile`) et seront traitées à la main.
- Sécurité : la barrière `minimumReleaseAge` de pnpm reste la protection principale, indépendamment de l'outil de mise à jour ; les actions restent épinglées par SHA.
- Mise à jour d'`ARCHITECTURE.md` nécessaire : oui, §9.4 et §9.2 (fait dans la même PR).

## Références

- `.github/dependabot.yml` ; décision du mainteneur du 2026-09-28.
