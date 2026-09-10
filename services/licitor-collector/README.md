# Collecteur Licitor manuel

Gabarit privé : aucun cron. Chaque appel à `/api/tick` traite un lot borné et nécessite une action manuelle authentifiée. `/api/monthly` reste désactivé tant que `monthly_enabled` est faux dans la base.

Aucun enrichissement ni publication du catalogue n’est déclenché par ce service. Les modules partagés doivent être inclus dans un paquet isolé avant tout déploiement ; ne pas déployer ce dossier directement.
