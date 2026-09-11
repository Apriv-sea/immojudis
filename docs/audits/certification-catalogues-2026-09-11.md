# Certification technique des catalogues publics — 11 septembre 2026

## Refus depuis GitHub Actions

Les sites refusent les requêtes avant que le collecteur obtienne leurs annonces. Les réponses capturées dans l’[audit GitHub](https://github.com/Aprivi-dev/immojudis/actions/runs/34600285994) donnent les preuves suivantes :

| Source | Réponse depuis GitHub | Comparaison locale |
|---|---|---|
| Petites Affiches | 403, `server: cloudflare`, `cf-mitigated: challenge`, page « Just a moment… » demandant JavaScript et cookies | Catalogue accessible ; 658 annonces vérifiées |
| Enchères Publiques | Même challenge Cloudflare sur la page des ventes | Le collecteur local était également refusé |
| Cessions État | 403 « Access Denied », référence de diagnostic sur `errors.edgesuite.net` | Catalogue accessible ; 238 annonces vérifiées après correction |

`cf-mitigated: challenge` identifie une page de contrôle [Cloudflare](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/). `edgesuite.net` est un domaine de la plateforme [Akamai](https://techdocs.akamai.com/edge-hostnames/docs/edge-hn-terminology).

Les règles exactes (IP, réputation, pays, caractéristiques du client ou combinaison) ne sont pas connues : il faudrait les journaux des éditeurs pour les déterminer. L’écart local/GitHub démontre une dépendance à l’environnement, pas un défaut de parsing. Aucun CAPTCHA, contrôle d’accès ou espace privé n’a été contourné. Les pistes opérationnelles sont un flux autorisé ou une autorisation de collecte auprès de l’éditeur ; les collecteurs doivent conserver le refus comme un échec explicite.

## Ce qui est certifié

Certificat daté, limité au catalogue public exposé par les pages configurées pendant l’audit. Ce n’est ni un instantané atomique du serveur, ni une certification des pièces privées, des champs détaillés, des synthèses ou de la présence en base. Le contrôle compare compteurs publiés, pages terminales, cartes/identifiants reconnus et sorties du collecteur. Les budgets, erreurs, plafonds et écarts interdisent un certificat complet.

| Catalogue | Référence publiée / contrôle | Résultat |
|---|---|---|
| Avoventes | 276 cartes = 273 enchères + 3 ventes amiables hors périmètre | **273/273 enchères reconnues et retenues** ; quatre fiches publiques lues pour compléter leur département |
| Licitor | 671 lignes réparties sur six zones ; deux répétitions identiques ; 669 contenus d’annonce distincts sous 653 URL | **671/671 lignes expliquées, 669 contenus d’annonce conservés dans 653 fiches** ; les lots partageant une URL restent séparés dans `source_lots` |
| Info Enchères | Compteur 85 ; cinq pages | **85/85 reconnues et retenues** |
| Petites Affiches | Pages 1 à 66 ; toutes les cartes identifiées | **658/658 reconnues et retenues depuis la connexion locale** ; refus GitHub inchangé |
| Cessions État | Pages annoncées 0 à 21 ; 238 identifiants publics ; page supplémentaire répétée | **238/238 reconnues et retenues depuis la connexion locale** ; refus GitHub inchangé |
| Notaires | Totaux API VAE 9 et VNI 812 | **821/821 reconnues et retenues** |
| Vench | Compteur 687 | **Détection 687/687** ; sortie des listes **382**, avec **305 exclusions de surface**. Pas de certification de conservation complète |
| AGRASC | Section immobilière, pages annoncées 0 à 5 | **8/8 fiches encore liées récupérées**. **24 cartes d’anciennes ventes marquées vendues, sans lien**, restent hors collecte. Certificat limité aux fiches accessibles ; pas au catalogue avec toutes ses archives |
| Enchères Immobilières | Le relevé antérieur comptait 242 annonces ; cette repasse subit des délais dépassés | **Non certifié à cette nouvelle date**. Le rapprochement ancien ne prouve pas le catalogue actuel |
| Enchères Publiques | Challenge Cloudflare ; aucun catalogue reçu par le collecteur | **Non certifié** |

Les nombres sont des sorties d’audit, pas des insertions en base. Les [preuves JSON](certification-catalogues-2026-09-11.json) contiennent dates UTC, compteurs, indices de pages, empreintes, réponses de refus et limites de chaque contrôle. La réussite du workflow signifie que le rapport a été produit ; elle ne signifie pas que toutes les sources sont certifiées.

## Correctifs issus du rapprochement

- AGRASC : séparation de la section immobilière ; reconnaissance des codes postaux à cinq chiffres et du `O6` présent dans la source. Huit fiches accessibles récupérées.
- Cessions État : départements corses et sans zéro initial reconnus ; dernier département accepté quand titre et URL concordent. Six annonces récupérées.
- Avoventes : les fiches sans département sont consultées avant exclusion. Seule la description du bien sert à récupérer les codes ; l’adresse de l’avocat est ignorée. Quatre annonces récupérées.
- Licitor : les lots d’une même URL sont conservés, y compris entre pages, et transmis avec la fiche détaillée. Deux lignes strictement identiques sont identifiées comme répétitions, sans inventer de lots.
- Enchères Immobilières : arrêt à la première page en échec au lieu de poursuivre des pages indisponibles.
- Audit : preuves HTTP des refus, compteurs par source/zone, distinction détection/conservation/base, et option limitée de résolution des localisations Avoventes.

[PR120](https://github.com/Aprivi-dev/immojudis/pull/120). Validation locale : **1 130 tests réussis, 21 ignorés**, Ruff. Les contrôles de catalogue sont en lecture seule ; aucune file historique, collecte de production, écriture en base ou génération IA n’a été lancée. Seules quatre pages détaillées Avoventes ont été utilisées dans l’audit final pour résoudre leurs localisations.
