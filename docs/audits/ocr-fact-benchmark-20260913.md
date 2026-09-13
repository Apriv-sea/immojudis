# Benchmark OCR factuel local — 2026-09-13

## Périmètre et méthode

Benchmark local, sans appel externe, écriture de production ni modification du code. Corpus de cinq pages scannées : deux Cannet, deux Gaillard et une Noisy-le-Sec. Chaque page a été relue contre un sidecar OCR local ou directement contre la page PDF rendue lorsque le sidecar était vide.

Environnement : venv /private/tmp/immojudis-pipeline-fixes-venv, PyMuPDF 1.28.0, Tesseract 5.5.2, OMP_THREAD_LIMIT=1, Python 3.11.16. Pour chaque page, appel direct de Page.get_textpage_ocr(full=True, dpi=..., language=...) à 72, 150 et 200 DPI, avec fra et fra+eng. Ce benchmark isole langue/DPI ; il ne passe pas par le seuil de 80 caractères, le cache ni le budget de 75 pages de extract_pdf_pages.

Le rappel est calculé sur 15 faits annotés. Le texte OCR est normalisé de façon déterministe (minuscules, accents et ponctuation retirés, espaces regroupés) ; les décimales françaises et le symbole m² sont comparés avec séparateurs équivalents. Un fait compte seulement si son motif contextuel exact est retrouvé. Ce n’est pas un score de transcription caractère par caractère.

## Corpus annoté

| Page | Faits attendus | Justification |
|---|---|---|
| cannet_pv.pdf, p.30/31 | appartement meublé et occupé ; occupé par son propriétaire ; surface approximative 65 m² | sidecar cannet_ocr/pv.txt, lignes 420–431 |
| cannet_ccv.pdf, p.11/22 | mise à prix 15 000 euros | sidecar cannet_ocr/ccv.txt, lignes 376–381 |
| gaillard_pv.pdf, p.9/39 | surface Carrez 91,76 m² ; surface au sol 109,10 m² ; DPE note E | sidecar ocr/gaillard_pv.txt, lignes 313–319 |
| gaillard_ccv.pdf, p.1/18 | mise à prix 150 000 euros ; audience du vendredi 19 septembre 2025 | sidecar ocr/gaillard_ccv.txt, lignes 1–17 |
| noisy_pvd.pdf, p.1/80 | adresse 90 boulevard de la République ; Noisy-le-Sec ; lot 17 pavillon ; lot 27 jardin ; lot 13 cave ; lot 12 seconde cave | page PDF 1 rendue localement ; aucun sidecar texte exploitable |

Les cinq pages ont zéro caractère texte natif et au moins deux images ; elles exercent donc réellement le chemin OCR. Les SHA-256 des PDF et les annotations complètes figurent dans le JSON associé.

## Résultats agrégés

| Langue | DPI | Faits retrouvés | Rappel | Pages entièrement correctes | Temps total / 5 pages |
|---|---:|---:|---:|---:|---:|
| fra | 72 | 9/15 | 60 % | 4/5 | 0,986 s |
| fra+eng | 72 | 9/15 | 60 % | 4/5 | 1,495 s |
| fra | 150 | 15/15 | 100 % | 5/5 | 1,910 s |
| fra+eng | 150 | 15/15 | 100 % | 5/5 | 2,447 s |
| fra | 200 | 15/15 | 100 % | 5/5 | 2,218 s |
| fra+eng | 200 | 15/15 | 100 % | 5/5 | 2,934 s |

La page Noisy est le seul échec à 72 DPI : 0/6 faits dans les deux langues. Elle passe à 6/6 à 150 et 200 DPI. Les quatre autres pages obtiennent tous leurs faits à tous les réglages testés.

Sur ce corpus, fra+eng n’ajoute aucun fait retrouvé. Son temps total est estimé à +52 % contre fra à 72 DPI, +28 % à 150 DPI et +32 % à 200 DPI. Le passage de 72 à 150 DPI augmente le temps total d’environ +94 % en fra et +64 % en fra+eng, mais gagne 6 faits sur la page Noisy. Le passage de 150 à 200 DPI n’ajoute aucun fait et coûte encore environ +16 % en fra et +20 % en fra+eng.

## Résultats par page

Les valeurs sont faits retrouvés / faits attendus (secondes).

| Page | fra 72 | fra+eng 72 | fra 150 | fra+eng 150 | fra 200 | fra+eng 200 |
|---|---:|---:|---:|---:|---:|---:|
| Cannet PV p.30 | 3/3 (0,240) | 3/3 (0,323) | 3/3 (0,336) | 3/3 (0,372) | 3/3 (0,404) | 3/3 (0,558) |
| Cannet CCV p.11 | 1/1 (0,245) | 1/1 (0,408) | 1/1 (0,408) | 1/1 (0,518) | 1/1 (0,463) | 1/1 (0,674) |
| Gaillard PV p.9 | 3/3 (0,271) | 3/3 (0,475) | 3/3 (0,495) | 3/3 (0,600) | 3/3 (0,553) | 3/3 (0,708) |
| Gaillard CCV p.1 | 2/2 (0,128) | 2/2 (0,151) | 2/2 (0,174) | 2/2 (0,208) | 2/2 (0,209) | 2/2 (0,252) |
| Noisy PVD p.1 | 0/6 (0,102) | 0/6 (0,138) | 6/6 (0,497) | 6/6 (0,749) | 6/6 (0,589) | 6/6 (0,742) |

## Décision limitée par l’évidence

Sur ces cinq pages, le profil expérimental le plus économe qui atteint le rappel maximal est fra, 150 DPI : 15/15 faits en 1,910 s. fra+eng n’a pas apporté de rappel supplémentaire. Cela justifie un test élargi de fra à 150 DPI et d’une reprise à 200 DPI sur page signalée de faible qualité ; cela ne justifie pas encore un changement de production.

## Limites

- Cinq pages ne représentent pas la distribution des scans, colonnes, tableaux, rotations ou langues du corpus.
- Les sidecars sont des références OCR locales, sauf Noisy p.1 vérifiée visuellement sur le PDF ; ils ne constituent pas une annotation humaine indépendante complète.
- Le rappel porte sur des faits choisis et ne mesure ni les faux positifs, ni la ponctuation, ni la qualité de toute la page.
- Les appels directs ne mesurent pas le temps de téléchargement, le cache, le seuil de sélection, le budget de 75 pages, la mémoire ou le worker autonome. La version Tesseract locale diffère de la production.
