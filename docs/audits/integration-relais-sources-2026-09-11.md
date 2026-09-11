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

## Activation autorisée

L’utilisateur a explicitement autorisé le déploiement durable et le secret GitHub. La fonction `source-fetch-relay` est déployée sur Supabase `sgpakxtyvenlpeihuucm`. Le secret dédié et l’URL sont configurés dans GitHub `Aprivi-dev/immojudis`.

La validation réelle a détecté puis corrigé une double décompression gzip dans le transport Python. Un test de régression couvre ce cas. Vérification après correction : 10 annonces Petites Affiches et 16 Cessions d’État reçues depuis le relais cloud.

Le lancement admin « Toutes les sources » inclut les deux sources dans le même workflow, sans second clic. Le suivi affiche le transport réellement utilisé et les annonces extraites par source, sans qualifier les anciens runs de Supabase par défaut. Les tests couvrent les trois sélections (toutes, Petites Affiches, Cessions État) et le refus des utilisateurs non administrateurs.

Validation locale : 1 138 tests Python réussis, 21 ignorés ; 7 tests admin réussis ; vérification TypeScript et lint ciblé. Aucun traitement historique relancé.
