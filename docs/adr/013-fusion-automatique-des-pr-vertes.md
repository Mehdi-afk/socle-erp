# ADR 013 — Fusion des PR sans relecture humaine, derrière des contrôles automatiques bloquants

- **Statut** : accepté
- **Date** : 2026-09-28
- **Décideur** : Messaoudene Mehdi
- **Sections d'`ARCHITECTURE.md` concernées** : §9.2 (ligne « Revue »)

## Contexte

L'architecture prévoyait une **relecture humaine obligatoire** des PR de Claude Code. Dans la pratique, le mainteneur n'est pas développeur. Il a décidé (phase 1, confirmé en phase 2) que Claude Code fusionne lui-même ses PR quand tous les contrôles automatiques sont verts. Le mainteneur valide le travail **à la fin de chaque phase**, sur un compte rendu technique et une version en langage simple. La documentation doit dire ce qui se passe réellement.

## Options envisagées

| Option | Avantages | Inconvénients |
|---|---|---|
| Relecture humaine de chaque PR | Un second regard sur chaque changement | Impossible sans relecteur technique disponible ; bloquerait le projet |
| Relecture humaine des seules PR sensibles (sécurité, synchro) | Compromis | Même obstacle : pas de relecteur technique |
| **Fusion automatique derrière des contrôles bloquants, validation humaine par phase** | Conforme à la réalité ; les contrôles s'appliquent à chaque PR sans exception | Aucun second regard humain ligne à ligne |

## Décision

Une PR de Claude Code est fusionnée (en *squash*) par Claude Code **uniquement** quand **tous** les contrôles requis de la règle de protection de `main` sont verts :
- types, lint et tests (unitaires, PostgreSQL réel, acceptation, propriétés) ;
- CodeQL, Semgrep, gitleaks, OSV-Scanner ;
- licences et en-têtes SPDX ;
- rapport d'API.

Les alertes CodeQL ne sont classées qu'avec une justification écrite. Aucun contrôle n'est désactivé pour « faire passer ». Le mainteneur valide chaque phase (« Phase validée ») sur le compte rendu.

## Conséquences

- **Positives** : le rythme du projet ne dépend pas d'un relecteur absent, et la règle est appliquée par l'outil, pas par la discipline.
- **Dette acceptée**
  - Pas de second regard humain sur chaque ligne.
  - L'alerte OpenSSF Scorecard « Code-Review » reste ouverte en connaissance de cause.
- **Mesures compensatoires**
  - Chaque correctif reçoit un test de non-régression.
  - Les tests de propriétés (fast-check) et les tests par sabotage vérifient que les tests détectent vraiment les défauts.
  - Le compte rendu de phase liste les risques et la dette.
  - **Avant la première version commerciale**, un audit de sécurité par un prestataire qualifié PASSI reste obligatoire (§9.5).
  - Si un contributeur technique rejoint le projet, la relecture humaine des PR touchant l'authentification, la synchro, la cryptographie et les droits redevient obligatoire (`CODEOWNERS`).
- **Sécurité** : la surface de risque est couverte par les contrôles automatiques et l'audit avant la première release.
- **Mise à jour d'`ARCHITECTURE.md`** : oui, §9.2.
