# Audit capacité du worker et des créneaux d’inventaire — 2026-09-13

## Périmètre et lecture

Cette note complète l’audit OCR sans modifier le code, la base de production ou le
planificateur. Elle mesure le worker autonome et traduit les objectifs du pilote en
débit nécessaire. Les chiffres sont classés ainsi : **observé** vient d’un journal,
**borne** vient des constantes du worker, **estimation** est un calcul à partir de
ces valeurs, et **promesse** est volontairement absente tant que plusieurs runs
stables ne l’ont pas démontrée.

Les preuves principales sont `services/data-pipeline/src/queued_runner.py`, la
migration de claim `supabase/migrations/20260913091614_pipeline_queue_fair_capacity.sql`,
le runbook `docs/runbooks/pipeline-autonomy-progress.md`, le journal du worker
`/private/tmp/immojudis-automatic-retry-worker-34750715142.log` et le diagnostic de
plan `/private/tmp/immojudis-pipeline-performance-diagnostic-20260913.json`.

## Architecture effectivement mesurée

Le chemin autonome appelle `run_enrichment_queue_worker()`. Il exécute les jobs
séquentiellement, avec un claim HTTP à la fois (`limit=1`). La séquence est de cinq
claims `source_detail` puis un claim `enrichment`; si la voie préférée est vide, le
worker essaie l’autre voie. Les limites par défaut sont 90 jobs et 1 200 secondes.
Un passage théorique complet contient donc 75 contrôles source et 15 jobs généraux
(un seul passage par worker), mais la cadence de dispatch est d’un passage toutes
les 30 minutes. Le tick de santé
opérationnelle est à 15 minutes, mais `next_enrichment_at` réarme la voie
enrichissement à 30 minutes : il ajoute du jitter/une tentative de dispatch, pas un
second worker. La borne calendaire
avant inventaire est donc **150 contrôles source/h + 30 jobs généraux/h**, soit
180 jobs mixtes/h (deux passages par heure). Ce sont des bornes arithmétiques :
elles supposent zéro attente de claim, zéro travail long, zéro erreur et 90 slots
effectivement consommés dans chacun des deux passages.

Le chemin de collecte/inventaire est différent : il peut utiliser le pipeline
principal et `PIPELINE_PDF_WORKERS=2` pour ses cibles PDF. Les 54 jobs du journal du
worker autonome ne signifient donc pas « deux PDF en parallèle » ; le worker de
file claim/extrait/finalise séquentiellement.

## Débit observé du run de reprise

Le workflow `34750715142` démarre le worker autonome à
`10:00:57.2119188Z` et journalise sa fin à `10:22:16.5256573Z`, soit 1 279,31 s
(21 min 19 s). Il annonce 54 jobs. Le runbook rapproche ce total de 45 contrôles
source publiés et 9 slots généraux, cohérents avec le ratio 5:1; 52 jobs sont
terminés et 2 sont des erreurs documentaires isolées.

| Mesure | Valeur | Nature et limite |
|---|---:|---|
| Jobs mixtes observés | 54 / 1 279,31 s = **152,0/h** | un seul run, mélange de voies |
| Contrôles source, temps actif du run | 45 / 1 279,31 s = **126,6/h** | composition 5:1, pas une série source dédiée ni un débit calendaire |
| Contrôles source, cadence 30 min | **45/cycle**, soit **90/h** | point observé avant jitter et inventaire; inférieur à 94,4/h |
| Jobs généraux, temps actif du run | 9 / 1 279,31 s = **25,3/h** | estimation de composition, pas un SLA de chaque type |
| Jobs généraux, cadence 30 min | **9/cycle**, soit **18/h** | point observé sur un seul cycle |
| Temps moyen par slot | **23,69 s** | inclut claim, extraction, publication et erreurs |
| Équivalent à budget constant de 1 200 s | **50,7 slots**, dont **42,2 source** | extrapolation ponctuelle, non garantie |

Le débit source calculé sur le temps actif est supérieur aux 80 contrôles/h retenus
dans le runbook, mais le débit calendaire observé sur le cycle de 30 minutes est
90/h, inférieur à la cible de marge 94,4/h. Il ne remplace pas l’hypothèse de
planification : le run est unique, il contient des jobs de coûts très différents
et il se termine avec deux erreurs.
Le débit durable et la fraîcheur de 95 % restent explicitement non démontrés.

Un second journal est un signal de contention, pas un benchmark : entre 10:31:11
et 10:32:01, cinq claims réussissent puis le claim suivant répond HTTP 500 à
10:32:15. Cela confirme qu’un passage peut être interrompu par la réservation
avant d’atteindre sa borne de 90 jobs.

Les 54 claims du run permettent aussi de séparer le travail général du temps de
claim. Les intervalles entre les claims `source_detail` sont majoritairement de
7,8 à 10,9 s, alors que les huit intervalles observables après les slots généraux
sont de 4,8 à 220,5 s (médiane environ 89 s). Les intervalles de 61–221 s
coïncident avec les slots généraux qui peuvent exécuter PDF/OCR; ils ne doivent pas
être imputés au seul SQL de claim. Le journal ne fournit pas un compteur OCR par
slot permettant de promettre un temps moyen général.

## Demande pilote et créneaux inventaire

Le runbook fournit le dimensionnement du pilote : 1 285 URL propres aux sources et
246 URL proches, avec **84,3 contrôles/h** pour la cible 6 h/24 h et
**94,4 contrôles/h** avec la marge 5 h/23 h. Je reprends ces taux comme données de
demande; ils ne sont pas recalculés à partir du seul run de 54 jobs.

| Demande source_detail | Par fenêtre de 6 h | Par 24 h |
|---|---:|---:|
| stricte, 84,3/h | **505,8** contrôles | **2 023,2** contrôles |
| marge, 94,4/h | **566,4** contrôles | **2 265,6** contrôles |

Pour tester l’effet de l’inventaire, j’utilise les créneaux demandés : Licitor
environ 29 min et Vench environ 17 min par fenêtre de 6 h. Cela occupe 46 min,
soit 12,8 % de la fenêtre. Le dispatch, lui, n’offre que 12 ticks de 30 min par
fenêtre de 6 h; sous une hypothèse conservatrice, chaque inventaire consomme un
tick partagé, donc 10 passages worker restent disponibles (40 passages/jour).
Le débit source requis par passage actif devient alors :

| Scénario | Contrôles requis par passage actif | Capacité observée à 45/cycle | Écart quotidien observé |
|---|---:|---:|---:|
| stricte | **50,6** (101,2/h dans les ticks actifs) | 450/j | **−223,2/j** |
| marge | **56,6** (113,3/h dans les ticks actifs) | 450/j | **−465,6/j** |

Avec chevauchement complet, les 12 passages par fenêtre restent disponibles :
45/cycle donne **2 160/jour** (48 cycles × 45),
soit +136,8 par rapport à la demande stricte et −105,6 par rapport à la marge.
Cette différence montre pourquoi la cadence discrète compte; une simple fraction
des heures ne suffit pas. L’architecture et les logs disponibles ne certifient pas
le chevauchement, donc 40 passages/jour est le calcul conservateur.

À titre de comparaison, le repère historique de 80/h du runbook équivaut à 40
contrôles par tick : 1 600/jour avec 40 ticks actifs, soit un déficit de 423,2/j
en stricte et 665,6/j avec marge. Ce repère est une hypothèse de capacité, pas la
mesure du run unique à 45/cycle.

Les timings d’inventaire varient selon le périmètre et la phase comptée. Le run
Licitor overnight couvre environ 30 min de workflow; son résumé mesure 898,48 s de
scrape, 913,49 s de scrape total, 437,91 s d’enrichissement et 300,39 s de
Supabase, avec zéro cible PDF et zéro cible LLM. Le rapport Vench de santé expose
619,97 s (10 min 20) pour la phase source, tandis qu’un autre diagnostic journalise
1 227,0 s (20 min 27) pour la phase Vench. J’emploie donc les 29/17 min fournis
pour la capacité, en les marquant comme créneaux de planification plutôt que comme
une constante du scraper.

## Goulot prouvé et estimation de gain

Le diagnostic SQL en lecture seule localise une dépense de 7 344,596 ms sur la
forme actuelle d’enqueue, contre 3 775,265 ms pour la forme matérialisée candidate,
avec le même ensemble de 598 lignes dues : réduction mesurée 48,6 % du plan et
49,2 % des shared hits. C’est un signal de gain sur la réservation/enqueue, pas un
débit worker promis : les 23,69 s/slot observées comprennent aussi le travail
source, les écritures et les jobs généraux. Le gain de bout en bout sera inférieur
à 48,6 % si la requête n’est qu’une partie du slot; il faut comparer plusieurs runs
après validation de l’égalité des candidats.

Les longues tâches PDF/OCR appartiennent aux slots généraux. Le cas Alata a
checkpointé 75/120 pages avant la limite de budget; il doit continuer les pages
restantes et ne doit pas être compté comme 120 contrôles courts. Les erreurs
documentaires du run de 54 peuvent aussi consommer une tentative sans représenter
un échec de claim. La demande source et le coût OCR doivent donc rester deux
compteurs séparés.

## Ajustement minimal recommandé après l’optimisation SQL

La priorité des ventes proches existe déjà dans l’ordre de claim (fenêtre de 7
jours, puis priorité et âge); je ne recommande donc pas d’ajouter une nouvelle
règle 6 h/24 h dans ce premier audit. Conserver le même worker, le même writer,
le même scheduler et le ratio 5:1. Après validation de la forme SQL candidate,
l’ajustement minimal de capacité à tester est d’utiliser la marge déjà libre entre
la fin du worker et le tick suivant : relever **seulement** la borne de budget du
worker jusqu’à une valeur strictement inférieure à 30 min, avec le même cycle 5:1
et un garde-fou de non-chevauchement. Ce levier ne crée ni writer ni scheduler et
laisse un slot général sur six; il doit rester conditionnel aux mesures, car les
longs jobs OCR peuvent remplir cette marge sans augmenter les contrôles source.

Après la forme SQL candidate, vérifier sur trois cycles comparables : (1) p50/p95
du claim et délai de réservation, (2) passages de 30 min réellement exécutés et
slots source/généraux terminés, (3) pages OCR et secondes par job général,
(4) contrôles dans les tranches 6 h/24 h, (5) erreurs/leases et chevauchement avec
les deux inventaires. Tant que ces mesures ne dépassent pas durablement la cible
avec marge, ne pas transformer les 150 contrôles source/h calendaires théoriques
en promesse et ne pas réduire le slot général.

## Limites

- Le calcul d’occupation suppose un passage d’inventaire Licitor et Vench par
  fenêtre de 6 h et une absence de chevauchement; une concurrence réelle devrait
  être mesurée par leases et timestamps de claims.
- Le run 34750715142 est un échantillon mixte de 54 jobs; il ne mesure ni un débit
  source_detail dédié ni une distribution OCR représentative.
- Les 80/h, 84,3/h et 94,4/h viennent du dimensionnement du runbook. Ils doivent
  être réconciliés avec les observations après optimisation SQL avant toute
  modification de budget ou de fréquence.
- Aucun appel payant, aucune écriture de production et aucun test coûteux n’a été
  effectué pour cette note.
