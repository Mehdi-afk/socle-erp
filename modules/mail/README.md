# Conversations et activités personnelles

Le module `mail` dépend de `base`. Il ajoute le mixin abstrait `mail.thread` aux contacts, un onglet **Activité**, des messages texte et des notes internes, le suivi des changements de nom, e-mail et téléphone, des abonnements et des notifications dans l’application.

Les activités sont personnelles : appel, e-mail, réunion ou tâche, avec une échéance à la journée. Leur achèvement publie le compte rendu dans le fil au sein de la même transaction. Le calendrier générique propose semaine, mois et filtre par type ; sélectionner une activité ouvre la fiche correspondante. Le type « E-mail » désigne une activité à effectuer : il n’envoie aucun courrier.

## Autorisation et confidentialité

Les tables techniques n’accordent aucun accès RPC générique, même au groupe administrateur. Les services publics de `@socle/module-mail` vérifient un utilisateur serveur réel, l’existence d’un parent `mail.thread`, ses ACL et ses règles d’enregistrement. Les mutations verrouillent le parent et exigent son droit d’écriture. Auteur, société, abonné et responsable de l’activité proviennent du serveur. Les notes nécessitent le groupe effectif `base.group_user` ; un indicateur fourni au service peut seulement réduire cette visibilité.

Les notifications et le calendrier vérifient à nouveau les droits sur chaque parent à la lecture. Une notification ne contient aucun extrait de message. Chaque utilisateur ne peut terminer que ses propres activités planifiées. Le verrou du parent sérialise les achèvements concurrents ; un second achèvement est refusé.

Les messages ordinaires sont immuables. Le suivi exclut les champs sensibles, restreints à des groupes et relationnels ; ces exclusions sont rejouées lors de la lecture et de l’export. Le hook ORM `afterWrite` reçoit les valeurs avant/après une écriture validée, y compris une affectation suivie de `flush()`. Il partage la transaction appelante, ne journalise ni créations ni recalculs et ne publie aucune méthode RPC.

L’export RGPD du contact inclut les messages autorisés et les activités de l’utilisateur. L’anonymisation passe d’abord les contrôles de conservation de `base`, puis efface les textes, le suivi et les comptes rendus, annule les activités et retire abonnements et notifications. Cette exception explicite à l’immutabilité est auditée et reste dans la transaction du contact.

## Transport et limites

Les routes `/mail/` réutilisent le tenant, la session, le jeton CSRF, la validation Zod et l’audit existants. Le client conserve les brouillons uniquement en mémoire, protège la navigation et ne rejoue aucune mutation automatiquement. Après acceptation d’un message, un échec de rafraîchissement permet une relecture sans republier son brouillon.

Le fil charge 50 messages par page, 100 activités planifiées et 100 types. Le calendrier retourne au plus 500 activités ; les notifications au plus 100 entrées non lues. Ces plafonds ne constituent pas des totaux exhaustifs. Le calendrier affiche des échéances, sans rendez-vous horaires, déplacement ni redimensionnement.

Restent à livrer : SMTP entrant/sortant, notifications temps réel et rappels, mentions, assignation à un autre utilisateur, pièces jointes dans le fil et réplique hors ligne autorisée par parent. Les tables privées déclarent `syncable: false` : la synchronisation générique ne doit pas exposer leurs lignes. `mail.message` déclare déjà la politique de conflit `append-only` pour ce futur raccordement.

## Vérification et aperçu

```sh
pnpm --filter @socle/module-mail test
pnpm --filter @socle/acceptance test:browser
pnpm --filter @socle/acceptance demo:web
```

La démonstration installe `base` et `mail` dans PostgreSQL jetable. Ses identifiants factices sont affichés au démarrage. Ouvrir **Contacts**, une fiche, puis **Activité** ; les boutons **Notifications** et **Mes activités** sont disponibles dans l’en-tête. Les tests navigateur couvrent les cookies réels, l’écriture persistée, les droits de lecteur et de société, le CSRF, les brouillons, le calendrier, le mobile arabe et axe.
