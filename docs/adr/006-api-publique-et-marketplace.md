# ADR 006 — API publique et marketplace : signature, capacités, révocation

- **Statut** : accepté (implémentation en phase 1, plateforme de vente en phase 6)
- **Date** : 2026-09-28
- **Décideur** : Messaoudene Mehdi
- **Sections d'`ARCHITECTURE.md` concernées** : §0 (D10), §4.1, §11.7, §11 bis

## Contexte

Des éditeurs tiers vendront des modules qui s'exécutent **avec les mêmes droits que le cœur**. Il faut à la fois leur offrir un contrat stable et protéger les clients contre un module malveillant, modifié ou compromis, y compris hors ligne (Algérie).

## Options envisagées

| Option | Avantages | Inconvénients |
|---|---|---|
| **API publique marquée `@public` + paquets signés + capacités + révocation** | Contrat stable et vérifiable ; vérification hors ligne ; risque réduit et traçable | Outillage à construire dès la phase 1 |
| Tout le code du cœur accessible aux modules | Aucun effort | Aucun contrat : chaque version casse les modules ; surface d'attaque maximale |
| Bac à sable complet (processus ou WASM isolé) | Isolation forte | Incompatible avec l'extension de modèles par composition de classes ; coût élevé |

## Décision

1. **API publique** : chaque paquet `@socle/*` n'expose que des points d'entrée explicites (`exports`) ; tout symbole exposé porte `@public` ; **API Extractor** produit un rapport versionné (`api/*.api.md`) et la CI échoue si l'API change sans mise à jour du rapport ; SemVer strict, dépréciations annoncées une version majeure à l'avance. Une règle ESLint interdit aux modules les imports internes (en place depuis la phase 0 pour `@socle/*/src`).
2. **Manifeste** : `engines: { socle: '^x.y' }` et `capabilities` (`sudo`, `cron`, `files`, `{ network: [...] }`) obligatoires sur la marketplace, affichés à l'administrateur avant installation.
3. **Signature** : paquet signé **Ed25519** par l'éditeur puis **contresigné** par la marketplace ; clés publiques embarquées dans le cœur ; vérification **hors ligne** à l'installation et au chargement.
4. **Application des capacités à l'exécution** : réseau via le client HTTP unique à liste blanche ; `sudo`, `cron` et fichiers refusés s'ils ne sont pas déclarés.
5. **Révocation** : liste de révocation signée, consultée à chaque synchronisation ; module révoqué désactivé, administrateur prévenu.
6. **Modules non signés** : refusés, sauf option explicite d'administration en **auto-hébergement** (avertissement permanent) ; **interdits sur le SaaS**.
7. **Instantané** automatique de la base avant toute installation ou mise à jour d'un module tiers.

## Conséquences

- Positives : écosystème possible dès la V1 sans plateforme de vente ; confiance vérifiable hors ligne.
- Négatives / dette acceptée : les capacités **ne sont pas un bac à sable** (même processus) ; la sécurité repose aussi sur l'analyse automatique et la revue humaine (phase 6).
- Sécurité : clé privée de contresignature de la marketplace = secret critique (stockage hors ligne ou coffre, rotation documentée) ; voir le [modèle de menace](../security/threat-model.md) §3.5.
- Réglementaire : chaque éditeur est fabricant de ses modules au sens du CRA (contrat éditeur, phase 6).
- Mise à jour d'`ARCHITECTURE.md` nécessaire : non.

## Références

- `ARCHITECTURE.md` §11 bis ; tests d'acceptation de la phase 1 (module tiers signé, modifié, révoqué, import interne, appel réseau non déclaré).
