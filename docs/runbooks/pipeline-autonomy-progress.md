# Collecte autonome : exploitation et qualification

## Architecture

Le tick `immojudis-operational-health` de pg_cron, toutes les 15 minutes, est le seul ordonnanceur du catalogue. Il appelle l’endpoint authentifié de santé, qui réclame une unité SQL puis déclenche `data-pipeline.yml`. Le workflow reste déclenchable manuellement mais ne possède pas de cron GitHub. Le cron Vercel quotidien de santé est retiré.

Les migrations laissent le contrôle global et les dix sources désactivés. Le pilote prévu porte sur Licitor et Vench. L’activation est une opération distincte du déploiement.

- Inventaire : échéance de six heures par source ; détails connus vérifiés toutes les 24 heures, ou six heures à moins de sept jours de la vente lorsque l’adaptateur exploite la fraîcheur.
- Enrichissement : unité toutes les 30 minutes, au maximum 40 tâches et 1 200 secondes de travail ; processus interrompu après 25 minutes. Collecte interrompue après 35 minutes.
- Écrivain : réservation SQL unique et groupe de concurrence GitHub partagé avec les lancements manuels. Les réservations automatiques abandonnées expirent après une heure.
- Publication : lots de 25, journal des décisions dans la transaction. Un enrichissement ne peut pas recréer une ligne supprimée ou remplacer une révision plus récente.
- Reprise : trois reprises HTTP après l’essai initial, respect de Retry-After ; deux refus persistants suspendent les appels répétés. Un détail réussi est réutilisable après panne pendant six heures si sa carte source est identique. Les checkpoints sont purgés après 24 heures.

## Interrupteurs et limites

L’administration permet de suspendre ou réactiver une source. La réactivation conserve la date Retry-After existante. Une suspension empêche les prochains départs ; elle n’interrompt pas brutalement une transaction en cours.

Le contrôle global est `auction_pipeline_control.enabled`. Le mettre à false suspend les nouveaux départs automatiques. `auction_source_state.enabled` commande chaque source. Les opérations SQL sont réservées au service ; les tables ne sont pas accessibles aux utilisateurs publics.

Le budget initial est de 40 requêtes IA par exécution et 5 USD par jour UTC. Chaque requête réserve au maximum cinq minutes de calcul avant son envoi. Un budget atteint diffère la tâche sans consommer une tentative de reprise. Le fournisseur reçoit une durée maximale de cinq minutes.

L’estimation utilise `predict_time × 0.000975 USD/s` pour la version existante épinglée de Qwen sur L40S. Les requêtes sans métriques conservent leur réservation maximale, elles ne sont pas comptées à zéro. Ce suivi ne remplace pas la facture. Références vérifiées le 12 septembre 2026 : [modèle](https://replicate.com/zsxkib/qwen2-7b-instruct), [tarifs](https://replicate.com/pricing), [métriques](https://replicate.com/docs/reference/http).

## Preuves et états

`auction_collection_items` conserve les identités source, lots, URL canonique, décisions et motifs. Les nombres publiés doivent être rapprochés de ce journal ; une fusion ou plusieurs écritures de la même fiche ne constituent pas de nouvelles annonces.

Une absence n’est établie qu’après un inventaire certifié complet. Une panne conserve l’état de présence précédent et signale séparément l’indisponibilité. Aucune suppression n’est déclenchée par cette absence. Report et contradictions de date suspendent l’expiration ; une date passée ne signifie jamais « vendue ».

Les changements de documents invalident la synthèse courante. Les empreintes SHA permettent aussi de détecter un remplacement à URL identique sur un nouveau worker. Les anciennes preuves documentaires sont conservées séparément et les faits source sont utilisés avant la nouvelle extraction.

Les observations exposent fraîcheur, décisions, latence p95, durée et consommation. Une alerte est émise à l’ouverture d’un incident et à son rétablissement, sans répétition périodique. Les échecs de livraison restent à reprendre. Vérifier les exécutions du workflow opérationnel récepteur, pas seulement la colonne `delivered`.

## Validation avant activation

La première exécution CI de la PR 124 a validé les migrations depuis zéro, pgTAP, les parcours Playwright, Python 3.11 et 3.12 et CodeQL. Elle a signalé deux écarts de formatage web, corrigés. Les intégrations PostgreSQL couvrent notamment publication atomique, expiration des verrous, générations obsolètes, alertes, budget, checkpoints et panne sans disparition. Les contrôles doivent tous passer sur la révision finale.

L’administration a été vérifiée localement avec une session fictive et des données simulées, y compris le bouton de suspension. Cela ne constitue pas une preuve de production. Les artefacts de diagnostic initial sont conservés dans `docs/audits/diagnostic-production-2026-09-12*` du workspace de diagnostic.

## Qualification restante et critères de sortie

- Déployer et vérifier la version réelle et les migrations ; supprimer la planification mensuelle distante du collecteur Licitor secondaire.
- Activer les deux sources pilotes et vérifier déclenchements, réception d’un incident et de son rétablissement, isolation et reprise effective après interruption.
- Valider factuellement les 100 annonces du diagnostic. L’échantillon initial est une sélection, pas une validation.
- Expliquer individuellement les différences d’inventaire. Le diagnostic initial comporte 717 URL non expliquées ; aucun taux de couverture complet n’est revendiqué.
- Qualifier puis étendre aux autres sources, en respectant leurs refus d’accès et leurs capacités. Vérifier la cadence détaillée de chaque adaptateur et la diminution du reliquat.
- Observer sept jours réels sans relance manuelle, avec au moins 95 % des fiches du périmètre pilote vérifiées à temps, aucun doublon de reprise et aucune contradiction critique connue présentée comme certaine.

Le chantier ne peut pas être clôturé sur la seule livraison du code. L’intervalle d’observation commence après activation prouvée du pilote.

## État réel au 12 septembre 2026, après la première qualification

La PR 124 est fusionnée (`ad3df6028c0e3b57b2e7fcb3f8f99ce8dd824b80`), les six migrations sont appliquées (workflow 34699762104 réussi), et le déploiement `dpl_7WeqUeGM36aACGz7LFVeRryxn25J` est prêt sur immojudis.com. Les cinq contrôles publics passent. Le cron secondaire du projet immojudis-licitor est désactivé (`disabledAt=1789223361085`).

Le pilote a été activé à 14:50:27 UTC. Le tick de 15:00 a déclenché sans intervention le run Licitor `5af869ed-c1f4-469a-be0e-5ca00dc9f80e`, workflow 34700896879. L’alerte `pipeline.enrichment.stalled` a effectivement été reçue par le workflow 34700897507 : résumé publié et signal incident émis. Le workflow récepteur échoue intentionnellement pour signaler un incident.

**Le pilote est actuellement suspendu et la période de stabilité n’a pas commencé.** Avant toute publication, la qualification a révélé que les collectes ciblées ne réutilisent pas encore systématiquement les URL canoniques déjà fusionnées en base. Le contrôle global a été désactivé, `observation_started_at` remis à null, puis la collecte interrompue avec 157 découvertes/checkpoints et aucune publication dans son journal. Il faut corriger et tester la fusion transactionnelle avec les identités existantes avant réactivation. Les détails sauvegardés doivent être repris automatiquement, avec leur vraie date de vérification.

La durée des checkpoints par annonce doit aussi être corrigée/mesurée : la collecte ne doit pas attendre tous les détails avant de publier les premiers lots admissibles. Ne pas perdre les protections de provenance, d’admission et de version en introduisant cette publication progressive.

Le contrôle de 100 annonces est lancé sur la branche `feat/pipeline-pilot-qualification`, PR 125, workflow 34700628712. Ses artefacts sont dans `/private/tmp/immojudis-quality-20260912`. Le premier audit a une erreur d’en-tête Accept pour les API notariales (406) ; la correction utilise le même Accept JSON que les collecteurs et doit être relancée pour le groupe `notarial`. Les refus 403 d’Enchères Publiques restent respectés. Un résultat de parser reste à examiner ; les documents conservés dans l’artefact ne sont pas présentés comme relus.

Cas confirmé : Rouen, annonce `1dc4178d-f27e-41a9-a7dd-a182b29a0308`. Source : https://avoventes.fr/enchere/appartement-cave-a-rouen . Elle distingue 60,37 m² Carrez, 62,34 m² au sol et une cave de 57,06 m² ; la base portait 62,34 Carrez et 117,43 habitable. Deux réserves sourcées ont été ajoutées en production et la synthèse invalidée. Les corrections locales suppriment les conversions implicites superficie→habitable/Carrez, conservent la surface générique avec réserve et passent 1 200 tests Python (29 ignorés sans base). Il reste à vérifier l’attestation de superficie et à appliquer la correction factuelle justifiée.

Le suivi horaire du présent fil est actif : `fiabilisation-des-annonces-immojudis`. Il doit continuer après qualification, puis être arrêté seulement lorsque tous les critères utilisateur sont prouvés. La copie de travail est toujours `/private/tmp/immojudis-reliability-20260912`, désormais branche `feat/pipeline-pilot-qualification`.

### Corrections supplémentaires pendant la qualification

Le run interrompu est bien finalisé `failed` à 15:10:19 UTC ; ses checkpoints restent disponibles. La publication progressive par lots et la réutilisation d'une connexion pour les checkpoints évitent désormais d'attendre toute la source. La résolution transactionnelle conserve l'identité canonique et refuse les anciennes révisions. Une collision est mise en quarantaine individuellement, sans bloquer les autres annonces du lot.

Le diagnostic d'alias révèle 31 URL partagées par plusieurs lignes, concernant 53 fiches distinctes, pas 31 doublons certifiés. Preuve locale : `/private/tmp/immojudis-collisions.json`. Certaines sont de vrais doublons probables à rapprocher ; d'autres associent des biens manifestement différents. Ne pas supprimer ou fusionner cette liste sans vérification. Neuf fiches issues des fusions incohérentes Enchères Immobilières/Gentilly sont mises en quarantaine en production avec l'état antérieur conservé. Les rapprochements par simple commune/date/prix et entre URL distinctes du même éditeur sont désormais refusés. La normalisation rejette une valeur monétaire comme adresse ; 220 anciennes valeurs ont été retirées en production, coordonnées et synthèses invalidées, preuve et réserve conservées.

L'attestation de Rouen a été inspectée visuellement sur ses trois pages. Pages 1–2 : appartement lot 1, Carrez 60,37 m², sol 62,34 m² ; cave lot 7, sol 57,06 m² et Carrez zéro ; total au sol 119,40 m². Aucune surface habitable n'est certifiée. PDF `https://avoventes.fr/public/uploads/cabinet/428/documents/6a96eb63466c1ttt.pdf`, SHA256 `208d2a668484a239bfd096ba9bff7bad0a485f7969fa2442d883758954a3cb5e`. La production porte maintenant Carrez/app 60,37 et habitable null, avec preuves/pages et anciennes valeurs archivées.

La CI de `2af5694` avait échoué sur `quality_flags.includes` (type unknown), corrigé par une vérification de tableau. Validation locale suivante : 1 208 tests Python réussis, 31 ignorés sans base ; 21 tests d'intégration PostgreSQL réussis ; typecheck réussi. Le premier audit complet a été annulé sans résultat Enchères Immobilières. L'audit écrit maintenant sa progression, y compris les fiches non tentées/interrompues. La nouvelle relance notariale doit aussi utiliser l'identifiant de l'URL, les anciens `external_id` ayant parfois été remplacés par ceux d'un alias. Le pilote reste suspendu jusqu'à validation et réconciliation des identités.

La migration `20260912155824_pipeline_source_specific_freshness.sql` corrige le dénominateur et les horodatages : chaque source compte également ses alias fusionnés, mais seule une vérification de ses propres URL peut établir sa fraîcheur. Une date mal formée ou future ne la certifie pas. La présence/indisponibilité concerne aussi les alias déjà connus lorsque leur source échoue. La nouvelle intégration PostgreSQL couvre un alias Licitor ancien malgré une observation Avoventes récente ; 22 intégrations passent désormais. Cette migration doit être appliquée avant le prochain pilote et ne démarre aucune planification.

Les contrôles de surface suivants corrigent `01 ha 00 a 30 ca` (10 030 m², pas 30), refusent d'attribuer la première parcelle d'une série à tout le terrain et acceptent le libellé « Carrez totale ». La suite complète passe désormais 1 210 tests (32 ignorés sans base). L'audit notarial 34703765903 vérifie 6/6 AGRASC et 12/14 Notaires ; les deux URL notariales restantes répondent 400 même avec leur identifiant canonique correct et restent non vérifiées. Le run 34703766845 conserve enfin l'artefact partiel Enchères Immobilières malgré sa limite de 20 minutes ; ne pas le présenter comme un contrôle complet.

Trois anciennes fiches supplémentaires portant déjà une contradiction critique d'identité/procédure sont mises en quarantaine : `a911a0da-4936-4d02-bbcc-53dd9750a885`, `6225a9bf-b147-4c6f-b265-52c799c49c3a`, `d838f5ac-761d-45d4-ac91-79f7bf2aeaf8`. Les sources Enchères Publiques (403) et Enchères Immobilières (timeouts) sont explicitement désactivées avec leur état et motif ; 298 fiches ont reçu une réserve d'indisponibilité, sans déduire de disparition.

Corrections factuelles sourcées en production : Montoire `28b071ea-91d9-4867-ae9d-c9b578a51cba`, habitation 149,68 m², ancienne surface au sol 170,07 retirée du champ habitable, 155,56 m² du commerce retirés du terrain ; Lyon `447ea205-aec6-402a-b104-418ceb88fedf`, surfaces propres aux bureaux retirées des totaux de l'immeuble ; Romilly `fff6c926-7190-4268-9876-63a3eced8509`, terrain 10 844 m² = 10 282 des huit parcelles principales + 562 du jardin, calcul et composantes conservés ; Vidauban `87d6182e-48be-4c00-8a9d-0330dcec5bce`, deux lots distincts (24 000 / 30 000 EUR, Carrez 51,82 / 42,90), occupation globale inconnue et périmètres incertains documentés. Les analyses précédentes sont invalidées.

Le contrôle Le Cannet `5d988d56-a7f5-4df8-a42b-c00a969e5cab` a obtenu la page de recherche Avoventes au lieu d'une fiche. Le parser rejette désormais ce retour sans emprunter un code postal d'une autre annonce et le collecteur conserve les faits connus sans avancer leur fraîcheur. Les ventes explicitement en plusieurs lots portent une réserve de prix/surfaces/occupation par lot. Validation locale finale de cette étape : 1 212 tests Python, 32 ignorés sans base, typecheck/Ruff/formatage réussis. Les 634 écarts Notaires de l'inventaire initial portent tous une date source antérieure au délai de conservation à l'heure du diagnostic ; cela explique leur inéligibilité actuelle, mais ne prouve ni leur vente ni le motif historique de chaque écriture absente. Les 83 autres écarts demandent encore un examen individuel.

## Reprise après la PR 125 et vérifications complémentaires

La PR 125 est fusionnée en `cffb72db7d308dfe16fa726eeebad0bb19441e81` à 18:24:14 UTC. Tous les contrôles de sa révision `0431a00053df6b4e5c4257872276531e126190d5` passent, y compris Python/PostgreSQL et Playwright. Le déploiement `dpl_9F8E7c3mUfdhgVXqUvSsqUdg4re3` est READY/PROMOTED sur immojudis.com ; les cinq contrôles publics passent à 18:26:02 UTC. La migration de fraîcheur est appliquée par le workflow 34710610492, réussi.

Le pilote a été réactivé à 18:26:27 UTC. Le tick de 18:30 a créé le run Licitor `15fff494-7f63-4022-a3ef-878436f0d54c`, workflow 34711375564, démarré à 18:30:49. La période d'observation reste null : il faut prouver les publications et la reprise des checkpoints avant de la démarrer. La branche de travail suivante est `feat/pipeline-reconciliation-and-capacity` dans la même copie isolée.

**Correction de la conclusion provisoire sur les 634 dates notariales :** l'ancien adaptateur choisissait parfois la date d'ouverture des offres. Une ouverture passée ne suffit donc pas à classer une fiche expirée. La correction conserve ouverture et clôture, affiche la clôture pour VNI et suspend l'expiration si l'intervalle est incomplet. Les 200 fiches VNI historiques sans intervalle sont protégées provisoirement en production par une clôture inconnue explicite et une réserve sourcée. La réserve temporaire n'est levée qu'après récupération d'un intervalle valide de la même source. Ne pas compter les 634 comme réconciliées avant le nouvel inventaire avec fenêtres complètes.

Le rapprochement des 717 URL retrouve 87 archives déliées du catalogue (50 Avoventes, 14 Info Enchères, 23 Notaires), toutes avec une date passée. La preuve est `/private/tmp/immojudis-unresolved-bridges.json` ; elle ne certifie pas à elle seule l'absence de report. Les 19 URL sans date dans l'inventaire ni archive sont gelées dans `config/reconciliation-remaining-20260912.json` ; audit en lecture seule 34711288236 réussi, résultats à examiner. Aucun résultat de vente n'est inféré.

Le calcul des dix sources prend 13 632 ms en production (EXPLAIN ANALYZE). La migration `20260912183031_pipeline_freshness_single_scan.sql` matérialise les métadonnées une seule fois et calcule les sources ensemble ; les observations réutilisent ce résultat. Les tests PostgreSQL passent, mais la migration doit encore être vérifiée/appliquée et son gain mesuré.

## Contrôles de 18:45–19:00 UTC

Le pilote Licitor poursuit la publication pendant la collecte : 347 décisions publiées, 3 quarantaines et 22 découvertes en attente au dernier relevé intermédiaire. Ces nombres sont transitoires, pas une couverture certifiée. 125 checkpoints ont été restaurés auparavant.

L'inventaire notarial 34712219345 est terminé : 827 URL sur 35 pages, sans erreur, découverte certifiée ; 818 fenêtres VNI ont une clôture explicite. Les 634 URL absentes du catalogue initial sont toutes retrouvées et leur clôture (non leur ouverture) est antérieure au délai de conservation de 24 heures. Rapprochement individuel : `/private/tmp/immojudis-notarial-reconciliation-closing.json`, preuve source `/private/tmp/immojudis-notarial-closing-inventory-20260912`. Cela explique leur exclusion actuelle, sans inférer « vendue » ni certifier le motif historique d'une suppression.

L'audit complémentaire 34712218123 finit mais les 14 fiches Cessions de l'État restent non vérifiées : après réutilisation de la chaîne TLS existante, elles répondent 403. La réussite du workflow ne vaut pas réussite des fetches. Le contrôleur de cet audit suspend maintenant les appels après deux refus. Les quatre Avoventes sont des audiences passées avec fenêtre de surenchère encore ouverte ; conserver cette distinction. L'AGRASC Nice nécessite encore une preuve de statut/date dans la page Agorastore.

La PR 126 ajoute la publication sans GPS dans les vues authentifiées, en conservant le filtre de coordonnées côté carte, et aligne l'aperçu public sur les reports/quarantaines. Elle dissocie aussi le skip des fiches fraîches de la présence d'un score IA. Les contrôles de fraîcheur source restent obligatoires. Les surfaces notariales non qualifiées deviennent génériques ; les contradictions entre surfaceHabitable et description restent explicites avec leurs deux valeurs et leur provenance. Ces dernières corrections ne sont pas encore déployées.

## PR 126 en production et suite de la qualification

PR 126 fusionnée à 19:00:04 UTC, commit `05bbdfb977f53d00979c76d1ff3aa4a8b28cbb14`, toutes les validations de `0718f2a` réussies. Déploiement production READY/PROMOTED `dpl_4WFUqjV9kpwE8jsmfqoqfe5HqZsp`. Smoke public 5/5 à 19:01:42 UTC. Migrations `20260912183031` et `20260912184452` appliquées par 34712852703, réussi. Mesure fraîcheur groupée : 5723 ms contre 13632 ms auparavant ; 270 fiches sans GPS visibles, zéro quarantaine visible.

Le vrai transport de production Cessions de l'État (variables du relais existant, absentes du premier audit complémentaire) permet le contrôle des 14 URL : toutes portent explicitement « Expiré ». Preuve 34712578397, `/private/tmp/immojudis-reconciliation-production-transport-20260912`. Ne pas confondre ses résultats avec le refus du chemin direct GitHub. Le périmètre complémentaire passe à 83 URL pour vérifier aussi les 64 anciennes archives Avoventes/Info Enchères. L'AGRASC Nice nécessite le décodage du modèle public React déjà géré par le collecteur ; le HTML textuel ne contient que le titre.

À 19:04:20 UTC, Licitor : inventaire complet certifié 643 URL, 609 requêtes réussies, zéro erreur, 619 publications dans la phase finale encore en cours. Les métriques finales et la reprise automatique restent à vérifier.

Relecture indépendante supplémentaire du gel de 100 : `/private/tmp/immojudis-quality-consolidated-100.json`, état catalogue `/private/tmp/immojudis-sample-current-1858.json`. Corrections production : Mazarine 50de9572 Carrez 17.11 au lieu de 11 (espace après virgule), habitable non attestée ; Roanne fa0a1ac7 retire 42 Carrez du total de l'immeuble (seul dernier appartement) ; Revel bb9403b2 terrain inconnu avec réserve 1742 + tiers indivis de 91 versus champ opérateur 92 ; Seyssuel 6a486c10 quarantainé, description explicite « PAS D’ENCHERES SUR CE BIEN » contre catégorie VNI ; Aix 2c760bba réserve 150 habitables description versus 176.89 API ; Toulon 81e0486f réserve postale 83000/83200. Anciennes valeurs et analyses conservées/invalidées. Saint-Fons 8ab46c5c quarantainé : lot 8 à droite et lot 9 à gauche ne sont pas un seul bien. L'autre Saint-Fons 027a9a3e est déjà quarantainé par la reprise Licitor (1er/2e étage, lots et procédures différents).

Nouveau défaut critique détecté : 13 fiches futures portent un résultat d'adjudication, souvent obtenu par extraction d'un jour calendaire ou concaténation de champs. La branche suivante `feat/pipeline-qualified-source-evidence` supprime le champ générique « adjudication » des montants explicites, exige une monnaie pour le libellé générique, et met en quarantaine un résultat associé à une vente future. Il faut encore vérifier/réparer ces 13 lignes et leurs éventuelles preuves statistiques, puis finir la qualification des 100. L'observation de sept jours n'a toujours pas commencé.

Le pilote Licitor a atteint la limite à 19:05:49 UTC après inventaire complet : **632 publiées + 11 quarantaines = 643 découvertes**, aucun reliquat de publication dans le journal. L'état du run reste failed/interrupted, la prochaine tentative est fixée automatiquement à 19:35:51 UTC ; aucune relance manuelle. La fin du journal prouve des appels BAN en série à cette étape. La correction suivante supprime ces appels de la finalisation automatique, les reporte sur les petites tâches d'enrichissement, et ignore les fiches quarantainées dans le worker. Le dernier inventaire complet est donc acquis mais la dernière publication complète n'est pas encore certifiée par une exécution terminée.

Les 13 résultats associés à des audiences futures sont mis en quarantaine avec le montant candidat et l'état antérieur conservés ; aucun prix d'adjudication n'est laissé certain. Parmi eux, six possèdent un bridge statistique : tous restent `outcome_status=unknown`, `training_eligible=false`. Il faut encore qualifier puis republier les faits admissibles de ces fiches.

L'audit 34713266250 a effectivement récupéré les 83 pages. Le modèle public Agorastore de Nice indique une clôture au 10 septembre 2026 à 16:30:29 +02:00 : son exclusion par expiration est expliquée. Fichiers `/private/tmp/immojudis-reconciliation-83-20260912`. Les 64 pages correspondant aux archives Avoventes/Info demandent encore la réconciliation de leur date/statut précis. Tests après correction de finalisation : suite complète 1222 réussites / 32 ignorés sans base, puis 40 tests main/worker réussis avec contrôle du géocodage différé.

Le tableau durable `docs/audits/source-reconciliation-20260912.json` explique les 717 écarts initiaux URL par URL : 635 clôtures explicitement passées, 67 audiences passées (fenêtres de surenchère Avoventes conservées distinctement), 14 expirations explicites Cessions, **1 erreur d'expiration réparée**. Marsannay-la-Côte annonce « VENTE REPORTÉE » sans nouvelle date ; restauration sous verrou du catalogue, ID `d627e042-b521-4207-beac-c374b75f324d`, status postponed, sale_date et échéance de rétention null, visibilité vérifiée. La date du 16 septembre visible ailleurs dans la page appartient à un autre bien. Le parseur extrait désormais l'événement du seul en-tête propre à la fiche.

Vench a démarré automatiquement à 19:15:01 UTC, run `bbe8f435-917d-4e70-9f6f-a71367fdf269`. La défaillance de Licitor n'a pas bloqué l'autre source. Mesure transitoire : Licitor 610/713 fraîches, Vench 540/660 ; la cible 95 % n'est pas atteinte. Il faut rapprocher aussi les anciennes fiches/alias absents des nouveaux inventaires et ne pas avancer artificiellement leur horodatage de contrôle. La période de sept jours reste non démarrée.

Les réserves anciennes de surface, d'occupation et de tribunal deviennent également visibles sans exiger un objet source_conflicts récent. Aucun enregistrement marqué occupation_conflict n'est présenté vacant dans la base au contrôle. Validation locale finale de cette étape : 1223 tests Python réussis (32 ignorés sans PostgreSQL), typecheck réussi, 3 tests du composant qualité réussis.

## Contrôles de 19:27–19:30 UTC

PR 127 intégrée après tous les contrôles réussis, merge `777cbe142acbdb877a19c6f8584b290e5013ed56` à 19:27:00 UTC. Déploiement de production `dpl_ECbGzuAtLSDpjQS7dxpbNHGzTKvK` READY/PROMOTED sur ce SHA ; cinq routes publiques vérifiées à 19:29:17 UTC. Le géocodage différé sera donc pris en compte au prochain run, sans modifier le run Vench déjà commencé.

Le déficit de fraîcheur Licitor est localisé : 103 des 713 fiches actives sont absentes du dernier inventaire complet, toutes de source primaire Licitor. Leur présence est correctement `absent`, mais cette constatation ne vaut pas contrôle de fiche. Un contrôle direct en lecture seule des 103 URL gelées est lancé depuis GitHub avec les accès production : run `34714281896`, branche `feat/pipeline-absent-detail-verification`, configuration `config/absent-licitor-20260912.json`. Il faut examiner les preuves avant toute expiration ou correction. La vérification périodique des fiches connues absentes de l’inventaire reste à intégrer au mécanisme existant ; ne pas considérer le chantier fraîcheur terminé.

Relecture supplémentaire de l’échantillon : Annecy `0c78e2ee` porte désormais une réserve prix API 190000 EUR / description 199000 EUR, et seule la surface explicitement Carrez est conservée comme qualifiée. Villefranque `4c3010d8` : 162.65 m² est le hangar, retiré du terrain ; occupation globale occupied avec détail du seul local déclaré loué. Muret `70a31b6b` : surfaces des parties retirées du total, terrain 998 m² = 891 + 107 des deux parcelles nommées. Trappes `69bfbe7d` : trois lots de vente explicités (25000 / 25000 / 30000 EUR), 34.86 m² du troisième appartement retirés des champs globaux associés au premier prix. Preuves et anciennes valeurs conservées dans `qualification_scope_review`, analyses précédentes invalidées. Ces corrections ne valent pas validation documentaire de tout l’échantillon.
