# Socle ERP

> **Statut : en développement — aucune version utilisable à ce jour.**
> **Status: under development — no usable release yet.**

[Français](#français) · [English](#english)

---

## Français

**Socle ERP** (nom de code `socle-erp`) est un ERP modulaire open-core, fortement inspiré d'Odoo, écrit en **TypeScript de bout en bout** et **offline-first** : l'application entière fonctionne sans réseau et se synchronise au retour de la connexion.

Il vise d'abord les **PME françaises** (réforme de la facturation électronique, Factur-X, FEC) puis **algériennes** (SCF, TVA 19/9 %, droit de timbre, NIF/NIS/RC/AI, factures bilingues FR/AR).

### Principes

- **Réutiliser, jamais réécrire** : un module étend les modèles et les vues des autres (extension, héritage par prototype, délégation, mixins), comme dans Odoo.
- **Un client web générique** piloté par les métadonnées : un nouveau module n'écrit en général aucun écran.
- **Offline-first partout** : la même logique métier s'exécute sur le serveur et dans le navigateur.
- **La sécurité et la conformité légale ne sont jamais payantes.**

### Licence

- Le cœur est distribué sous **GNU LGPL-3.0-only** (voir [`LICENSE`](LICENSE) et [`COPYING`](COPYING)), comme Odoo Community.
- **Les modules propriétaires sont autorisés** : tout éditeur ou intégrateur peut développer et vendre ses propres modules sous la licence de son choix, à condition de n'utiliser que l'API publique (`@public`) du cœur.
- **Remplaçabilité du cœur** (obligation LGPL) : le cœur est publié en code source et distribué en paquets `@socle/*` séparés des modules ; l'utilisateur peut le remplacer par une version modifiée.
- Les contributions sont soumises à un accord de licence de contribution ([`CLA.md`](CLA.md)).

### Documentation

- Architecture : [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Décisions d'architecture : [`docs/adr/`](docs/adr/)
- Contribuer : [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Signaler une vulnérabilité : [`SECURITY.md`](SECURITY.md) (jamais dans une issue publique)

---

## English

**Socle ERP** (code name `socle-erp`) is a modular open-core ERP, strongly inspired by Odoo, written in **TypeScript end to end** and **offline-first**: the whole application works without a network and syncs when the connection returns.

It targets **French SMEs** first (e-invoicing reform, Factur-X, FEC), then **Algerian** ones (SCF, 19/9 % VAT, stamp duty, NIF/NIS/RC/AI, bilingual FR/AR invoices).

### Principles

- **Reuse, never rewrite**: a module extends other modules' models and views (extension, prototype inheritance, delegation, mixins), as in Odoo.
- **A generic, metadata-driven web client**: a new module usually writes no screens.
- **Offline-first everywhere**: the same business logic runs on the server and in the browser.
- **Security and legal compliance are never paid features.**

### License

- The core is released under the **GNU LGPL-3.0-only** (see [`LICENSE`](LICENSE) and [`COPYING`](COPYING)), like Odoo Community.
- **Proprietary modules are allowed**: any vendor or integrator may build and sell their own modules under the license of their choice, provided they only use the core's public API (`@public`).
- **Core replaceability** (LGPL requirement): the core is published as source code and shipped as `@socle/*` packages separate from modules; users can replace it with a modified version.
- Contributions are subject to a Contributor License Agreement ([`CLA.md`](CLA.md)).

### Documentation

- Architecture (French): [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Architecture decision records: [`docs/adr/`](docs/adr/)
- Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Reporting a vulnerability: [`SECURITY.md`](SECURITY.md) (never in a public issue)

---

Copyright © 2026 Messaoudene Mehdi.
