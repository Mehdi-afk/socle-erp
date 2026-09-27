## Objet

<!-- Quoi et pourquoi, en quelques lignes. Lien vers l'issue : Closes #… -->

## Type

- [ ] feat
- [ ] fix
- [ ] sec
- [ ] docs
- [ ] chore / refactor / test

## Tests

- [ ] `pnpm typecheck && pnpm lint && pnpm test` passent localement
- [ ] Toute nouvelle règle métier est une fonction pure testée
- [ ] Tout bug corrigé a un test de non-régression
- [ ] Changement d'interface ou de comportement : aperçu fourni (capture ou description + commande)

## Checklist sécurité

- [ ] Aucun secret, jeton, mot de passe ou donnée personnelle réelle dans le code, les tests, les logs ou cette PR
- [ ] Toute entrée externe est validée par Zod ; ordre CORS → rate limit → parse → validate → authN → authZ → action respecté
- [ ] Aucune décision de droit prise uniquement côté client ; refus par défaut ; mutations de synchro revalidées côté serveur
- [ ] Aucun SQL brut hors du gabarit `sql` de Kysely ; noms de tables/colonnes dynamiques validés par liste blanche
- [ ] Pas d'`eval`, de `new Function`, de `dangerouslySetInnerHTML` sans DOMPurify, ni de désérialisation non validée
- [ ] Chemins de fichiers normalisés et confinés ; requêtes HTTP sortantes via le client à liste blanche
- [ ] Montants en entiers (unités mineures + devise) ; dates en UTC ; règles fiscales en données datées
- [ ] Logs sans mot de passe, jeton, donnée `sensitive` ou personnelle en clair
- [ ] Nouvelle dépendance : justifiée (besoin, licence autorisée, maintenance, alternatives) — ou aucune
- [ ] En-tête SPDX présent sur chaque nouveau fichier source
- [ ] Modèle de menace (`docs/security/threat-model.md`) mis à jour si la surface d'attaque change

## Écarts avec l'architecture

- [ ] Aucun
- [ ] Oui — ADR : `docs/adr/…`
