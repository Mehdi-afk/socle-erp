# Conversations et activités personnelles

Le module `mail` dépend de `base`. Il ajoute le mixin abstrait `mail.thread` aux contacts, un onglet **Activité**, des messages texte et des notes internes, le suivi des changements de nom, e-mail et téléphone, des abonnements et des notifications dans l’application.

Les activités sont personnelles : appel, e-mail, réunion ou tâche, avec une échéance à la journée. Leur achèvement publie le compte rendu dans le fil au sein de la même transaction. Le calendrier générique propose semaine, mois et filtre par type ; sélectionner une activité ouvre la fiche correspondante. Le type « E-mail » désigne une activité à effectuer : il n’envoie aucun courrier.

Le cron `mail.activity_reminders`, déclaré avec la capacité `cron`, crée un rappel dans **Notifications** à partir du jour de l’échéance. Il passe toutes les 15 minutes lorsque le worker fonctionne. Le fuseau de l’utilisateur est enregistré à la planification ; une modification ultérieure de ses préférences ne déplace pas cette échéance. Les activités antérieures sans fuseau, ou avec un fuseau invalide, utilisent UTC. Une activité déjà en retard reçoit un seul rappel au prochain passage, sans répétition quotidienne. Ouvrir la fiche depuis ce rappel le marque comme lu ; **Actualiser** recharge les notifications.

## Autorisation et confidentialité

Les tables techniques n’accordent aucun accès RPC générique, même au groupe administrateur. Les services publics de `@socle/module-mail` vérifient un utilisateur serveur réel, l’existence d’un parent `mail.thread`, ses ACL et ses règles d’enregistrement. Les mutations verrouillent le parent et exigent son droit d’écriture. Auteur, société, abonné et responsable de l’activité proviennent du serveur. Les notes nécessitent le groupe effectif `base.group_user` ; un indicateur fourni au service peut seulement réduire cette visibilité.

Les notifications et le calendrier vérifient à nouveau les droits sur chaque parent à la lecture. Une notification ne contient aucun extrait de message. Chaque utilisateur ne peut terminer que ses propres activités planifiées. Le verrou du parent sérialise les achèvements concurrents ; un second achèvement est refusé.

Les rappels utilisent une table privée distincte, sans changer le schéma des notifications de messages existantes. Le planificateur verrouille d’abord le parent puis l’activité, relit son état et conserve le rappel et son marqueur dans la même transaction. Une contrainte unique empêche deux rappels pour la même activité et le même utilisateur. Lecture et acquittement exigent encore le bon responsable et un parent accessible ; un rappel d’activité terminée ou annulée n’est plus proposé. Les activités dont le parent a été supprimé sont annulées par le planificateur. Les rappels figurent dans l’export personnel et sont supprimés par l’anonymisation.

Les messages ordinaires sont immuables. Le suivi exclut les champs sensibles, restreints à des groupes et relationnels ; ces exclusions sont rejouées lors de la lecture et de l’export. Le hook ORM `afterWrite` reçoit les valeurs avant/après une écriture validée, y compris une affectation suivie de `flush()`. Il partage la transaction appelante, ne journalise ni créations ni recalculs et ne publie aucune méthode RPC.

L’export RGPD du contact inclut les messages autorisés et les activités de l’utilisateur. L’anonymisation passe d’abord les contrôles de conservation de `base`, puis efface les textes, le suivi et les comptes rendus, annule les activités et retire abonnements et notifications. Cette exception explicite à l’immutabilité est auditée et reste dans la transaction du contact.

## Transport et limites

Les routes `/mail/` réutilisent le tenant, la session, le jeton CSRF, la validation Zod et l’audit existants. Le client conserve les brouillons uniquement en mémoire, protège la navigation et ne rejoue aucune mutation automatiquement. Après acceptation d’un message, un échec de rafraîchissement permet une relecture sans republier son brouillon.

Le fil charge 50 messages par page, 100 activités planifiées et 100 types. Le calendrier retourne au plus 500 activités ; les notifications au plus 100 entrées non lues. Ces plafonds ne constituent pas des totaux exhaustifs. Le calendrier affiche des échéances, sans rendez-vous horaires, déplacement ni redimensionnement.

Un passage du cron examine au plus 500 activités non rappelées, les plus anciennes en premier. Les passages suivants poursuivent le rattrapage ; les activités dont le jour local n’est pas encore arrivé attendent. Pour une installation existante, mettre à niveau le module `mail` vers `0.1.1` pour ajouter la table, les colonnes et le cron. Le worker et son journal `ir.cron.run` restent ceux de `base` ; une panne du worker retarde les rappels.

Restent à livrer : SMTP sortant et interface d’adaptateur entrant (la réception effective est hors phase 2), notifications temps réel, mentions, assignation à un autre utilisateur, pièces jointes dans le fil et réplique hors ligne autorisée par parent. Les tables privées déclarent `syncable: false` : la synchronisation générique ne doit pas exposer leurs lignes. `mail.message` déclare déjà la politique de conflit `append-only` pour ce futur raccordement.

## Vérification et aperçu

```sh
pnpm --filter @socle/module-mail test
pnpm --filter @socle/acceptance test:browser
pnpm --filter @socle/acceptance demo:web
```

Pour reproduire le rappel avec le cron installé dans PostgreSQL jetable : `pnpm --filter @socle/acceptance test:browser -t "runs the installed reminder"`. Ce parcours planifie une activité en retard, exécute le cron, puis ouvre et acquitte son rappel en français et en arabe mobile. La démonstration `demo:web` seule ne démarre pas le worker.

La démonstration installe `base` et `mail` dans PostgreSQL jetable. Ses identifiants factices sont affichés au démarrage. Ouvrir **Contacts**, une fiche, puis **Activité** ; les boutons **Notifications** et **Mes activités** sont disponibles dans l’en-tête. Les tests navigateur couvrent les cookies réels, l’écriture persistée, les droits de lecteur et de société, le CSRF, les brouillons, le calendrier, le mobile arabe et axe.
