# ADR 004 — Protocole de synchronisation offline-first

- **Statut** : accepté (détails d'implémentation à confirmer en phase 1)
- **Date** : 2026-09-28
- **Décideur** : Messaoudene Mehdi
- **Sections d'`ARCHITECTURE.md` concernées** : §6

## Contexte

Toute l'application fonctionne hors ligne (D7). Chaque appareil garde une réplique partielle, filtrée par les droits de l'utilisateur. Le serveur ne peut faire confiance à aucun appareil. Certaines opérations sont par nature serveur (numérotation légale, comptabilisation, transmission à la plateforme agréée). Les registres comptables et de stock doivent rester inaltérables.

## Options envisagées

| Option | Avantages | Inconvénients |
|---|---|---|
| **Journal de mutations signées + pull filtré + `decideConflict()` pure** | Revalidation serveur complète ; politiques par modèle ; testable ; reprend le pattern FleetOra éprouvé | Protocole à construire et à prouver (tests de propriétés) |
| CRDT génériques (Automerge, Yjs) | Convergence automatique | Ne portent pas les règles métier ni les droits ; la revalidation serveur reste nécessaire ; poids côté client |
| Réplication de base (ex. PowerSync, ElectricSQL) | Rapide à mettre en place | Dépendance à un service externe ou à une licence ; filtrage par droits et rejeu métier moins maîtrisés |

## Décision

1. **Identifiants UUIDv7** générés par le client ; colonnes techniques `version`, `updated_at`, `updated_by`, `deleted_at`, `origin_device`.
2. **Pull** `GET /sync/pull?cursor=…` : changements de version supérieure au curseur, **filtrés côté serveur** par ACL et règles, plus des instructions d'éviction.
3. **Push** : mutations idempotentes (`mutationId`), **signées Ed25519 par appareil**, portant les `baseVersions` des champs modifiés ; le serveur **rejoue** chaque mutation via le même ORM (droits, contraintes, règles métier).
4. **Conflits** : fonction **pure** `decideConflict(policy, { base, local, remote })` avec les politiques `field-lww` (défaut), `server-wins`, `append-only`, `manual` ; **la version perdante est toujours archivée**.
5. **Méthodes serveur** : jamais exécutées hors ligne, mises en file d'intentions (`op: 'call'`) et jouées à la reconnexion.
6. **Garde-fous** : un échec de lecture n'est jamais traité comme une base vide ; durée maximale hors ligne ; effacement à distance à la révocation d'un appareil.

## Conséquences

- Positives : aucune perte silencieuse de données ; hors ligne sur tout le périmètre ; comportement prouvé par des tests de propriétés fast-check (convergence quel que soit l'ordre d'arrivée).
- Négatives / dette acceptée : complexité du protocole ; l'utilisateur voit des états « en attente de synchronisation » ; numéros légaux attribués seulement côté serveur (brouillons `BRO-<appareil>-<n>`).
- Sécurité : signature par appareil, registre et révocation des appareils, rate limiting, revalidation complète ; voir le [modèle de menace](../security/threat-model.md) §3.1 et §3.2.
- Mise à jour d'`ARCHITECTURE.md` nécessaire : non.

## Références

- `ARCHITECTURE.md` §6 ; pattern FleetOra `sync-policy.ts`.
