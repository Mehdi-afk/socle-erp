# ADR 015 — Pile technique du client web et du design system

- **Statut** : accepté (mainteneur, décisions du 2026-09-28 sur la direction visuelle ; les choix d'implémentation ci-dessous sont proposés dans la PR)
- **Date** : 2026-09-29
- **Décideur** : Messaoudene Mehdi
- **Sections d'`ARCHITECTURE.md` concernées** : §2.4 (pile technique), §11.4 (licences), §3.2 (structure du monorepo)

## Contexte

Le lot 2.3 construit le client web générique (`apps/web`), le moteur de vues (`packages/view-engine`) et le design système (`packages/ui`) décrit dans `docs/design/direction-visuelle.md`. Cette direction impose des règles que les outils doivent faire respecter, pas seulement recommander :
- **aucune couleur écrite en dur** en dehors des fichiers de jetons ;
- **aucune propriété physique** (`left`, `margin-left`…), pour que l'arabe (droite à gauche) fonctionne partout ;
- **contrastes vérifiés** (WCAG 2.2 AA) et accessibilité contrôlée automatiquement ;
- **polices auto-hébergées**, sans appel à un CDN.

## Décisions

1. **CSS écrit à la main avec des variables** (fichiers `.css` à côté des composants), plutôt que Tailwind. Toute la palette vient des jetons ; stylelint (`stylelint.config.js`, MIT) interdit les couleurs en dur (`#hex`, `rgb()`, noms de couleurs…) et les propriétés physiques, hors `tokens.css`.
2. **React 19 + Vite** pour le client (déjà prévus par `ARCHITECTURE.md` §2.4).
3. **Primitives accessibles Radix** (`@radix-ui/react-tabs`, `dropdown-menu`, `tooltip`, `dialog`, MIT) pour les composants dont l'accessibilité est difficile à réécrire correctement : onglets, menus, infobulles, fenêtres modales (gestion du focus, clavier, ARIA). Le style reste le nôtre.
4. **Icônes Lucide** (`lucide-react`, ISC), en trait fin, comme prévu par la direction visuelle.
5. **Tests des composants** : Vitest avec jsdom, Testing Library (MIT) et **axe-core** (MPL-2.0, autorisé) directement, sans le paquet `vitest-axe` (dernière version en 2022). Le contraste n'est pas mesurable dans jsdom (pas de mise en page) : il est vérifié sur les jetons (`packages/ui/src/tokens.test.ts`) et le sera sur le rendu réel par Playwright (étape D).
6. **Lint React** avec `@eslint-react/eslint-plugin` (MIT), qui fournit `rules-of-hooks` et `exhaustive-deps`. `eslint-plugin-react-hooks` et `eslint-plugin-jsx-a11y` ont été essayés puis écartés : leur chaîne de dépendances (Babel, `semver@6.3.1`) déclenche la politique de chaîne d'approvisionnement `trustPolicy: no-downgrade` de pnpm. **Cette politique n'a pas été assouplie.** L'accessibilité statique de `jsx-a11y` est compensée par axe-core dans les tests.
7. **Polices** : Inter et Noto Sans Arabic, en version variable, via `@fontsource-variable/*`. Seules les plages utiles sont déclarées dans `packages/ui/src/fonts.css` (Inter latin et latin étendu ; Noto arabe) ; le navigateur ne télécharge un fichier que si la page contient des caractères de sa plage.

## Licences

Toutes les dépendances sont MIT, ISC, Apache-2.0 ou MPL-2.0, sauf :
- **SIL OFL 1.1** pour les deux polices : la licence autorise l'usage, l'intégration et la redistribution des fichiers de police avec un logiciel de n'importe quelle licence ; son copyleft ne porte que sur les versions modifiées de la police elle-même, que nous ne produisons pas. Ce sont des ressources servies à côté de l'application, pas du code lié à elle. Exception justifiée dans `scripts/license-exceptions.json`.
- **BlueOak-1.0.0** (`lru-cache`) et **CC0-1.0** (`mdn-data`) : dépendances transitives de `jsdom`, pour les tests uniquement, jamais livrées. Licences permissives sans copyleft.

## Conséquences

- La CI exécute `pnpm lint:css` en plus de `pnpm lint`.
- Ajouter une couleur ou une propriété physique dans un composant échoue au commit.
- Le budget « bundle initial ≤ 300 Ko gzip hors polices » (lot 2.3) exclut les fichiers de `fonts.css`.
