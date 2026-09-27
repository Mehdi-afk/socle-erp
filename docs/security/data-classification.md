# Classification des données — Socle ERP

- **Version** : 0.1 — 2026-09-28
- **Usage** : chaque champ d'un modèle hérite d'une classe. Les attributs de champ `sensitive` et `offline: false` (`ARCHITECTURE.md` §4.6) traduisent cette classification dans le code.

## 1. Classes

| Classe | Définition | Exemples |
|---|---|---|
| **Public** | Peut être publié sans préjudice | Nom commercial d'une société, catalogue public, documentation |
| **Interne** | Données de gestion de l'entreprise cliente, sans caractère personnel | Stock, prix d'achat, écritures comptables, paramètres |
| **Personnel** | Se rapporte à une personne physique identifiée ou identifiable (RGPD, loi 18-07 / 25-11) | Nom et coordonnées d'un contact, utilisateur, adresse de livraison, historique d'activité |
| **Sensible** | Préjudice élevé en cas de fuite, ou régime légal particulier | Données de santé, IBAN / RIB, pièces d'identité, NIR / numéro de sécurité sociale, salaires et paie, géolocalisation de véhicules rattachés à une personne |
| **Secret** | Permet d'accéder au système ou de signer | Mots de passe (hachés), secrets TOTP, jetons, clés d'API, clés privées d'appareil et de signature |

## 2. Règles de traitement

| Règle | Public | Interne | Personnel | Sensible | Secret |
|---|---|---|---|---|---|
| Chiffrement en transit (TLS 1.3) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Chiffrement au repos (disque + sauvegardes) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Chiffrement **applicatif** du champ (AES-256-GCM, clé par client) | — | — | — | ✅ `sensitive` | ✅ ou hachage (argon2id) |
| Réplication hors ligne | ✅ | ✅ | ✅ selon les droits | ❌ `offline: false` par défaut | ❌ jamais |
| Présence dans les logs | ✅ | ✅ | ❌ masqué | ❌ masqué | ❌ jamais |
| Présence dans les exports standards | ✅ | ✅ | ✅ selon les droits | Sur droit explicite, journalisé | ❌ jamais |
| Journal des accès en lecture (loi 25-11) | — | — | ✅ | ✅ | — |
| Visibilité dans le client web | Selon les droits | Selon les droits | Selon les droits | Groupe dédié (`groups`) | ❌ jamais |
| Données de test / démo | Réelles autorisées | Fictives | **Fictives uniquement** | **Fictives uniquement** | **Jamais** |

## 3. Obligations associées

- **Personnel** : registre des traitements ; export et effacement des données d'une personne intégrés au produit ; minimisation ; durée de conservation définie par modèle.
- **Sensible — santé** : hébergement **HDS** obligatoire en France ; AIPD ; chiffrement champ par champ ; accès journalisé.
- **Données comptables et factures** : conservation **10 ans** (France et Algérie), intégrité garantie (append-only, chaîne de hachage) ; l'effacement RGPD se fait par pseudonymisation, jamais par suppression d'une pièce comptable.
- **Transferts hors d'Algérie** : encadrés par la loi 25-11 ; l'auto-hébergement ou un datacenter en Algérie reste l'option par défaut pour les clients algériens.

## 4. Déclaration dans un modèle (cible phase 1)

```ts
fields: {
  name:  f.char({ required: true }),                          // Personnel (contact)
  iban:  f.char({ sensitive: true, offline: false,           // Sensible
                  groups: ['account.group_payment_manager'] }),
  notes: f.text(),                                            // Interne
}
```

Tout nouveau modèle déclare la classe de ses champs dans sa PR (checklist sécurité) ; un champ non classé est traité comme **Personnel**.
