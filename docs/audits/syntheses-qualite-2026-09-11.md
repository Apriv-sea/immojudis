# Revalidation des synthèses — 11 septembre 2026

- Les synthèses sans version de contrôle qualité ne sont plus considérées comme actuelles par le cache et les sélections Supabase.
- Les extractions déjà enregistrées peuvent être réappliquées pendant une collecte : correction du repli `1,2E+2 m²` en `120 m²`, conservation des contraintes source, sans nouvel appel IA.
- Les clauses source mentionnant non-constructibilité, emplacement réservé, servitude, péril, insalubrité, interdiction d'habiter ou squat sont citées avec leurs négations et réserves. Leur conservation est prioritaire sur le récit dans la limite de 850 caractères/115 mots.
- Si les clauses ne tiennent pas dans le budget, la synthèse est rejetée et les citations restent stockées séparément. Aucun ancien texte n'est alors marqué comme validé.
- La version de contrôle n'est pas une certification sémantique exhaustive : les informations PDF et les autres contraintes ne sont pas couvertes par ce contrôle ciblé.
- Aucun rattrapage massif ni collecte automatique ajouté. Aucun changement de schéma SQL.

## Agorastore

Le détail est présent dans les propriétés JSON publiques de `FicheProduitApp`. L'extracteur lit désormais ces données sans exécuter le JavaScript : identité du produit vérifiée, description et urbanisme, documents PDF et photos CDN autorisés, adresse, surface habitable explicite, occupation libre, première mise à prix et clôture. La seule date de visite exposée par ce modèle est tracée comme `last_visit_only` ; aucune exhaustivité des créneaux n'est supposée. La surface terrain contradictoire reste dans les champs source sans écraser automatiquement la valeur connue.

Canari réel sans base ni IA : trois annonces, trois détails opérateur complets, zéro erreur. Revel : 19 photos, trois PDF, 120 m² habitables, occupation libre, adresse et dernière visite disponible. L'ancien diagnostic « détail Agorastore inaccessible dans le HTML » était incomplet : les données sont intégrées dans un script JSON de la page.

Validation : 1 087 tests Python passants, 21 intégrations ignorées ; Ruff et invariant de collecte manuelle passants.

Pilote de production : résultats ajoutés après CI.
