# Refonte du catalogue des ventes — recette du 11 septembre 2026

final result: passed

## Cible et preuves

- Source : `docs/design/sales-redesign/reference.png` (maquette validée, 1487 × 1058).
- Implémentation : `docs/design/sales-redesign/desktop.png` (capture navigateur 1473 × 1047, viewport CSS 1488 × 1058 ; capture fournie par le navigateur à une échelle légèrement différente).
- Comparaison normalisée : `docs/design/sales-redesign/comparison.png`, chaque vue ramenée à 1488 × 1058, sans chrome navigateur ajouté.
- Région détaillée : `docs/design/sales-redesign/comparison-detail.png`, navigation, filtres, compteur et première annonce.
- Mobile : `mobile.png`, `mobile-map.png`, `mobile-filters.png` dans le même dossier, viewport CSS 390 × 844.
- Route : `/sales`, thème clair. Maquette avec données illustratives et accès Analyse ; recette locale avec les vraies données publiques. Les différences de nombre, photos, dates et droits sont attendues et ne constituent pas une comparaison pixel à pixel du contenu.

## Surfaces vérifiées

- Typographie : titres et villes en police d’affichage existante, interfaces en sans-serif ; hiérarchie ville / caractéristiques / mise à prix / date. Pas de débordement horizontal à 390 ou 1488 px.
- Espacement : liste à gauche (52 %), carte à droite (48 %), trois annonces complètes sur desktop. Sur mobile, première annonce à environ 312 px, filtres et carte accessibles.
- Couleurs : blanc, marine et cuivre ; carte Mapbox Streets claire, noms français ; sélection signalée en cuivre. Couleurs sémantiques des procédures conservées.
- Images : vraies photos du catalogue et cartes de secteur identifiées. L’absence de photo est explicitée. Les photos de la maquette n’ont pas été utilisées pour illustrer de faux biens.
- Contenu : « Mise à prix » conservé ; chambres distinctes des pièces ; tri par date de vente correctement nommé ; visite basée sur une information de visite ; échantillon cartographique et accès protégés explicités.

## Itérations et corrections

1. P2 — En-tête et statistiques trop hauts : résumé compact, tri adjacent et statistiques repliées. Preuve finale : `desktop.png`.
2. P2 — Carte grise et libellés anglais : style Streets, langue française et prix des marqueurs agrandis. Preuves : `desktop.png`, `mobile-map.png`.
3. P2 — Trop d’espace avant la première annonce mobile : recherche, filtres et alerte réunis sur une ligne. Preuve après correction : `mobile.png`.
4. P1 — Liste limitée aux marqueurs chargés et filtres avancés après pagination : liste paginée indépendante, filtrage complet avant pagination, décompte partagé. Tests de recherche au-delà des 100 premiers candidats.
5. P1 — Période absente : bornes serveur avant comptage et pagination, jours Europe/Paris, liens et alertes conservés. Recette : 265 résultats entre le 11 et le 30 septembre.
6. P2 — Échap et focus : Dialog Radix sur filtres et carte mobile ; retour du focus vérifié sur le bouton d’ouverture des filtres. Test de régression ajouté.
7. P2 — Saisies successives susceptibles d’être écrasées par l’URL : les navigations internes ne réinitialisent plus le brouillon en cours.

Aucun P0/P1/P2 ouvert après comparaison et recette. Les différences intentionnelles de densité et d’information suivent les données et droits réels du produit.

## Parcours vérifiés

- Ville Bordeaux : deux annonces de Bordeaux, carte recentrée.
- Période 11–30 septembre : 265 résultats ; notaire : 27 ; budget maximum 100 000 € : 10 ; maisons : 4.
- Budget maximum 1 € : état vide explicite ; réinitialisation rétablit 935 résultats publics.
- Pagination : page 2, positions 25–48 / 935 ; focus sur les résultats et retour en haut. Retour page 1.
- Comparaison : sélection de deux biens, tableau comparatif, fermeture et effacement.
- Mobile : carte plein écran, retour liste, ouverture/fermeture des filtres, boutons visibles.
- Console de la recette finale : aucune erreur.
- Données privées : refus de l’occupation avec rôle anon sur la nouvelle RPC. Recette interactive effectuée en visiteur ; export CSV, enregistrement d’alerte et favoris payants couverts par les tests existants, sans création de données utilisateur pendant la recette.

## Validation technique

931 tests unitaires réussis, 3 ignorés ; typage, lint, invariants de sécurité, collecte manuelle, build et budgets vérifiés. Migration additive `20260911081621_sales_search_date_range.sql`, ancienne RPC v3 conservée. Compteur SQL public de période comparé directement aux données : 265.

## Ajustements facultatifs

- P3 : pictogrammes de types de vente et avatar de compte, absents de cette navigation compacte.
- P3 : enrichissement des photos manquantes, hors refonte de la page.
