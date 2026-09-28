# ADR 011 — Exécuter le TypeScript directement avec Node, sans étape de build

- **Statut** : accepté
- **Date** : 2026-09-28
- **Décideur** : Messaoudene Mehdi
- **Sections d'`ARCHITECTURE.md` concernées** : §2.4, §3.2 (`apps/cli`, `apps/server`)

## Contexte

Tous les paquets exposent leur **source** TypeScript (`"exports": "./src/index.ts"`) et vérifient les types sans rien produire (`noEmit`). Vitest sait exécuter ce code, mais la CLI `socle` (point 10 de la phase 1) doit tourner hors des tests, comme plus tard le serveur. Deux obstacles :

- Node 24 exécute le TypeScript en **supprimant les types**. En revanche, il n'accepte pas la syntaxe qui génère du code : propriétés-paramètres de constructeur, `enum`, `namespace`.
- Les imports relatifs sont écrits `./x.js`, comme l'exige la résolution `NodeNext` de `tsc`. Mais le fichier présent sur le disque est `./x.ts`.

## Options envisagées

| Option | Avantages | Inconvénients |
|---|---|---|
| **Node natif** + crochet de résolution maison | Aucune dépendance, aucun build ; le même code tourne en développement, en test et en production | Syntaxe limitée à ce qui s'efface (`erasableSyntaxOnly`) ; un petit fichier à maintenir |
| Build `tsc` vers `dist/` | Approche classique | Des `exports` conditionnels et une étape de build dans chaque paquet ; deux formes du code à garder alignées |
| Dépendance `tsx` (esbuild) | Rien à écrire | Outil externe de plus, avec un binaire natif ; contraire à la consigne de tout garder dans le projet |

## Décision

**Node natif.**

1. `tsconfig.base.json` active `erasableSyntaxOnly`. `tsc` refuse donc toute syntaxe que Node ne saurait pas effacer. Les quatre constructeurs à propriétés-paramètres ont été réécrits en propriétés explicites, sans changer leur comportement.
2. `apps/cli/bin/ts-hooks.mjs` enregistre un crochet de résolution synchrone (`module.registerHooks`). Quand un import relatif `./x.js` ne trouve aucun fichier, le crochet charge `./x.ts`. Les autres cas restent inchangés, et une vraie erreur de résolution reste une erreur.
3. Le point d'entrée `apps/cli/bin/socle.mjs` charge ce crochet avant tout le reste. Le serveur réutilisera le même fichier quand son point d'entrée de production sera écrit (image Docker, phase 2).

Un test lance réellement `node bin/socle.mjs` dans un processus séparé. Toute régression de ce mode d'exécution est donc détectée en CI.

## Conséquences

- Pas d'`enum`, pas de `namespace` avec du code, pas de propriétés-paramètres. On utilise des unions de chaînes et des propriétés déclarées ; le lint et `tsc` le vérifient.
- Node ne supprime pas les types dans `node_modules`. Les paquets `@socle/*` restent utilisables parce que pnpm les lie par lien symbolique vers `packages/` et que Node suit le chemin réel. Si ces paquets sont un jour publiés (GitHub Packages, dépôt Pro), il faudra une étape de build pour la publication, via un nouvel ADR.
- Pour revenir à un build, il suffit d'ajouter la compilation : le code source reste du TypeScript standard.
