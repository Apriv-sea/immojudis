# Collecte et enrichissement — 10 septembre 2026

## Exécution

- Découverte multi-sources uniquement sur lancement manuel (`workflow_dispatch` ou admin).
- File documentaire et IA toutes les deux heures, à la minute 37.
- `workflow_dispatch` conserve le scan manuel et ajoute `enrichment_only`.
- Un seul workflow écrivain à la fois ; aucune annulation du run actif.
- Scan : 10 biens documentaires et 20 synthèses maximum. Le reliquat est enregistré en base.
- Worker : deux jobs réservés à la fois, budget de 40 minutes ; reprise au passage suivant.

## Fraîcheur

Une signature prix/date ne suffit plus à sauter une fiche. La dernière vérification propre à cette URL doit dater de moins de 24 heures, ou de 6 heures si la vente intervient dans les sept jours. Une modification du contenu invalide les versions documentaires et de synthèse.

Les PDF sont revalidés quotidiennement avec `If-None-Match` et `If-Modified-Since` lorsque le serveur fournit ces en-têtes. Sans validateur, le téléchargement est répété. Un remplacement est écrit atomiquement ; l'ancien fichier est conservé sous son SHA-256 dans `versions/`. Ces fichiers suivent la rétention du cache d'extraction GitHub, qui ne constitue pas une archive permanente.

L'état documentaire contient l'empreinte des liens, l'heure de contrôle et le nombre de documents sélectionnés en échec. Une pièce non extraite ne compte plus comme preuve de couverture.

## Couverture et qualité

Les sources paginées Info Enchères, Cessions État, Enchères Immobilières et Notaires parcourent jusqu'à 100 pages par périmètre. Une page répétée, une source vide et un plafond atteint sont signalés comme incomplets. Licitor signale une frontière de pagination non parcourue. Les sources sans preuve d'exhaustivité restent explicitement non vérifiées.

Les conflits entre sources sont conservés dans `raw_payload.source_conflicts`. Une preuve documentaire et une vérification plus récente interviennent dans l'arbitrage par champ. Les anomalies ne majorent plus la richesse d'une annonce. Des numéros de lots différents et des surfaces applicatives fortement divergentes empêchent la fusion.

Après extraction documentaire, les surfaces manquantes, occupations inconnues et contradictions déclenchent un job `fact_extraction`, qui utilise `structured_then_display`. Le worker refuse de terminer avec succès un job PDF qui conserve des erreurs.

## Publication

Lorsque `SUPABASE_DB_URL` est configuré, les ventes, biens, procédures, surfaces, risques, preuves documentaires et jobs sont écrits dans une transaction PostgreSQL. Une erreur annule cette transaction ; aucun repli REST ne publie une moitié de ces données.

Les runs conservent leur statut compatible avec l'interface existante. `summary.stage_status` distingue collecte, enrichissement et publication ; `summary.completion_status` indique un succès partiel lorsqu'un traitement reste différé ou en erreur. Le nettoyage reste bloqué pour une collecte incomplète.

## Suivi et reprise

Le dernier step du workflow exécute `python -m src.pipeline_health`. Son résumé expose couverture par source et backlog par type/statut. Les nouveaux jobs épuisant leurs tentatives ou restant en attente plus de 48 heures font échouer ce contrôle.

Les jobs suivent les délais et le nombre maximal de tentatives de `auction_enrichment_jobs`. Après correction d'un problème de source, relancer le scan pour réévaluer les données puis le workflow avec `enrichment_only=true`. Un document inaccessible reste signalé ; il n'est jamais marqué extrait par défaut.

Vérifications : suite Python, tests de renouvellement de PDF/304, expiration des fiches, pagination, lots distincts, rollback simulé et transaction réelle sur PostgreSQL jetable.
