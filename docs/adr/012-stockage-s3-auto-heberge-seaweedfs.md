# ADR 012 — Stockage S3 auto-hébergé : SeaweedFS

- **Statut** : accepté (le mainteneur a délégué le choix le 2026-09-28)
- **Date** : 2026-09-28
- **Décideur** : Messaoudene Mehdi
- **Sections d'`ARCHITECTURE.md` concernées** : §2.4 (ligne « Fichiers »), §9.3 (Fichiers), §9.6 (Sauvegardes)

## Contexte

Les pièces jointes (`ir.attachment`), les photos d'articles et les manifestes de sauvegarde vivent dans un stockage compatible S3, jamais sur le disque web. En SaaS, on utilise le S3 d'un hébergeur (OVHcloud, Scaleway). En auto-hébergement, le `docker compose` du lot 2.9 doit fournir un service S3. L'architecture laisse le choix entre Garage et SeaweedFS.

Les contraintes :
- tout doit tenir sur une seule machine modeste, avec la possibilité de grandir ;
- l'API S3 doit gérer les URL signées ;
- l'image doit être maintenue ;
- la licence ne doit rien imposer au cœur (§11).

## Options envisagées

| Option | Avantages | Inconvénients |
|---|---|---|
| **SeaweedFS** (Apache-2.0) | Licence permissive : aucune vigilance juridique, même si le service est un jour intégré plus étroitement ; passerelle S3 intégrée ; démarre en un seul processus (`weed server -s3`) ; montée en charge par ajout de volumes ; projet actif | Plus de concepts (master, volume, filer) quand on dépasse le mode tout-en-un ; configuration S3 (identités) à générer au premier lancement |
| Garage (AGPL-3.0) | Très léger, pensé pour l'auto-hébergement et la réplication entre sites | AGPL : acceptable seulement comme service séparé appelé par le réseau, ce qui impose une vigilance permanente (jamais de lien avec le code, jamais de copie modifiée distribuée sans ses sources) |
| MinIO | Le plus répandu | L'édition communautaire a perdu des fonctions d'administration et reste sous AGPL ; même vigilance que Garage, avec un avenir incertain |

## Décision

**SeaweedFS**, en mode tout-en-un avec la passerelle S3, dans le `docker compose` d'auto-hébergement.

Le code n'en dépend pas directement. Le serveur et le worker parlent **S3 standard** à travers un adaptateur unique (URL signées à courte durée, préfixe par client). Changer de stockage se réduit à une configuration : S3 d'un hébergeur, Garage ou MinIO chez un client qui l'impose.

## Conséquences

- **Positives**
  - Aucune licence copyleft dans la pile par défaut.
  - Le même adaptateur S3 sert le SaaS et l'auto-hébergement.
- **Dette acceptée**
  - Les identités S3 et les compartiments sont créés par l'assistant de premier lancement (lot 2.9).
  - La prise en charge du **verrouillage d'objet** (sauvegardes immuables, §9.6) sera **vérifiée par un test** au lot 2.7. Si elle manque, les sauvegardes immuables resteront une fonction du SaaS ou d'un S3 externe, et la documentation d'auto-hébergement le dira.
- **Sécurité**
  - Le service est accessible uniquement depuis le réseau interne du `docker compose`.
  - Les identifiants sont générés aléatoirement au premier lancement et rangés dans `.env` (jamais versionné).
  - Les objets ne sont jamais publics : accès par URL signées seulement.
- **Licences** : Apache-2.0, compatible avec le cœur LGPL.
- **Mise à jour d'`ARCHITECTURE.md`** : oui, §2.4 (SeaweedFS par défaut en auto-hébergement).

## Références

- Lots 2.1 (`ir.attachment`), 2.6 (photos), 2.7 (sauvegardes), 2.9 (déploiement) du prompt de la phase 2.
