# Revue efficacité OCR — 2026-09-13

## Périmètre et conclusion

Audit en lecture seule du commit e997725 (fix/qualification-and-document-recovery, PR136), du journal /private/tmp/immojudis-automatic-retry-worker-34750715142.log et d’un échantillon local borné. Aucun appel payant, aucune écriture de production et aucune dépendance installée. Les fichiers PDF locaux sont sous /private/tmp/immojudis-critical-pdfs-20260913/.

Le risque principal est la perte ou la mauvaise qualification d’une page OCR, avant le coût CPU. La priorité est donc :

1. rendre une page fallback_text ou vide explicitement incomplète et réessayable ;
2. distinguer une continuation normale après budget OCR d’un échec de job ;
3. mesurer la qualité par faits extraits avant de modifier DPI, concurrence ou extracteur ;
4. seulement ensuite sélectionner les pages et partager davantage le cache.

Le worktree partagé contient par ailleurs un diff non committé dans pdf_enrichment.py qui ajoute déjà des champs status/retryable. Les constats marqués « HEAD » décrivent le commit audité, pas ce chantier concurrent.

## Fonctionnement actuel observé

1. download_documents télécharge les pièces dans data/documents/{sale_storage_id}/, conserve les métadonnées HTTP et réutilise un téléchargement frais pendant 24 h. Le cache documentaire est adressé par URL, taille et SHA-256 du fichier.
2. _select_documents_for_extraction trie les documents par familles (PV descriptif, diagnostics, conditions de vente, annonce, bail, cadastre), vise six documents par vente par défaut et peut élargir ce nombre pour couvrir les groupes requis. La sélection est documentaire ; toutes les pages d’un document retenu sont parcourues.
3. extract_pdf_pages refuse les PDF de plus de 300 pages, lit le texte PyMuPDF, puis déclenche l’OCR si le texte nettoyé contient moins de 80 caractères. Le budget par passage est de 75 pages OCR (PDF_MAX_EXTRACT_PAGES, valeur par défaut et valeur effective du workflow de production). Chaque page traitée, y compris un repli vide, est écrite dans services/data-pipeline/data/raw/pdf_texts/documents/pages/{cache_key}/{n}.json.
   Le cache de document est écrit document par document, mais le checkpoint de la vente (`_checkpoint_enrichment`) intervient seulement après le retour complet de `enrich_sale_from_pdfs`; une interruption avant ce retour conserve les pages, pas nécessairement l’état enrichi de la vente.
4. Le premier moteur est Page.get_textpage_ocr(language=..., full=True) sans DPI explicite ; le défaut PyMuPDF est donc 72 DPI. Le repli rasterise avec fitz.Matrix(3, 3) (environ 216 DPI) puis exécute Tesseract avec un timeout de 60 s. L’appel PyMuPDF n’a pas de timeout isolable.
5. Le cache page de HEAD accepte tout objet contenant le bon numéro de page et une chaîne text, y compris {text: "", method: "fallback_text"}. Le cache documentaire global, lui, rejette un agrégat vide mais ne connaît pas le statut d’échec page par page. _extracted_document_profile déclare un document « extracted » dès que son texte agrégé est non vide.
6. L’extraction complète et le cache page sont adressés par le contenu du fichier (SHA-256), et le cache documentaire inclut aussi URL et taille. La clé applicative ne décrit toutefois pas explicitement les versions PyMuPDF/Tesseract, le DPI, le mode full, le prétraitement ou les données linguistiques. La fraîcheur de la vente utilise en plus une empreinte URL + libellé et un TTL ; elle ne détecte donc pas à elle seule un changement silencieux des octets derrière la même URL.
7. Deux chemins d’exécution doivent être distingués. Le pipeline inline utilise `ThreadPoolExecutor(max_workers=2)` sur au plus dix ventes PDF (`PIPELINE_PDF_MAX_TARGETS=10`) ; chaque vente traite ensuite ses documents séquentiellement. Le worker autonome du journal claim un seul job par slot (`limit=1`) et traite les jobs séquentiellement, avec cinq slots `source_detail` pour un slot général, au plus 90 slots pendant 1 200 s. Une exception « OCR pass budget reached » est une exception ordinaire : elle passe par l’échec de job et consomme une tentative. Seul PipelineBudgetExhausted est différé sans consommer de tentative.

## Éléments de production

Le journal est un run du 13 septembre 2026, démarré vers 10:00:57 UTC et terminé vers 10:22:16 UTC, soit environ 21 min 19 s.

| Observation | Preuve | Interprétation |
|---|---|---|
| Alata | 10:06:15 : OCR pass budget reached; 75/120 pages checkpointed; retry resumes, puis Document extraction incomplete; retry required | Le plafond est atteint avant la fin ; les pages déjà écrites doivent être reprises, mais la continuation est traitée comme un échec de job. |
| Tentatives | La migration donne max_attempts=4 par défaut | 120 pages nécessitent deux passages nominaux de 75 ; quatre passages restent théoriquement suffisants, mais une erreur transitoire ou une reprise mal qualifiée peut les consommer avant la fin. |
| Volume worker | 54 jobs en 21 min 19 s ; le log utilisateur qualifie 45 source_detail, donc environ 9 jobs généraux par le cycle 5:1 | Ce débit ne mesure pas l’OCR seul : réseau, extraction, écritures et autres familles sont mélangés. |
| File finale | 603 source_detail et 359 PDF en attente ; 3 PDF échoués | Le worker est borné et le backlog persiste ; aucune attribution de temps OCR fiable n’est possible avec ce journal seul. |

Un cache page positif permet normalement de ne pas refaire les pages déjà terminées. En revanche, sur HEAD, une page OCR vide ou le repli fallback_text peut être considérée comme un cache positif. C’est une différence critique entre « page checkpointée » et « page correctement extraite ».

## Mesures locales bornées

Environnement de mesure : venv local /private/tmp/immojudis-pipeline-fixes-venv, PyMuPDF 1.28.0 ; Tesseract local 5.5.2. La production installe Tesseract 5.3.4 sur Ubuntu. Les chiffres ci-dessous sont indicatifs, pas des SLO.

### Chemin courant et cache

Tous les PDF ci-dessous sont des scans sans texte natif ; les premiers passages utilisent le chemin PyMuPDF OCR et fra+eng.

| Échantillon | Pages | Premier passage | Texte | Résultat |
|---|---:|---:|---:|---|
| cannet_affiche.pdf | 1 | 0,87 s | 1 783 caractères | 1 page ocr_pymupdf |
| cannet_pv (10 premières) | 10 | 3,31 s | 5 113 | 0 page vide |
| noisy_ccv (10 premières) | 10 | 4,63 s | 11 475 | 0 page vide |
| noisy_pvd (10 premières) | 10 | 1,42 s | 1 268 | 0 page vide, mais médiane de 21 caractères sur le PDF complet |

La répétition avec le même cache page prend 0,002–0,003 s sur ces cas. C’est une réduction locale de plus de 99 % du temps de chemin chaud, non une garantie de taux de hit en production.

Sur noisy_pvd.pdf (80 pages), le benchmark a appelé directement `_extract_page_text_with_ocr_result` page par page, avec un cache temporaire neuf, afin de comparer les moteurs sans être limité par le budget de 75 pages de `extract_pdf_pages`. Il ne s’agit donc pas d’un passage nominal du worker de production. Le chemin PyMuPDF a pris 10,29 s, avec 76 pages ocr_pymupdf et 4 repliées sur Tesseract ; le chemin Tesseract forcé a pris 45,77 s, avec 78 pages non vides. Le repli forcé est donc environ 4,4 fois plus lent sur cet échantillon, tout en produisant davantage de caractères (8 748 contre 5 852). Le nombre de caractères ne prouve pas une meilleure exactitude.

### DPI et qualité de signal

get_textpage_ocr a été mesuré avec DPI explicite sur les mêmes pages. Le code courant omet ce paramètre et utilise 72 DPI.

| PDF / pages | DPI | Temps | Caractères | Pages <80 caractères |
|---|---:|---:|---:|---:|
| cannet_pv / 10 | 72 | 3,34 s | 5 113 | 4 |
|  | 150 | 5,43 s | 6 828 | 1 |
|  | 216 | 6,80 s | 6 630 | 2 |
|  | 300 | 9,33 s | 7 206 | 0 |
| noisy_pvd / 20 | 72 | 2,56 s | 2 047 | 15 |
|  | 150 | 5,91 s | 5 554 | 2 |
|  | 216 | 7,41 s | 5 492 | 1 |
|  | 300 | 9,96 s | 5 391 | 3 |

Sur ces deux cas, 150 DPI coûte environ +63 % à +131 % contre 72 DPI ; 300 DPI coûte environ +179 % à +289 %. Le signal de texte s’améliore souvent, mais il faut vérifier les faits métier avant de choisir un profil global. Une stratégie plausible à tester est 150–200 DPI explicite, avec reprise ciblée à DPI supérieur pour les pages de mauvaise qualité, plutôt qu’un passage global à 300 DPI.

### Défaut du seuil de 80 caractères

Une fixture locale mixte a été construite à partir d’une page scannée existante et d’un calque texte natif :

- avec 111 caractères natifs (en-tête et pied de page), le seuil courant saute l’OCR et retourne ces 111 caractères ; l’OCR forcé retourne 281 caractères contenant le contenu de la page ;
- avec seulement 26 caractères natifs, l’OCR est déclenché et retourne 280 caractères.

Cela prouve un faux négatif du seuil : une page mixte peut dépasser 80 caractères tout en ayant des faits seulement dans l’image. Cela ne mesure pas la fréquence du défaut dans le corpus de production.

### Cache négatif

Sur un PDF local objectivement vide, avec l’appel OCR simulé pour retourner text="", method="fallback_text", le premier passage écrit cette page dans le cache. Le second passage relit le JSON et n’appelle plus l’OCR (ocr_calls=[0]). Le JSON HEAD n’a ni statut d’échec ni indicateur de retry. Ce résultat a été reproduit indépendamment ; le diff non committé présent dans le worktree tente de le corriger.

## Bottlenecks et risques prouvés

| Priorité | Constat HEAD | Impact | Mesure de validation |
|---|---|---|---|
| P0 fiabilité | Les pages vides/fallback_text sont réutilisables comme hits de cache ; le profil document considère tout agrégat non vide comme extrait. | Une page réellement non lue peut devenir permanente, et un en-tête seul peut masquer un échec OCR. Les retries suivants ne progressent plus forcément. | Fixture vide, OCR qui échoue puis réussit, document mixte avec une page valide et une page en échec ; exiger complete=false et failed_pages. |
| P0 orchestration | « Budget OCR atteint » consomme une tentative normale, contrairement à PipelineBudgetExhausted. | Les gros PDF monopolisent un job et peuvent atteindre quatre tentatives après une erreur transitoire ; le worker ouvre alors un incident inutile. | Fixture 120 pages / budget 75 ; vérifier curseur page, attempt count, lease et reprise sans retraitement des pages réussies. |
| P1 qualité | OCR déclenché uniquement par len(text)<80. | Faux négatifs sur pages mixtes et faux positifs sur en-têtes courts ; pages utiles et coût CPU mal ciblés. | Rappel par champ sur un corpus annoté : surface, pièces, occupation, prix, date, lot. |
| P1 qualité/coût | DPI courant implicite 72, langue toujours fra+eng, full=True. | Le scan local montre moins de texte à 72 DPI ; un DPI élevé global augmente fortement le temps. | Grille 72/150/216/300 par type de page, rappel des faits et secondes/page. |
| P1 ressources | L’appel get_textpage_ocr n’est pas encapsulé dans un processus avec timeout ; seul le repli Tesseract a 60 s. | Un worker peut rester bloqué ou accumuler CPU/RAM ; la concurrence 2 n’est pas un budget de ressources. | Processus isolé avec timeout, RSS et OMP_THREAD_LIMIT ; mesurer à 1/2/3 workers. |
| P2 cache | Les clés page/document contiennent déjà le SHA-256 des octets ; elles ne décrivent pas explicitement versions moteur, DPI, preprocessing ou tessdata. La fraîcheur documentaire utilise URL + libellé et TTL avant de revalider les octets. | Un changement de moteur peut réutiliser une sortie inadéquate ; un changement silencieux derrière la même URL peut rester frais jusqu’à revalidation ; des URL différentes pour les mêmes octets peuvent dupliquer le travail. | Clé versionnée et test même URL / octets changés / moteur changé, y compris pendant le TTL. |
| P2 sélection | Un document sélectionné est parcouru page par page ; aucune sélection de pages fondée sur couverture image, doublons ou annexes. | Les pages photo/annexe consomment le budget OCR sans forcément produire de faits. | Échantillon annoté ; supprimer des pages seulement si le rappel des champs reste inchangé. |
| P2 observabilité | Les logs ne donnent pas systématiquement page, raison du déclenchement, DPI, durée, cache hit/miss, sortie vide et mémoire. | Impossible d’attribuer les 21 minutes du run ou de comparer une optimisation. | Ajouter des compteurs agrégés par document/job sans journaliser le texte OCR. |

## Opportunités et ordre recommandé

1. **Statut et reprise (P0, effort S/M, risque faible).** Séparer extracted, blank_excluded, ocr_failed, incomplete et retryable. Ne jamais valider un cache vide ou fallback_text comme succès OCR. Un échec partiel doit rester visible dans document_analysis.
2. **Continuation bornée (P0, effort M, risque moyen).** Conserver le curseur et les pages réussies, mais classer OCR pass budget reached comme continuation différable : réenfiler le même job à court délai, rembourser la tentative consommée ou utiliser un compteur de passages distinct, puis compter le job comme handled. Une vraie exception OCR reste un échec. Le coût maximal de pages par passage ne change pas.
3. **Instrumentation et corpus de non-régression (P1, effort M, risque faible).** Capturer pages_total, pages_native, ocr_candidates, ocr_attempts, ocr_empty, fallback, cache_hits, seconds, bytes, sha256, version PyMuPDF/Tesseract/langue/DPI et RSS. Les sidecars locaux (cannet_ocr, ocr, annex_ocr) peuvent fournir une référence initiale.
4. **Détection de qualité par page (P1, effort M/L, risque moyen).** Combiner caractères natifs, ratio image/texte, répétition header/footer, densité de mots et sortie OCR courte. Ne supprimer une page qu’après mesure du rappel des champs métier ; le score heuristique actuel n’est pas une confiance OCR.
5. **Profil DPI mesuré (P1, effort S/M, risque CPU).** Tester 150 ou 200 DPI explicite pour les pages OCR, avec retry ciblé à 216/300 si le score de qualité est faible. Garder 72 DPI seulement si le rappel est démontré suffisant pour une famille de documents.
6. **Ressources (P1, effort M, risque opérationnel).** Isoler le moteur dans un sous-processus tuable, borner timeout/RSS/threads et conserver Tesseract comme fallback. Ne pas augmenter PIPELINE_PDF_WORKERS avant cette mesure.
7. **Empreinte et cache partagé (P2, effort M, risque d’invalidation).** Inclure SHA du document, version extracteur, versions moteur, langue, DPI, paramètres et statut dans la clé. Réutiliser les pages positives entre ventes seulement avec une identité de document suffisamment forte ; les échecs doivent avoir une politique de TTL/retry, pas une valeur positive permanente.
8. **Alternatives (P3).** Garder Docling désactivé par défaut. Un A/B local peut le comparer sur les pages où le chemin courant échoue (tables, colonnes, rotation), avec timeout déjà présent, rappel de faits et coût CPU. Aucun bénéfice n’est établi ici pour l’activer globalement.

## Plan de tests avant toute optimisation

- Construire un petit gold set local de cannet, gaillard et noisy avec des faits attendus issus des textes sidecar : surface, Carrez, pièces, occupation, lot, prix et date. Mesurer rappel/precision par champ et par page, pas seulement caractères.
- Tester cache positif, cache vide, fallback non vide, échec puis succès, page objectivement blanche et PDF mixte.
- Comparer DPI 72/150/200/216/300 et fra, fra+eng sur 3–5 familles de page ; consigner faits retrouvés, secondes/page, RSS et taille raster.
- Rejouer un document de 120 pages avec budget 75, interruption après page 75 et erreur transitoire ; vérifier qu’une continuation ne consomme pas les quatre tentatives normales et que les pages réussies ne sont pas retraitées.
- Rejouer un même URL avec des octets différents et un même fichier après changement de moteur ; vérifier invalidation et versionnement du cache.
- Mesurer workers 1/2/3 sur les mêmes fichiers, seulement après stabilisation de la qualité. Aucun test ne doit appeler une source externe ni écrire en production.

## Limites et sources

Les temps locaux ne représentent pas le runner GitHub : versions Tesseract différentes, CPU différent, cache disque différent. Un nombre de caractères supérieur n’est pas une preuve de meilleur OCR. Le journal de 54 jobs mélange les familles et ne permet pas de calculer un coût OCR moyen. La fixture mixte prouve le comportement du seuil mais pas son taux d’occurrence. Les estimations de gain de cache, de coût DPI et de facteur Tesseract sont donc explicitement des estimations d’échantillon.

Documentation primaire consultée : API PyMuPDF Page.get_textpage_ocr (DPI par défaut 72, qualité/temps liés au DPI) et recette OCR PyMuPDF (OCR nettement plus lent que l’extraction texte et recommandation de réutiliser une TextPage).

Liens : https://pymupdf.readthedocs.io/en/latest/page.html#Page.get_textpage_ocr ; https://pymupdf.readthedocs.io/en/latest/recipes-ocr.html
