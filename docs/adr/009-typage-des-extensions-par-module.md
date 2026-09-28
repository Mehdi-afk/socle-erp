# ADR 009 — Typage des extensions de modèles : clé par module

- **Statut** : accepté
- **Date** : 2026-09-28
- **Décideur** : Messaoudene Mehdi
- **Sections d'`ARCHITECTURE.md` concernées** : §4.3

## Contexte

`ARCHITECTURE.md` §4.3 propose, pour qu'un module qui étend un modèle fasse connaître ses champs au compilateur :

```ts
declare module '@socle/framework' {
  interface ModelFields { 'sale.order': { margin: Money } }
}
```

Dès que **deux** modules déclarent la même clé `'sale.order'` (par exemple `sale_margin` et `sale_stock`, ou simplement le module qui définit le modèle et un module qui l'étend), TypeScript refuse la fusion : erreur **TS2717** « Subsequent property declarations must have the same type ». Vérifié le 2026-09-28 avec TypeScript 6.0. Or étendre un même modèle depuis plusieurs modules est le cas normal d'un ERP modulaire.

## Options envisagées

| Option | Avantages | Inconvénients |
|---|---|---|
| Syntaxe de §4.3 telle quelle | Lisible | **Ne compile pas** avec plus d'une déclaration par modèle |
| **Clé par module** : `ModelFields` déclaré une seule fois par le module qui définit le modèle ; chaque extension déclare `ModelExtensions[<module>][<modèle>]` | Clés uniques (le nom de module est unique dans le catalogue) ; tout reste sur `'@socle/framework'` ; le framework fusionne automatiquement | Une ligne de plus que la syntaxe initiale |
| Interface par modèle (`SaleOrderFields`) augmentée dans le paquet du module définissant | Classique | L'extension doit connaître le paquet et le nom d'interface du module qui définit le modèle |

## Décision

**Clé par module.**

```ts
// Module qui DÉFINIT le modèle (une seule fois)
export const saleOrder = defineModel({ name: 'sale.order', fields: { … } });
declare module '@socle/framework' {
  interface ModelFields { 'sale.order': FieldsOf<typeof saleOrder> }
}

// Module qui ÉTEND le modèle : clé = nom du module
declare module '@socle/framework' {
  interface ModelExtensions { sale_margin: { 'sale.order': { margin: Money } } }
}
```

Le framework calcule `FieldsOfModel<'sale.order'>` = champs de `ModelFields['sale.order']` ∩ toutes les entrées `ModelExtensions[*]['sale.order']`. `env.model('sale.order')` et le paramètre `Base` des méthodes sont typés en conséquence.

Décision associée : un champ numérique (`integer`, `monetary`) vide se lit **0** (comme Odoo), ce qui permet de le typer `number` et non `number | null`.

## Conséquences

- Positives : le typage fonctionne quel que soit le nombre de modules qui étendent un modèle ; un champ inconnu reste une erreur de compilation.
- Négatives / dette acceptée : syntaxe légèrement différente de celle de §4.3.
- Sécurité : aucune (typage uniquement).
- Mise à jour d'`ARCHITECTURE.md` nécessaire : oui, §4.3 (fait dans la même PR).

## Références

- Essai de compilation : deux augmentations de `ModelFields['sale.order']` → TS2717 ; variante par module → compilation réussie, champ inconnu refusé.
