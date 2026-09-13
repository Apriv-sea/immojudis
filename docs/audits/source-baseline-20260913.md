# Baseline production des sources — 13 septembre 2026

Baseline exécuté en lecture seule le 13 septembre 2026 dans `/private/tmp/immojudis-reliability-20260912`. Il rapproche le diagnostic du 12 septembre, `source-reconciliation-20260912.json`, le runbook courant et les tables Supabase de production `sgpakxtyvenlpeihuucm`. Aucun nouvel inventaire HTTP, aucune mutation de production, aucun changement de code ou de migration n'a été effectué.

La distinction est essentielle : `auction_source_state.enabled` est un interrupteur de départ ; `availability` est un état d'audit. `unchecked` n'est pas « disponible », et `enabled=true` ne certifie pas l'accès. Une absence de lignes dans `auction_collection_items` n'est jamais comptée comme zéro publication ou zéro rejet.

## État global prouvé

Le scheduler Supabase `immojudis-operational-health` est actif sur `*/15 * * * *`, avec 96 exécutions réussies sur les dernières 24 heures et un dernier tick réussi à 09:15:00 UTC. Ce scheduler appelle le contrôle de santé ; il ne prouve pas l'activation des dix sources.

Le contrôle global est `enabled=true`, `source_details_enabled=true`, `observation_started_at=null`, budget quotidien 6 USD et plafond de 40 prédictions par run. La période d'observation de sept jours a été annulée par l'utilisateur ; `observation_started_at=null` n'est donc pas retenu comme défaut. Seules Licitor et Vench sont activées dans `auction_source_state`. Le run global le plus récent (`9a06c3c0-bd7f-4603-8b22-dcc727c899a5`, 12 septembre 07:54–10:53 UTC) est `failed`, avec collecte échouée, enrichissement partiel, publication partielle ou échouée et **zéro** ligne `auction_collection_items`.

Les deux runs pilotes récents ont une preuve durable de collecte et de publication complète : Licitor à 04:29:43 UTC et Vench à 08:47:17 UTC. Cette preuve ne s'étend pas aux huit autres sources. Les certificats publics des deux pilotes attestent le catalogue adressable observé, mais `database_completeness_certified=false`.

Le rapprochement durable du 12 septembre contient toujours 717 lignes : 635 clôtures explicites, 67 audiences passées, 14 expirations explicites et une expiration incorrecte réparée. Ce registre justifie des URL individuellement, mais ne remplace pas le journal `auction_collection_items` d'un run actuel pour les huit sources sans publication pilote.

## Tableau source par source

« Complète prouvée » utilise en premier lieu `last_inventory_complete_at` et `last_publication_complete_at`. Une couverture `true` dans le run global échoué est signalée comme preuve de pagination, pas comme publication complète.

| Source | enabled / disponibilité d'audit | Dernière collecte complète prouvée | Pagination et inventaire du dernier run observé | Publication / rejet / pending et motifs actuels |
|---|---|---|---|---|
| agrasc | `false` / `unchecked` | Non : état durable nul ; run source `2db398c7` collection `unverified` | Run global : 9 pages, 8 émis, 9 URL visitées, 7 détails complets + 1 non supporté, couverture `null` | Aucun `collection_items` pour le run global ; publication, rejet et pending non établis |
| avoventes | `false` / `unchecked` | Non : aucun timestamp durable | Run global : 271 émis, couverture `null`, total avant filtre département 271 ; pages non persistées dans cette preuve | Aucun `collection_items` pour le run global ; non établi |
| cessions_etat | `false` / `unchecked` | Non : arrêt `repeated_page`, couverture `false` | 23 pages, 239 annonces uniques vues, 262 requêtes réussies, total annoncé `null` | Aucun `collection_items` pour le run global ; non établi |
| encheres_immobilieres | `false` / `unavailable` | Non : `empty_page_unverified` et timeout de qualification | 18 pages, 242 émis, couverture `false` ; 260 requêtes réussies ne certifient pas l'inventaire | Aucun `collection_items` pour le run global ; non établi |
| encheres_publiques | `false` / `access_denied` | Non : refus HTTP 403 | Run global : 1 requête, 0 succès, 0 émis, couverture `false` | Aucun `collection_items` pour le run global ; aucun rejet de publication déductible du 403 |
| info_encheres | `false` / `unchecked` | Non : aucun timestamp durable | 5 pages, 85 émis, pagination publiée épuisée, couverture `null` | Aucun `collection_items` pour le run global ; non établi |
| licitor | `true` / `available` | **2026-09-13 04:29:43 UTC** | 6 partitions, 134 pages, 661 lignes annoncées, 643 URL uniques, 2 lignes répétées ; certificat public adressable `true`, complétude base `false` | Ledger complet : 643 items, 628 `published`, 15 `quarantined`, 0 pending. Motifs : 15 `ambiguous_persisted_identity`, 93 `merged_alias` ; ces alias ne sont pas des annonces supplémentaires |
| notaires | `false` / `unchecked` | Non dans `source_state` : la couverture source du run global est `true`, mais le run global est `failed` et n'a pas de journal d'items | 36 pages, total annoncé 827, 827 émis, 863/863 requêtes réussies, inventaire source marqué complet dans le run global | Aucun `collection_items` pour cette exécution ; publication/rejet/pending non établis |
| petites_affiches | `false` / `unchecked` | Non : aucun timestamp durable | 70 pages, 653 émis, 723/723 requêtes réussies, liens publiés épuisés, couverture `null` | Aucun `collection_items` pour le run global ; non établi |
| vench | `true` / `available` | **2026-09-13 08:47:17 UTC** | 56 pages, 669 URL du catalogue, 669 URL uniques ; liens de pagination épuisés, sans total indépendant ; certificat public adressable `true`, complétude base `false` | 669 items : 669 `published`, 0 pending, 0 quarantined. Motif journalisé : 15 `merged_alias` ; alias non comptés comme annonces supplémentaires |

Pour Licitor, le run est marqué `succeeded/complete` et le ledger `auction_collection_items` est complet à 643/643. Le compteur `upserted=615` du résumé concerne les lignes canoniques écrites ; il ne remplace pas les décisions du ledger (628 publiées et 15 quarantainées).

## Incident Licitor et reprise finale

Le journal `/private/tmp/immojudis-licitor-overnight-success.log` montre à l'offset 625 une perte de connexion PostgreSQL, puis cinq réponses REST 500 pour le batch `auction_observations` de 10 lignes (lignes 5326–5355). Le code `21000` et le message `ON CONFLICT DO UPDATE command cannot affect row a second time` établissent une collision de clé `source_url` dans le payload d'un même upsert. Le journal marque ensuite 18 décisions `publication_failed` pour 16 URL uniques ; deux URL apparaissent deux fois dans les admissions (`109863` et `109999`), donc le batch de 10 lignes ne doit pas être lu comme dix annonces.

La reprise finale du même run commit `615/643` ventes et `745` observations (lignes 6378–6392). La lecture de production à 09:32:05 UTC trouve, pour les 16 URL affectées, 16 décisions finales `published`, zéro `quarantined`, zéro pending, une ligne `auction_observations` par URL et une ligne `auction_sales`/`judicial_sales` rattachée au run. L'erreur initiale est donc récupérée dans ce run ; aucune reproduction de l'erreur n'est visible dans la reprise finale. Les 15 quarantaines du ledger concernent séparément `ambiguous_persisted_identity`.

La cause minimale est dans `main.py:400` puis `upsert_observations_to_supabase` : le payload est construit depuis chaque `sale.observations` sans déduplication finale, avant `_postgrest_upsert(..., on_conflict="source_url")`. Le correctif minimal à proposer à l'agent storage est de dédupliquer ou fusionner déterministement le payload par `source_url` avant les chemins PostgreSQL et REST, avec un test d'entrée dupliquée ; aucune mutation de storage ou de code n'a été faite ici.

## File et alertes

Au contrôle de 09:19:40 UTC, la file contient 3 797 jobs `queued`, 2 `failed`, 3 469 `cancelled` et 952 `completed`. Les tâches `source_detail` sont toutes en attente : 648 `queued`. Le runbook indique que le reliquat `pipeline.enrichment.stalled` reste ouvert ; le cycle `pipeline.import.unhealthy` a, lui, été ouvert puis rétabli et reçu selon le runbook courant. La capacité et la fraîcheur pilote à 95 % ne sont pas prouvées par ce baseline.

Le runbook courant ajoute que PR134 (`7f8ca3d1d4125d3367b217ec1568f35b92c64036`) est déployée en production READY, avec smoke 5/5 à 09:18 UTC. La migration PR133 est enregistrée sous la version du dépôt `20260913081411`; le registre de production a été aligné ou renommé sur cette version. `source_details_enabled` est actif depuis 08:59:55 UTC. Le dispatch de 500 tâches à 09:00 a toutefois laissé le run `45c00ec0` queued après HTTP 500 ; les reprises durables restent à finaliser. Le cycle d'alerte import a été rétabli par le workflow `34749191952` à 09:15:14 UTC, tandis que `pipeline.enrichment.stalled` demeure ouvert.

## Défauts graves restants

| Gravité | Défaut | Preuve et conséquence |
|---|---|---|
| P1 | Autonomie et publication des dix sources non démontrées | Seules Licitor/Vench sont enabled ; le dernier run `all` est failed et n'a aucun `collection_items`; huit sources n'ont aucun timestamp durable de collecte/publication complète. |
| P1 | Capacité du contrôle récurrent insuffisante ou non démontrée | 648 `source_detail` en attente, 3 797 jobs queued ; le runbook estime 84,3 contrôles/h requis (94,4/h avec marges) contre 80/h maximum actuel. |
| P1 | Accès/couverture bloquants | Enchères Publiques reste en 403, Enchères Immobilières en timeout/`empty_page_unverified`, Cessions État en `repeated_page`/couverture false. |
| P2 | Certificat public confondu avec complétude métier | Licitor et Vench ont `database_completeness_certified=false` et des alias fusionnés ; URL, lots et annonces doivent rester rapprochés séparément. |
| P2 | Garde d'unicité absente dans `upsert_observations` | Le batch Licitor a échoué sur le code `21000` avec `on_conflict=source_url`. La reprise a publié les 16 URL affectées et conservé une observation par URL ; le risque latent reste à corriger par déduplication/fusion déterministe du payload. |

Les valeurs détaillées, les identifiants de runs, les motifs et les limites sont dans [source-baseline-20260913.json](source-baseline-20260913.json). Dans le cadre de ce baseline, seuls ces deux fichiers ont été écrits.
