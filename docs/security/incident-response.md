# Plan de réponse à incident — Socle ERP

- **Version** : 0.1 — 2026-09-28
- **Responsable** : Messaoudene Mehdi (<messaoudenemehdi0@gmail.com>)
- **Révision** : après chaque incident (post-mortem) et au minimum une fois par an.

> Les délais légaux ci-dessous sont à **revalider par un juriste** avant la première vente. Pour la loi algérienne 25-11, le délai de 5 jours est à confirmer sur le texte publié au JORADP.

## 1. Rôles

Tant que l'équipe se limite au mainteneur, une même personne cumule les rôles. Ils sont nommés pour pouvoir être répartis plus tard.

| Rôle | Responsabilités |
|---|---|
| **Responsable d'incident** | Déclare l'incident, fixe la gravité, coordonne, décide du confinement |
| **Responsable technique** | Analyse, confinement, correctif, restauration |
| **Responsable communication** | Clients, autorités, avis de sécurité publics |
| **Référent protection des données** | Qualification RGPD / loi 25-11, notifications CNIL / ANPDP |

## 2. Niveaux de gravité

| Niveau | Définition | Exemples | Prise en charge |
|---|---|---|---|
| **SEV1 — critique** | Vulnérabilité activement exploitée, fuite de données confirmée, compromission d'une clé de signature ou de la chaîne de build | RCE exploitée ; accès inter-clients ; clé marketplace volée | Immédiate, 24 h/24 |
| **SEV2 — élevée** | Vulnérabilité exploitable sans exploitation connue, indisponibilité majeure du SaaS | Contournement d'ACL ; injection SQL signalée | Sous 24 h |
| **SEV3 — moyenne** | Impact limité ou conditions d'exploitation difficiles | XSS nécessitant un compte administrateur | Sous 7 jours |
| **SEV4 — faible** | Durcissement, risque théorique | En-tête de sécurité manquant | Prochaine version |

## 3. Déroulé

1. **Détection** : signalement privé GitHub ou email ([`SECURITY.md`](../../SECURITY.md)), alertes (secret scanning, Dependabot, CodeQL, supervision), client.
2. **Qualification** (objectif : 4 h pour un SEV1) : périmètre, versions touchées, clients touchés, données personnelles concernées ou non, exploitation active ou non. **Démarrer le chronomètre réglementaire** dès la prise de connaissance.
3. **Confinement** : révocation de clés, de sessions ou d'appareils ; révocation de module via la liste signée ; blocage au niveau de Caddy ; mise hors ligne ciblée. **Préserver les preuves** (logs, instantanés) avant toute modification.
4. **Éradication et correctif** : correctif sur une branche `sec/…` dans un fork privé de l'avis de sécurité GitHub, test de non-régression obligatoire, revue.
5. **Restauration** : déploiement SaaS, publication de la version corrigée signée, restauration de sauvegarde si besoin (instantanés à label sémantique).
6. **Notifications** : voir §4.
7. **Post-mortem sans reproche** sous 14 jours : chronologie, cause racine, ce qui a fonctionné, actions correctives suivies en issues ; mise à jour du [modèle de menace](threat-model.md).

## 4. Obligations de notification

| Obligation | Déclencheur | Délais | Destinataire |
|---|---|---|---|
| **Cyber Resilience Act** (UE), en tant que fabricant — obligation de signalement en vigueur depuis le 11 septembre 2026 | Vulnérabilité **activement exploitée** ou incident grave affectant la sécurité du produit | **24 h** : alerte précoce · **72 h** : notification · **14 jours** après la disponibilité du correctif : rapport final (vulnérabilité) | Plateforme unique de signalement de l'ENISA → CSIRT désigné (CERT-FR) |
| **RGPD** (art. 33 et 34) | Violation de données personnelles | **72 h** après en avoir pris connaissance ; information des personnes sans délai si risque élevé | **CNIL** ; personnes concernées |
| **Loi algérienne 18-07 modifiée par la loi 25-11** | Violation de données personnelles de personnes en Algérie | **5 jours** après la découverte (à confirmer) | **ANPDP** |
| **Contrats SaaS (DPA)** | Tout incident touchant les données d'un client | Objectif **24 h** | Clients concernés |

Rôle SaaS : pour les données de ses clients, l'éditeur est **sous-traitant** au sens du RGPD. Il notifie le client responsable de traitement, qui notifie la CNIL, sauf stipulation contraire du contrat.

## 5. Communication

- **Clients touchés** : message direct factuel (ce qui s'est passé, données concernées, ce que nous avons fait, ce que le client doit faire, contact).
- **Public** : avis de sécurité GitHub (GHSA, avec CVE si pertinent), publié avec le correctif ; crédit au chercheur s'il le souhaite.
- **Jamais** : de spéculation sur la cause avant qualification, de détails exploitables avant la disponibilité du correctif.

## 6. Contacts

| Qui | Contact |
|---|---|
| Mainteneur | <messaoudenemehdi0@gmail.com> |
| CERT-FR | <https://www.cert.ssi.gouv.fr/> |
| CNIL — notification de violation | <https://notifications.cnil.fr/> |
| ENISA — plateforme unique de signalement CRA | À renseigner dès l'ouverture de la plateforme aux fabricants |
| ANPDP (Algérie) | À renseigner |

## 7. Registre des incidents

Tout incident, même mineur, est consigné (date, gravité, résumé, notifications effectuées avec horodatage, lien vers le post-mortem) dans un registre privé tenu hors du dépôt public.
