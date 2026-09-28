# ADR 007 — Chiffrement de la base locale SQLite WASM

- **Statut** : accepté (décision du propriétaire le 2026-09-28 : option A et gestion de clé proposée)
- **Date** : 2026-09-28
- **Décideur** : Messaoudene Mehdi
- **Sections d'`ARCHITECTURE.md` concernées** : §2.4 (« Base locale »), §6.5, §13 (O5)

## Contexte

§6.5 demande une base locale **chiffrée**, avec une clé dérivée à la connexion et jamais stockée en clair. §13 (O5) demande un *spike* en phase 1 pour comparer deux approches : **SQLite3 Multiple Ciphers**, qui chiffre toute la base page par page, et le **chiffrement applicatif des champs**.

Ce que protège le chiffrement : un appareil perdu, volé ou partagé, et une copie du profil du navigateur (le dossier OPFS). Ce qu'il ne protège pas : un attaquant qui exécute du code dans la page pendant que la base est ouverte. C'est le rôle de la CSP et de Trusted Types (§9.3).

Deux faits vérifiés le 2026-09-28 :

- La version WASM de SQLite3 Multiple Ciphers (MIT) **n'existe pas sur npm**. Elle est publiée comme archive dans les *releases* GitHub (`utelle/SQLite3MultipleCiphers`). La v2.5.1 est basée sur SQLite 3.53.4, publiée le 2026-08-27, et son archive a le SHA-256 `761a41b8…85577ce`.
- La version officielle `@sqlite.org/sqlite-wasm` 3.53.4 (Apache-2.0) est sur npm, mais sans chiffrement.

## Mesures

**Protocole**

- Environnement : Edge 154 sans interface (Chromium), Windows 11, base dans **OPFS** (VFS `opfs-sahpool`, qui ne demande pas d'en-têtes COOP/COEP), exécution dans un Web Worker.
- Données : 20 000 lignes de 7 colonnes, avec 2 index.
- Chaque variante tourne une fois pour chauffer (tour écarté), puis 3 fois ; on garde la **médiane**.
- Deux campagnes complètes ont été lancées. La charge de la machine varie du simple au double entre elles, donc on compare les variantes **entre elles, au sein d'une même campagne**.
- La vérification « texte en clair sur disque » lit les octets bruts du fichier et cherche `example.com`.

**Variantes**

| Variante | Description |
|---|---|
| `officielle` | `@sqlite.org/sqlite-wasm`, sans chiffrement (référence) |
| `mc-clair` | build Multiple Ciphers, sans clé (isole l'effet du build) |
| `mc-chacha20` | Multiple Ciphers, ChaCha20-Poly1305 (schéma par défaut) |
| `mc-chacha20-kdf1` | idem, `kdf_iter = 1` : la clé est déjà dérivée à la connexion |
| `mc-sqlcipher` | Multiple Ciphers, schéma SQLCipher v4 (AES-256-CBC + HMAC-SHA512) |
| `champs-aes-gcm` | build officiel ; nom, e-mail et note chiffrés en AES-GCM (WebCrypto) avant écriture |

**Résultats** (millisecondes, campagne 1 / campagne 2)

| Opération | officielle | mc-clair | mc-chacha20 | mc-chacha20-kdf1 | mc-sqlcipher | champs-aes-gcm |
|---|---|---|---|---|---|---|
| Insertion de 20 000 lignes (1 transaction) | 1 358 / 653 | 1 213 / 643 | 1 249 / 620 | 1 253 / 720 | 1 305 / 818 | 1 042 / 463 **+ 1 786 / 996 de chiffrement** |
| 2 000 lectures par clé | 173 / 96 | 210 / 100 | 368 / 201 | 371 / 232 | 505 / 434 | 362 / 136 |
| 200 pages de liste (filtre + tri, 50 lignes) | 933 / 399 | 474 / 472 | 490 / 346 | 531 / 379 | 514 / 474 | 899 / 503 (tri sur le champ chiffré impossible) |
| 20 recherches `LIKE '%…%'` | 280 / 104 | 165 / 124 | 155 / 102 | 200 / 102 | 209 / 116 | **12 262 / 6 417** (tout déchiffrer, filtrer en JS) |
| 5 000 mises à jour (1 transaction) | 668 / 192 | 306 / 204 | 378 / 252 | 331 / 236 | 532 / 463 | 490 / 286 |
| Réouverture à froid + 1re requête | 4 / 1,5 | 1,8 / 1,5 | 72 / 86 | **18 / 16** | 379 / 374 | 2,7 / 2,2 |
| Taille du fichier | 7,7 Mio | 7,7 Mio | 7,8 Mio (+0,7 %) | 7,8 Mio | 7,9 Mio | **10,0 Mio (+30 %)** |
| Texte en clair lisible sur disque | oui | oui | **non** | **non** | **non** | non pour les 3 champs, **oui pour tout le reste** |

À la connexion, la dérivation PBKDF2-SHA256 avec 600 000 itérations (WebCrypto) prend 349 à 722 ms.

**Lecture des chiffres**

- **ChaCha20 face au même build sans clé.** L'insertion, les pages de liste et la recherche ne changent pas, à la marge de bruit près. Les lectures par clé coûtent environ 2 fois plus (0,1 ms par lecture), et les mises à jour 20 à 25 % de plus. L'ouverture prend +15 ms avec `kdf_iter = 1`. Le surcoût reste invisible pour l'utilisateur.
- **Le schéma SQLCipher** est nettement plus lent : 2 à 4 fois sur les lectures et les écritures, et 375 ms à l'ouverture à cause de sa propre dérivation de clé.
- **Le chiffrement des champs** rend la recherche inutilisable (320 à 600 ms par recherche, 60 à 70 fois plus lent). Il interdit le tri et les index sur les champs protégés et grossit la base de 30 %. Il laisse en clair tout ce qui n'est pas explicitement listé : montants, dates, structure, identifiants.

## Options envisagées

| Option | Avantages | Inconvénients |
|---|---|---|
| **A. SQLite3 Multiple Ciphers, ChaCha20-Poly1305** | Toute la base est chiffrée (tables, index, FTS5, journal) ; authentifiée par page (Poly1305) ; surcoût négligeable ; recherche, tri et index intacts ; MIT | Pas sur npm : archive GitHub à épingler par SHA-256 ; WASM plus lourd de ~200 Kio (1,07 Mio contre 0,87) ; mainteneur principal unique |
| B. Multiple Ciphers, schéma SQLCipher | Format compatible avec SQLCipher (outils existants) | 2 à 4 fois plus lent ; ouverture de 375 ms ; aucune compatibilité nécessaire ici |
| C. Chiffrement applicatif des champs (AES-GCM) | Build officiel sur npm ; aucune archive externe | Recherche, tri et index impossibles sur les champs protégés ; tout le reste en clair ; +30 % de taille ; chaque modèle doit déclarer ses champs à protéger (risque d'oubli) |
| D. Pas de chiffrement | Simple | Contraire à §6.5 ; données de clients exposées en cas de vol d'appareil (RGPD, loi 18-07) |

## Décision

**Option A : SQLite3 Multiple Ciphers en ChaCha20-Poly1305, avec `kdf_iter = 1`.** La clé de 256 bits est dérivée en amont par l'application, qui passe une clé brute. Toute la base est chiffrée et authentifiée pour un surcoût imperceptible. Les fonctions dont l'ERP dépend restent intactes : recherche, tri, index et FTS5.

**Gestion de clé** (retenue) :

1. À la première connexion sur l'appareil, le client tire une **clé de base aléatoire** de 256 bits (`crypto.getRandomValues`).
2. Cette clé est stockée **uniquement enveloppée** (AES-KW ou AES-GCM) dans IndexedDB. La clé d'enveloppe est dérivée de deux éléments :
   - le mot de passe, par PBKDF2-SHA256 à 600 000 itérations dans WebCrypto (Argon2id n'existe pas dans WebCrypto ; §9.3 le garde pour les mots de passe côté serveur) ;
   - un **secret d'appareil** fourni par le serveur à la connexion et conservé en mémoire le temps de la session.

   Sans ce secret, voler le profil ne suffit pas à attaquer le mot de passe hors ligne.
3. **Effacement à distance** (§6.5) : le serveur révoque l'appareil. À la connexion suivante, le secret n'est plus fourni et la base locale est détruite.
4. **Durée maximale hors ligne** : l'appareil peut garder le secret sous forme enveloppée pendant au plus N jours (7 par défaut). Au-delà, une réauthentification en ligne est obligatoire. Ce point reste à préciser dans la PR de synchronisation (point 8).
5. Plus tard : la dérivation par **passkey** (extension WebAuthn PRF) pourra remplacer le mot de passe, sans changer le format de la base.

## Conséquences

- Positives :
  - base locale entièrement chiffrée et authentifiée ;
  - mêmes requêtes SQL que sans chiffrement ;
  - l'adaptateur `orm-sqlite` ne dépend pas du choix, puisque seul le VFS change à l'ouverture.
- Négatives / dette acceptée :
  - le build WASM est une **archive GitHub** et non un paquet npm. Il sera téléchargé au build, vérifié par **SHA-256 épinglé** (comme gitleaks et OSV-Scanner en CI), et suivi manuellement, car Dependabot ne le voit pas ;
  - le WASM pèse 200 Kio de plus ;
  - il y a un seul mainteneur principal. Repli possible : le build officiel avec l'option C, au prix des limites mesurées.
- Sécurité :
  - la clé n'est jamais stockée en clair et n'est jamais une phrase de passe persistée ;
  - la base est détruite à la révocation de l'appareil ;
  - le chiffrement ne protège pas contre du code malveillant exécuté dans la page pendant une session ouverte ; la CSP et Trusted Types s'en chargent ;
  - les champs `sensitive` et `offline: false` restent **jamais répliqués** (§6.5), indépendamment de ce chiffrement.
- Licences : SQLite3 Multiple Ciphers sous MIT ; SQLite dans le domaine public ; glue Emscripten sous MIT/NCSA. Rien d'interdit.
- Limites du *spike* : un seul navigateur (Chromium) sur une seule machine. Firefox, Safari et le mobile restent à mesurer dans la CI Playwright de la phase 2, sans changement de décision attendu, car le coût est dominé par le WASM et identique partout.
- Mise à jour d'`ARCHITECTURE.md` : faite. §2.4 indique la décision à la place de « à valider en *spike* », et §13 marque O5 comme tranché.

## Reproduire les mesures

Le banc de mesure est dans `spikes/sqlite-encryption/`. Il télécharge et vérifie les deux builds par SHA-256, sert la page en local et lance Edge sans interface. Voir le `README.md` de ce dossier.
