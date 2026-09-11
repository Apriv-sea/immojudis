# Intégration du relais — 11 septembre 2026

## Réalisé

- Transport Python optionnel pour Petites Affiches et Cessions d’État. Les autres sources restent en accès direct.
- Fonction Supabase avec authentification dédiée sans droits en base, restriction des domaines et formulaires, limite de réponse et délai maximal, certificat intermédiaire Cessions d’État.
- Aucun cookie ni en-tête d’autorisation transmis aux sources.
- Contrôles de pagination, robots, redirections, qualité et publication conservés dans les collecteurs.
- Configuration des workflows préparée, inactive tant que la variable et le secret ne sont pas renseignés.
- Python : 1 137 tests réussis, 21 ignorés. Deno : 2 tests réussis. Ruff : réussi.
- Test local de bout en bout Python → transport → fonction Deno → sites → parseurs : HTTP 200, 10 annonces Petites Affiches et 16 Cessions d’État. Fonction locale arrêtée après validation. Déploiement cloud de cette version non validé.
- Enchères Publiques : nouvelle ouverture dans le navigateur et lecture structurée du DOM public de la fiche 131688 réussies. Surface 42,04 m², prix de départ 150 000 €, audience du 15 octobre 2026 à 14 h, avocat USGVB. Aucun collecteur navigateur serveur déployé ; cette lecture ne certifie pas un catalogue exhaustif.

## Activation en attente

Le contrôle automatique a refusé :

1. Le transfert du nouveau secret de téléchargement `SOURCE_FETCH_RELAY_TOKEN` vers le dépôt GitHub `Aprivi-dev/immojudis`, faute d’autorisation explicite pour cette destination.
2. Le déploiement durable de `source-fetch-relay` sur le projet Supabase `sgpakxtyvenlpeihuucm`, faute d’autorisation explicite pour cette exposition réseau. La fonction utilise sa propre authentification ; la validation JWT Supabase est désactivée car le jeton dédié n’est pas un JWT.

Le refus initial mentionnait également le relais de cookies. Leur transmission a été retirée du code préparé. Aucun nouvel essai de déploiement n’a suivi le refus.

Aucun secret GitHub ajouté, aucune fonction durable déployée, aucune collecte production ni reprise de file historique exécutée. Après autorisation : déploiement, configuration du secret et de l’URL, puis audit en lecture seule depuis GitHub sur les deux sources.
