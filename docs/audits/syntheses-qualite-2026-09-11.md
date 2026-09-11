# Revalidation des synthèses — 11 septembre 2026

- Les synthèses sans version de contrôle qualité ne sont plus considérées comme actuelles par le cache et les sélections Supabase.
- Les extractions déjà enregistrées peuvent être réappliquées pendant une collecte : correction du repli `1,2E+2 m²` en `120 m²`, conservation des contraintes source, sans nouvel appel IA.
- Les clauses source mentionnant non-constructibilité, emplacement réservé, servitude, péril, insalubrité, interdiction d'habiter ou squat sont citées avec leurs négations et réserves. Leur conservation est prioritaire sur le récit dans la limite de 850 caractères/115 mots.
- Si les clauses ne tiennent pas dans le budget, la synthèse est rejetée et les citations restent stockées séparément. Aucun ancien texte n'est alors marqué comme validé.
- La version de contrôle n'est pas une certification sémantique exhaustive : les informations PDF et les autres contraintes ne sont pas couvertes par ce contrôle ciblé.
- Aucun rattrapage massif ni collecte automatique ajouté. Aucun changement de schéma SQL.

Validation et pilote de production : résultats ajoutés après CI.
