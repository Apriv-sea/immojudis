# Correctifs après repasse des sources — 11 septembre 2026

## Changements

- Archivage : RPC paginée par UUID, lots de 25 au maximum, reprise idempotente et contrôle de couverture avant suppression. L'ancienne RPC reste compatible. Le fuseau par défaut Europe/Paris évite l'énumération de toutes les zones à chaque ligne ; les autres fuseaux conservent la validation IANA.
- Collectes ciblées/limitées : publication sans maintenance globale ni suppression de doublons secondaires. Les gardes SQL de protection de l'historique restent actives.
- Avoventes : description extraite des sections du bien ; retrait des commerces voisins et comparables DVF du contexte. La description détaillée remplace celle de la carte.
- Cessions État : DOM actuel, date/heure d'adjudication, visites libres, véritables PDF ; retrait du lien institutionnel pris pour une pièce jointe.
- Info Enchères : occupation au pluriel, priorité au lot explicitement libre malgré un bail foncier, heures d'audience ; exclusion des icônes de navigation.
- Vench/Petites Affiches : exclusion des publicités, CAPTCHA, kiosque et CGV ; état de restriction du détail public.
- Notaires : une panne du détail ne supprime plus le résumé collecté ; conservation des champs connus manquants et de la description détaillée précédente, sans écraser le nouveau prix de liste.
- AGRASC : lecture de l'API publique Notaires pour les liens Immo-interactif, identité vérifiée et origine AGRASC conservée ; dates de début/fin tracées, clôture conservée pour la date de vente. Lecture de la photo Product JSON-LD pour Agorastore, avec état explicitement partiel.
- IA : statut accepté/repli/rejeté enregistré et compté ; surfaces du repli sans notation scientifique.
- Fraîcheur : version d'extracteur dans les contrôles de source. Une ancienne version force la relecture. Les images supprimées par un détail frais ne sont pas réinjectées depuis le cache connu.

## Vérifications

- Python : 1 070 tests passants, 21 ignorés (intégrations non configurées).
- PostgreSQL/Supabase local isolé : 745 assertions pgTAP passantes, dont permissions, lot borné, précision monétaire, reprise, curseur et validation des fuseaux. Projet/volumes distincts de la base locale existante.
- Benchmark local annulé : 1 000 annonces synthétiques, 40 lots, maximum 0,053 s par lot, total 1,015 s sous `statement_timeout=8s`.
- Relecture des captures publiques : Avoventes, description 1 003 caractères ; Cessions État, adjudication le 05/11/2026 à 15h30 Paris et trois PDF ; Info Enchères, lot lyonnais classé libre et zéro icône importée.
- AGRASC réel, sans écriture ni IA : trois cartes, un détail opérateur complet, deux détails partiels, zéro erreur. La fiche Évry apporte notamment 140 m² habitables, 1 623 m² de terrain, adresse et instructions de visite.
- Ruff, contrôle de collecte manuelle et vérification du diff passants.

## Production

Migration `20260911100401_bounded_outcome_bridge` appliquée. Accès `anon` refusé et `service_role` conservé. Reproduction du cas bloquant sur les 1 060 lignes réelles avec la limite de huit secondes : succès, 229 nouveaux liens préparés et 831 réutilisés ; transaction annulée. Les timeouts globaux des rôles API n'ont pas été modifiés.

Déploiement du code et pilote : résultats ajoutés après les contrôles CI.

## Limites restantes

- Agorastore : le HTML public expose la photo et des métadonnées, pas encore le détail dynamique complet.
- Enchères Publiques : accès 403 constaté lors de l'audit ; Enchères Immobilières : connexion refusée depuis le poste local. Aucun contournement ajouté.
- L'exhaustivité nationale de chaque source n'est pas certifiée par ces canaris bornés.
- La présence d'une description ne suffit pas à certifier une synthèse actuelle. Les anciens stocks nécessitent encore un rattrapage suivi.
- Aucun rattrapage massif ni nouvelle collecte automatique ajouté.
