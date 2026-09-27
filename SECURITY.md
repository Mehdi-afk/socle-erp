# Politique de sécurité / Security policy

[Français](#français) · [English](#english)

## Français

### Signaler une vulnérabilité

**Ne publiez jamais une vulnérabilité dans une issue, une discussion ou une pull request publique.**

Utilisez le **signalement privé de GitHub** :
<https://github.com/Mehdi-afk/socle-erp/security/advisories/new>

À défaut, écrivez à <messaoudenemehdi0@gmail.com> avec pour objet `[SECURITY] socle-erp`.

Merci d'indiquer : la version ou le commit concerné, le composant, les étapes de reproduction, l'impact estimé et, si possible, une preuve de concept minimale.

### Délais de réponse

| Étape | Délai |
|---|---|
| Accusé de réception | **72 heures** |
| Évaluation initiale (confirmation, gravité CVSS) | **7 jours** |
| Correctif d'une vulnérabilité critique ou élevée | **30 jours** |
| Correctif d'une vulnérabilité moyenne ou faible | Prochaine version planifiée |

Nous vous tenons informé de l'avancement, publions un avis de sécurité GitHub (avec CVE si pertinent) une fois le correctif disponible et vous créditons, sauf si vous préférez rester anonyme.

Une vulnérabilité activement exploitée est traitée selon notre [plan de réponse à incident](docs/security/incident-response.md), y compris les obligations de notification du Cyber Resilience Act.

### Périmètre

**Inclus** : le code de ce dépôt (cœur, paquets `@socle/*`, modules community, images et fichiers de déploiement publiés ici).

**Exclus** :
- les modules tiers publiés par d'autres éditeurs (contactez leur éditeur ; prévenez-nous si le module est distribué sur la marketplace) ;
- les déploiements que nous n'opérons pas ;
- les attaques par déni de service volumétrique, l'ingénierie sociale, les accès physiques ;
- les rapports issus d'un scanner automatique sans démonstration d'impact.

### Règles de bonne foi

Nous ne poursuivrons pas une recherche menée de bonne foi qui respecte cette politique : pas d'accès aux données d'autrui au-delà du strict nécessaire, pas de dégradation de service, pas de divulgation publique avant la publication du correctif ou un délai convenu ensemble (90 jours par défaut).

### Versions supportées

Aucune version n'est encore publiée. Cette section sera complétée à la sortie de la version 1.0.

---

## English

### Reporting a vulnerability

**Never disclose a vulnerability in a public issue, discussion or pull request.**

Use **GitHub private vulnerability reporting**:
<https://github.com/Mehdi-afk/socle-erp/security/advisories/new>

Alternatively, email <messaoudenemehdi0@gmail.com> with the subject `[SECURITY] socle-erp`.

Please include: affected version or commit, component, reproduction steps, estimated impact and, if possible, a minimal proof of concept.

### Response times

| Step | Time |
|---|---|
| Acknowledgement | **72 hours** |
| Initial assessment (confirmation, CVSS severity) | **7 days** |
| Fix for a critical or high vulnerability | **30 days** |
| Fix for a medium or low vulnerability | Next planned release |

We keep you informed, publish a GitHub security advisory (with a CVE where relevant) once a fix is available, and credit you unless you prefer to remain anonymous.

### Scope

**In scope**: the code in this repository (core, `@socle/*` packages, community modules, images and deployment files published here).

**Out of scope**: third-party modules from other vendors, deployments we do not operate, volumetric denial of service, social engineering, physical access, and automated scanner output without demonstrated impact.

### Safe harbor

We will not pursue good-faith research that follows this policy: no access to other people's data beyond what is strictly necessary, no service degradation, and no public disclosure before a fix is released or an agreed deadline (90 days by default).

### Supported versions

No version has been released yet. This section will be completed with the 1.0 release.
