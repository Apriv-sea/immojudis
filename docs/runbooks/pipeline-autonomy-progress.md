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
