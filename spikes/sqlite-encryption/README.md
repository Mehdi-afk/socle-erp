# Spike O5 — chiffrement de la base SQLite WASM (ADR 007)

Banc de mesure qui compare, dans un vrai navigateur et sur OPFS (VFS `opfs-sahpool`, dans un Web Worker) :

- `@sqlite.org/sqlite-wasm`, sans chiffrement ;
- SQLite3 Multiple Ciphers : sans clé, en ChaCha20-Poly1305 (avec et sans dérivation interne de la clé) et au schéma SQLCipher ;
- le chiffrement applicatif de 3 champs en AES-GCM (WebCrypto).

Ce code n'est pas livré. Il sert uniquement à reproduire les chiffres de l'ADR 007.

## Reproduire

```sh
cd spikes/sqlite-encryption
node fetch-builds.mjs        # télécharge les deux builds, vérifie leur SHA-256, les extrait dans ./builds
node run.mjs 20000 3         # 20 000 lignes, 3 tours mesurés (+1 tour d'échauffement écarté)
```

`run.mjs` cherche Edge ou Chrome. La variable `BROWSER` permet d'indiquer un autre navigateur Chromium. Le script lance le navigateur sans interface, avec un profil jetable, et affiche un JSON de médianes en millisecondes. Chaque variante vérifie aussi si du texte en clair est lisible dans le fichier sur disque (`plaintextOnDisk`).

Les mesures du 2026-09-28 (deux campagnes) sont dans `results-2026-09-28.json`.
