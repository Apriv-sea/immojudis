# Correctifs collecte et enrichissement — 11 septembre 2026

Implémentation locale. Aucun déploiement, migration de production, backfill payant ou nouveau schedule effectué.

## Livré

- Checkpoint en base après chaque résultat PDF et IA du scan ; checkpoint par annonce du backfill. Publication de reprise avec `refresh_last_seen=False`.
- Plafond de synthèses à 20 par défaut, y compris hors GitHub. Le reliquat reste en file.
- Rejet des jobs factuels contenant des erreurs, couverture incomplète ou synthèse manquante. Un repli rédactionnel reste exploitable mais n’est plus marqué comme synthèse IA actuelle.
- Cache global limité aux extractions complètes ; cache atomique des chunks validés. Une nouvelle tentative réutilise les morceaux réussis. Versions de prompts intégrées à l’identité du cache et des jobs.
- Supervision de toutes les générations de jobs, annonces futures sans synthèse, sources anciennes et runs bloqués. Les jobs annulés ne comptent pas comme erreurs ou retards.
- Finaliseur GitHub limité à l’identifiant du run courant : clôture un run inachevé sans écraser sa progression ni toucher aux autres runs.
- Sauvegarde du cache documentaire/IA même après échec du workflow, lorsque le runner exécute encore ses étapes finales. Ce cache ne remplace pas une archive durable.
- Publication GitHub exigeant PostgreSQL transactionnel. Dans cette transaction, Python devient propriétaire de l’enfilement ; le trigger SQL reste un secours pour les autres écrivains.
- Migration `20260911091913_reliable_enrichment_queue.sql` : annulation tracée des révisions obsolètes et ventes inactives/passées ; priorités homogènes, urgence et vieillissement. Aucun effacement de l’historique des jobs. La migration préserve les permissions service_role et ne crée pas d’accès navigateur.
- Condition sur le numéro de tentative lors de la finalisation d’un job : un ancien worker ne peut plus clôturer une nouvelle tentative.
- Accès IA initialisé seulement si nécessaire ; erreur de chargement d’une annonce isolée au lot concerné.
- PDF numériques jusqu’à 300 pages ; budget OCR par passage, cache par page adressé par contenu, reprise sur les pages restantes. Au-delà de 300 pages : refus explicite. Les limites OCR restent soumises au nombre maximal de tentatives.
- Téléchargement documentaire réellement borné pendant la lecture du flux ; plafond GitHub à 50 Mio. Aucun chargement préalable illimité du corps HTTP.
- Reprises HTTP bornées sur erreurs réseau/transitoires, sans répétition des 403 ni des certificats invalides ; respect des délais Retry-After numériques courts, report des délais longs.
- Cessions État : intermédiaire officiel Sectigo OV R36 ajouté au client de cette source, avec validation racine et hostname conservée. Requête réelle validée HTTP 200.

## Validation

Suite complète sur Python 3.11 avec credentials production neutralisés et PostgreSQL 17 jetable. Tests spécifiques : interruption après première synthèse, chunks partiellement échoués, contexte tronqué, reprise OCR, téléchargement trop volumineux, expiration de tentative, migration de file, rollback réel et finalisation ciblée de run.

Dernière mesure avant clôture : 1 034 tests passants, 14 ignorés (intégrations non configurées). Avertissements de dépréciation PyMuPDF/SWIG uniquement. Contrôle de collecte manuelle et `git diff --check` passés.

## Sources et limites restantes

Canaris HTTP locaux du 11 septembre : Cessions État 200 après correction TLS ; Petites Affiches 200 ; Enchères Immobilières 200 ; Enchères Publiques 403. Ces canaris ne prouvent ni l’accès depuis GitHub ni l’exhaustivité d’une collecte.

AGRASC lit encore les cartes AGRASC : l’enrichissement des pages propres aux opérateurs demande des adaptateurs et fixtures dédiés. L’exhaustivité des listes Avoventes/Vench et des sources paginées reste à qualifier sur des captures source datées. Le 403 Enchères Publiques demande un accès/flux autorisé ; aucun contournement ajouté.

La migration et le code doivent être déployés ensemble, puis validés par un lot pilote. L’audit du stock de production reste inchangé tant qu’aucun rattrapage n’est exécuté. Les 480 synthèses manquantes ne sont donc pas déclarées résolues.

## Mise en service

1. Revue du diff ciblé, application de la migration puis du code/workflow ; conserver un seul workflow écrivain.
2. Collecte pilote limitée sur une source accessible ; vérifier les checkpoints, les faits et la fraîcheur.
3. Worker manuel `enrichment_only=true` ; surveiller backlog, annulations de révisions et nouveaux échecs. Le contrôle de santé restera rouge tant que les retards et sources anciennes persistent.
4. Étendre par lots ; vérifier en production le taux de synthèses et la couverture documentaire avant de déclarer la remise à niveau complète.

Aucune promesse de synthèse complète fondée sur le seul JSON valide. Une information absente des sources ne doit pas être inventée.
