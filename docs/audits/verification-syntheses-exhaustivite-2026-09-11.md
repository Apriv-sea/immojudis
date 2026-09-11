# Synthèses, sources problématiques et exhaustivité — 11 septembre 2026

Périmètre : contrôle des synthèses, réparations des collecteurs, inventaire individuel des dix sources. Aucune reprise des files historiques, aucun rattrapage de synthèses, aucune écriture en base ni génération IA payante pendant cette repasse.

## Synthèses

Contrôles déterministes intégrés dans [PR118](https://github.com/Aprivi-dev/immojudis/pull/118) : surfaces, montants, pièces, chambres, dates, contradictions simples d’occupation/travaux, formulations promotionnelles et notation scientifique. Les preuves et alertes sont conservées dans `llm_display_evidence_check`. Une synthèse signalée utilise le repli issu des données antérieures au résultat IA rejeté. Les extractions en cache sont recontrôlées avec le contexte source/documentaire disponible.

Échantillon en lecture seule : 31 synthèses, 8 sources, 7 signalements. Exemples : 2 900 m² pour 29 a 31 ca (2 931 m²), 76 m² face à une description et une fiche à 102 m², surface en notation scientifique, formulation « exceptionnelle ». Une date, un montant et un nombre de chambres non retrouvés dans le contexte disponible nécessitent une vérification documentaire ; leur absence ne prouve pas qu’ils sont faux.

Limite : contrôle de faits explicites et de contradictions ciblées. Il ne certifie ni toutes les relations sémantiques ni l’exhaustivité documentaire. Les 31 fiches n’ont pas été modifiées.

## Inventaires publics

Les nombres ci-dessous sont des annonces distinctes produites par les collecteurs en audit des listes, sans consultation des détails. Ils ne représentent pas des insertions en base. Un succès GitHub indique que le rapport a été produit, même si le site répond 403.

| Source | Résultat observé | Preuve / limite | Correctif ou suite |
|---|---:|---|---|
| Avoventes | 264 → 269 | 276 cartes : 3 ventes amiables hors périmètre, 273 enchères. 4 sans localisation exploitable. Aucune pagination publiée détectée. | Codes postaux entre parenthèses récupérés ; exclusions pour localisation désormais comptées et identifiées. |
| Licitor | 653 | 138 requêtes HTTP, parcours des liens dans les zones configurées ; aucun total indépendant. | Une limite de pages atteinte en audit est maintenant une erreur explicite. |
| Vench | 5 → 381 | 58 pages, 686 annonces avant filtre ; 305 exclues faute de surface dans les seules listes. Détails non lus dans cet audit. | Pagination `p=` parcourue, dédoublonnage avant détails, plafond par défaut 100, exclusions mesurées. |
| Info Enchères | 65 → 85 | 5 pages liées parcourues. | Page `snr=1` auparavant ignorée ; liens publiés désormais suivis. |
| AGRASC | 3 → 6 | 9 pages parcourues, filtre des cartes immobilières conservé. | Ne s’arrête plus à la première page ni à une page sans carte immobilière. Opérateurs dédoublonnés. |
| Enchères Immobilières | 242 | 242 correspond au compteur public consulté ; 17 pages non vides puis une vide. Source centrée Grand Sud. Aucun total extrait automatiquement : certificat logiciel toujours faux. | Accès GitHub fonctionnel ; la connexion locale refuse. Ajouter une comparaison automatique au compteur serait la prochaine amélioration. |
| Notaires | 821 | Deux partitions VAE/VNI : 9/9 et 812/812 annoncées par l’API ; 1 et 34 pages. | Seule source certifiée automatiquement à cet instant. JSON sans tableau et totaux contradictoires refusés. |
| Petites Affiches | 0 GitHub ; 658 local | 403 depuis GitHub. Localement, 70 URLs de listes parcourues, dont variantes de la pagination affichée jusqu’à 66. Aucun total indépendant. | Pagination des chemins `-pN.html` corrigée. L’accès serveur demeure à résoudre avec l’éditeur. |
| Cessions État | 0 GitHub ; 232 local | 403 GitHub. Local : 238 URLs avant filtre géographique, 232 retenues ; 23 pages, arrêt sur répétition. | Arrêt à la première page en échec au lieu de 100 ; cartes mises en avant dédoublonnées avant détails. Accès serveur à résoudre. |
| Enchères Publiques | 0 | 403 local et GitHub. La page publique consultable via recherche est une page de découverte ; elle ne démontre pas la récupération du catalogue annoncé. | Flux public autorisé ou accord d’accès nécessaire. Ne pas considérer le collecteur actuel comme exhaustif. |

Le parcours de tous les liens publiés est enregistré séparément de l’exhaustivité : une page vide, un plafond, une réponse mal formée ou l’absence de liens ne certifie pas un catalogue. Les compteurs et refus sont détaillés dans le [rapport JSON](verification-syntheses-exhaustivite-2026-09-11.json).

## Vérification et livraison

- [PR117 — audit manuel sans accès base/IA](https://github.com/Aprivi-dev/immojudis/pull/117), fusionnée.
- [PR118 — preuves des synthèses](https://github.com/Aprivi-dev/immojudis/pull/118), fusionnée, CI complète réussie.
- [PR119 — paginations et couverture](https://github.com/Aprivi-dev/immojudis/pull/119).
- Suite locale : 1 115 tests réussis, 21 ignorés ; Ruff et contrôle du diff réussis.
- [Audit initial des dix sources](https://github.com/Aprivi-dev/immojudis/actions/runs/34597054340).
- [Audit après réparation Vench/Info/AGRASC/Cessions](https://github.com/Aprivi-dev/immojudis/actions/runs/34598130029) sur `284e50f`, complété par les audits locaux Petites Affiches et Avoventes et les tests des corrections suivantes.

Points non résolus : accès GitHub de trois sources ; quatre localisations Avoventes ; exclusion Vench en l’absence de surface ; preuve d’exhaustivité indépendante hors Notaires. Les autorisations antérieures de déploiement ne déclenchent aucune collecte de production ni reprise des files dans cette repasse.
