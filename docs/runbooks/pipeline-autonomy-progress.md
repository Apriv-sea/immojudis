# Chantier autonomie — suivi de réalisation

Objectif utilisateur : finir les huit chantiers, y compris sept jours d'observation. Ne pas déclarer terminé sur la seule livraison de code. Le diagnostic est dans le workspace principal, `docs/audits/diagnostic-production-2026-09-12*`.

Copie isolée : `/private/tmp/immojudis-reliability-20260912`, branche `feat/pipeline-autonomy`, départ main `7c563e2`. Le workspace principal a de nombreux changements tiers à préserver. Aucun déploiement de cette branche à ce stade.

## Réalisé localement, en validation

- Reprises source : trois reprises après l'essai initial, Retry-After numérique/date, délai long exposé, coupe-circuit après deux refus persistants dans PoliteHttpClient.
- Nouveau journal `auction_collection_items` : découvertes, normalisation, exclusions, expiration avec provenance, fusions par URL canonique, publication dans la transaction du catalogue. Rétention liée aux runs.
- Table d'état des dix sources, désactivées par défaut en attendant activation pilote.
- Worker : relecture de TOUS les champs réécrits (ancien SELECT oubliait prix/date/procédure), verrou/version avant écritures d'enrichissement ; refuse ligne modifiée ou supprimée.
- Modification de source : ancienne synthèse déplacée dans superseded_analysis, statut pending ; le texte ancien n'est plus dans llm_display_description.
- Collecte sans IA conserve l'accès aux versions connues et collecte les détails factuels (le flag PDF ne doit pas supprimer le détail Licitor).
- Tests PostgreSQL jetable : sept passants ; tests main/storage/retry : 67 passants avant derniers ajouts. Suite complète en cours.

## Prochains travaux

1. Terminer tests tranche fondations ; corriger import/export, concurrence et motifs manquants ; commit et PR isolée.
2. Rendre Licitor/Avoventes cohérents avec le client HTTP commun et préserver résumés sur erreur détail. Licitor a un client séparé sans retries et ne saute pas encore les détails frais.
3. Orchestrateur unique du catalogue, GitHub existant à réutiliser : cadence inventaire 6h, détails24h/6h proches, worker30min borné, surveillance15min. État SQL par source, pause/reprise, Retry-After persistant, erreurs isolées. Même groupe écrivain que workflow manuel. Ne pas activer simultanément un second ordonnanceur de collecte.
4. Checkpoints/reprise des annonces restantes et protections contre versions anciennes pour collecte aussi. Tester interruption réelle, timeout, provider IA indisponible, verrou expiré, doublons. Attention la collecte all attend encore les détails de toutes sources avant publication ; pilote par source indépendant.
5. Corriger priorités/leases/file : aligner expiration avec fonction SQL sale_retention_deadline, gérer jobs obsolètes/disparus, temps/débit/coûts documentés.
6. Qualité : quarantaine identité/procédure, réserves surfaces/occupation inconnue, provenance document/page. Vérifier réellement les 100 cas (échantillon base seulement à ce jour).
7. Admin : dernière collecte complète, décisions, erreurs, file bloquée, coût/latence, pause source. Fiche : vérification, pending/missing/conflicts ; type/query/view à compléter.
8. Alertes incident/rétablissement déjà en base et GitHub : mesurer réception effective (delivered n'est pas réception humaine), dédupliquer deux cycles/drop/backlog24h/publication. Aucun message externe de test encore autorisé explicitement au destinataire ; ne pas inventer réception.
9. Réconcilier à nouveau toutes les URL/lots et certifier les différences. Audit indépendant source_coverage_audit existant : 7 inventaires publics certifiés ; AGRASC cartes sans liens ; Enchères Publiques403 ; Enchères Immobilières intermittent timeout. Pas de contournement de refus.
10. Déployer migrations/code après checks, activer deux sources stables (Licitor/Vench) puis extension prouvée, installer suivi récurrent dans ce thread pour observation. Sept jours réels sans relance, >=95% fraîcheur, incidents/rétablissement reçus avant clôture du goal.

## Outils locaux

Python existant : `/Users/aprivileggio/Documents/Immojudis main/immojudis/services/data-pipeline/.venv/bin/python` (3.11). Utiliser cwd du clone.
PostgreSQL jetable démarré : `postgresql://aprivileggio@127.0.0.1:55491/postgres`, datadir `/private/tmp/immojudis-reliability-pg`. Connexions nécessitent exécution escaladée. Aucun secret de production dans cette URL.
CLI Supabase : `/Users/aprivileggio/.npm/_npx/7960735060baecd3/node_modules/.bin/supabase`. Migration générée avec CLI `20260912110654_pipeline_autonomy_evidence.sql`. CLI a besoin d'escalade pour télémétrie locale.
Supabase production MCP : projet `sgpakxtyvenlpeihuucm`. GitHub `Aprivi-dev/immojudis`. Vercel projet `prj_bT7KAmr741pwq7t21KLmGS66v3g7`, équipe `team_VK2w4EKHDWWwDDF0uRS9ZKY1`.

## Mise à jour après implémentation locale (12 septembre, avant tout déploiement)

Les points 2, 3 et 5 des prochaines étapes ci-dessus ont maintenant une implémentation locale : clients HTTP communs, contrôle SQL de l’ordonnanceur, exécution bornée, file et verrous. Les tâches ne sont pas considérées terminées avant validation en production.

- Ordonnanceur : réutilisation du pg_cron opérationnel 15 min ; dispatch GitHub par unité source, groupe écrivain existant. Suppression du cron Vercel quotidien de santé. Migrations et contrôle global désactivés par défaut.
- Reprise : checkpoints de détail 24 h de rétention, réutilisables pendant 6 h uniquement après run échoué et carte d’inventaire identique ; conservation de la vraie date de vérification. Découverte et checkpoint dans une transaction. Source HTTP en erreur ne rafraîchit plus artificiellement ses fiches.
- Cycle de vie : normalisation explicite report/annulation/retrait, contrainte DB étendue, dates de fenêtres et contradictions protégées. Transition passé via RPC utilisant la même échéance que la rétention.
- Qualité : procédure explicitement contradictoire -> statut quarantined, preuves conservées, hors vues catalogue. Ancienne synthèse invalidée aussi après fusion ; provenance selected/alternative corrigée. Champs fraîcheur/contradictions/analyse ajoutés aux vues app/discovery en conservant leurs restrictions.
- Admin : nouveau panneau et API protégée, état par source, pause/reprise sans effacer Retry-After, décisions, latence p95, métriques de consommation. Notice de fraîcheur/réserves sur la fiche simplifiée.
- Alertes : une ouverture par incident et un rétablissement ; pas de relance toutes les 6 h, ni remise à zéro des échecs de livraison. Évaluateurs indépendants. Observations SQL, alertes deux cycles manqués, chute >30 %, publication échouée, file >24 h.
- Consommation : réservations avant chaque requête Replicate, plafond 40 par exécution et 5 USD/jour initial ; plafond atteint -> tâche différée sans brûler son budget de reprises. Modèle/version existants épinglés, coût estimé par predict_time × 0.000975 USD/s (L40S). Appels sans métriques gardés au maximum réservé 5 min, jamais comptés à zéro. Sources : https://replicate.com/zsxkib/qwen2-7b-instruct et https://replicate.com/pricing (vérifiés le 12/09/2026). https://replicate.com/docs/reference/http confirme predict_time en secondes. Ce ne sont pas des factures.

Validation récente : Python 1193 passants, 28 ignorés sans base ; Vitest 950 passants, 3 ignorés ; 6 tests SQL autonomes passants (ordonnanceur, file, alerte/rétablissement, checkpoints, budget), autres intégrations SQL à relancer ensemble. TypeScript et lint ciblé passants avant les derniers ajouts. Build Webpack complet passé ; Turbopack local échoue sur l’ouverture d’un port PostCSS même après demande d’escalade. Ne pas confondre ce blocage local avec une erreur de code.

Contrôle visuel en cours avec Playwright CLI, session `autonomy`, serveur local http://127.0.0.1:3217 (processus tool session 69775). Le build servi précède les derniers ajouts de métriques/coûts : refaire la vérification finale après rebuild. Mocks uniquement côté navigateur pour l’admin, script `/private/tmp/autonomy-browser.js`. Les 404 initiaux sur `_vercel/*/script.js` sont ceux des outils de mesure absents d’un serveur local ; mocks explicites ajoutés, ne pas masquer d’autres erreurs. Aucun mock ni changement de données en production.

Restent impératifs : vérifier l’ensemble des nouvelles migrations via CI Supabase/pgTAP ; PR/merge/déploiement ; contrôler les deux sources pilote réellement depuis production ; traiter les 100 cas avec preuves et les différences d’inventaire ; statut absent vs panne et observabilité des sources non pilotes ; vérifier la réception effective incident/rétablissement dans le canal opérationnel existant ; retirer la planification distante du collecteur Licitor secondaire ; activer et observer sept jours réels, étendre progressivement. Pas d’automatisation de suivi du thread encore créée, pas de pilote activé.
