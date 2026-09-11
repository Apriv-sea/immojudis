SYSTEM_PROMPT = (
    "MODE EXTRACTION STRICTE. Ne produis aucune étape intermédiaire. "
    "Commence immédiatement par { et termine par }. "
    "Tu es un extracteur de données spécialisé dans les ventes aux enchères "
    "immobilières judiciaires françaises. Tu agis comme un analyste de due "
    "diligence : tu identifies les faits importants, leur source, les "
    "contradictions et les incertitudes. Tu extrais toutes les mesures explicites "
    "pièce par pièce et lot par lot, avec leur preuve exacte. Tu ne dois jamais "
    "compléter, arrondir ou inventer une mesure. Le calcul arithmétique et le choix "
    "de la surface canonique sont réalisés ensuite par un validateur déterministe. Si une information est "
    "absente, contradictoire, illisible ou ambiguë, retourne null ou unknown, "
    "signale l'incertitude et baisse fortement la confiance. Réponds uniquement "
    "avec un objet JSON valide, sans markdown, sans commentaire et sans texte "
    "avant ou après."
)

DISPLAY_DESCRIPTION_SYSTEM_PROMPT = (
    "MODE SYNTHESE STRICTE. Réponds uniquement avec un objet JSON valide. "
    "Tu rédiges une description courte, neutre et factuelle pour une fiche "
    "ImmoJudis à partir de faits explicitement présents dans le contexte fourni. "
    "N'invente jamais une surface, une occupation, un état, un risque ou une "
    "annexe. Si les données fiables sont rares, reste court."
)


def build_user_prompt(context_text: str) -> str:
    return (
        "Voici le texte extrait de l’annonce source originale et des documents PDF d’une vente immobilière judiciaire. "
        "Extrais les informations structurées selon le schéma demandé. Ne fais aucune "
        "supposition non justifiée. La réponse doit commencer par { et se terminer par }. "
        "Aucun markdown, aucune explication hors JSON.\n\n"
        "Règles anti-hallucination obligatoires :\n"
        "- N'extrais une valeur que si elle est explicitement écrite dans le texte fourni.\n"
        "- N'utilise pas tes connaissances générales, le nom de la ville, le type d'annonce ou des habitudes de marché.\n"
        "- Si le texte contient plusieurs valeurs contradictoires pour le même champ, conserve les valeurs dans explicit_surfaces/contradictions et retourne le champ scalaire null.\n"
        "- Si une valeur semble venir d'un tableau de diagnostics, d'un DPE, d'une page, d'un article ou d'un numéro de lot, ne l'utilise pas.\n"
        "- Ne convertis pas les ares/centiares en m² sauf si le document donne explicitement une surface en m².\n"
        "- Les champs texte doivent rester courts et citer les mots utiles du document quand c'est possible.\n\n"
        "Séparation des responsabilités :\n"
        "- Cette passe extrait uniquement des faits. Laisse display_description à null.\n"
        "- Une seconde passe rédigera la synthèse à partir des faits validés.\n\n"
        "Règles surfaces :\n"
        "- surface_m2 doit représenter la surface principale du bien, pas une surface de terrain, garage, cave, dépendance, local annexe ou piscine.\n"
        "- Pour un appartement, privilégie une surface loi Carrez explicitement mentionnée.\n"
        "- Pour une maison, privilégie une surface habitable explicitement mentionnée.\n"
        "- Pour un terrain/parcelle, utilise une contenance uniquement si le bien est clairement un terrain.\n"
        "- N'effectue aucune somme toi-même : extrais chaque pièce dans assets[].spaces. Le serveur vérifiera et calculera le total.\n"
        "- Pour chaque logement, local ou lot distinct, crée un asset_id stable dans cette réponse. Ne mélange jamais deux logements.\n"
        "- Pour une surface globale explicitement écrite, utilise assets[].explicit_surfaces et indique son type exact.\n"
        "- Une surface écrite m³ dans un passage parlant clairement de surface doit garder unit_as_written=m3 ; ne corrige pas silencieusement l'unité.\n"
        "- included_in_habitable_sum doit être false pour garage, cave, grenier non aménagé, parking, balcon, terrasse, jardin et terrain.\n"
        "- measurement_completeness vaut complete seulement si le document présente clairement la composition exhaustive ; partial si certaines pièces ne sont pas mesurées.\n"
        "- Si seule une surface annexe est visible, retourne surface_m2 null et confidence.surface_m2 0.\n\n"
        "Règles pièces et chambres :\n"
        "- rooms_count correspond au nombre de pièces principales. T3 signifie 3 pièces.\n"
        "- F3, type 3, type trois signifient aussi 3 pièces principales.\n"
        "- bedrooms_count correspond uniquement aux chambres explicitement mentionnées.\n"
        "- Ne déduis pas bedrooms_count depuis rooms_count.\n"
        "- Compte les chambres quand le texte dit par exemple deux chambres, 3 chambres, chambre n°1/chambre n°2.\n"
        "- Ne compte pas cuisine, salle de bains, WC, dégagement, couloir, cave, garage ou terrasse comme pièces principales.\n"
        "- Studio signifie rooms_count 1. Ne mets bedrooms_count à 0 que si le texte indique clairement studio ou absence de chambre séparée.\n\n"
        "Règles occupation :\n"
        "- vacant uniquement si le texte dit libre, vacant ou inoccupé.\n"
        "- rented uniquement si le texte mentionne bail, location, loyer ou locataire.\n"
        "- owner_occupied uniquement si propriétaire occupant est explicitement écrit.\n"
        "- occupied si occupé est mentionné sans précision fiable.\n"
        "- Si des passages se contredisent, retourne unknown.\n\n"
        "Règles risques :\n"
        "- legal_risks et physical_risks doivent contenir uniquement des risques explicitement mentionnés.\n"
        "- Une simple clause standard du cahier des conditions ne suffit pas à créer un risque.\n"
        "- servitudes ne doit contenir que les servitudes explicitement citées.\n"
        "- works_needed doit rester null sauf si le texte décrit clairement des travaux, dégradations, ruine, vétusté ou désordres.\n\n"
        "Règles confidence :\n"
        "- 0.90 à 1.00 : valeur explicite, proche d'un libellé clair.\n"
        "- 0.70 à 0.89 : valeur explicite mais contexte un peu bruité.\n"
        "- 0.55 à 0.69 : valeur plausible mais faible; évite cette zone sauf nécessité.\n"
        "- 0.00 à 0.54 : absent, ambigu, contradictoire ou incertain.\n"
        "- Toute valeur non null doit avoir une confiance cohérente avec une preuve textuelle claire.\n\n"
        "Règles preuves :\n"
        "- Pour chaque champ non null ou chaque risque retenu, remplis evidence avec une citation courte du texte.\n"
        "- La citation doit être copiée depuis le texte fourni, sans reformulation.\n"
        "- Si le contexte indique une annonce source, un document ou une page, renseigne document_label et page_number quand disponible.\n"
        "- Si tu n'as pas de citation claire, laisse la valeur null/unknown.\n\n"
        "Règles due diligence premium :\n"
        "- investment_facts doit lister uniquement des faits vérifiables utiles à l'investisseur.\n"
        "- Chaque fait doit avoir status confirmé, infirmé ou incertain.\n"
        "- contradictions doit signaler les conflits entre annonce, PV, CCV, diagnostics ou autres pièces.\n"
        "- analysis_questions doit répondre aux questions métier clés : occupation, surface, travaux, diagnostics, servitudes, liquidité.\n"
        "- scoring_guidance doit expliquer l'impact probable sur le scoring, sans inventer de prix de marché.\n"
        "- Un mot isolé comme plomb, travaux ou servitude ne suffit jamais : explique le contexte exact.\n\n"
        "Schéma JSON attendu, sans markdown et sans commentaire :\n"
        "{\n"
        '  "property_type": "apartment|house|building|land|commercial|parking|mixed|other|unknown|null",\n'
        '  "display_description": null,\n'
        '  "surface_m2": 0.0,\n'
        '  "assets": [\n'
        '    {\n'
        '      "asset_id": "asset-1",\n'
        '      "lot_labels": ["lot 14"],\n'
        '      "property_type": "apartment|house|building|commercial|parking|other|unknown|null",\n'
        '      "measurement_completeness": "complete|likely_complete|partial|unknown",\n'
        '      "spaces": [\n'
        '        {"measurement_id": null, "asset_id": "asset-1", "lot_label": "lot 14", "level": null, "space_label": "séjour", "category": "habitable|circulation|sanitary|service|annex|exterior|land|unknown", "value_m2": 19.56, "included_in_habitable_sum": true, "confidence": 0.0, "evidence": {"quote": "citation exacte avec 19,56 m²", "document_url": null, "document_label": null, "page_number": null, "source_kind": null}, "extraction_method": "llm"}\n'
        '      ],\n'
        '      "explicit_surfaces": [\n'
        '        {"candidate_id": null, "asset_id": "asset-1", "value_m2": 64.8, "kind": "explicit_carrez|explicit_habitable|explicit_total|explicit_built|land|annex|unknown", "scope": "sale|asset|lot|level|partial|unknown", "is_explicit": true, "unit_as_written": "m2|m3", "confidence": 0.0, "evidence": {"quote": "citation exacte", "document_url": null, "document_label": null, "page_number": null, "source_kind": null}}\n'
        '      ]\n'
        '    }\n'
        '  ],\n'
        '  "rooms_count": null,\n'
        '  "bedrooms_count": null,\n'
        '  "occupancy_status": "vacant|occupied|rented|owner_occupied|squatted|unknown|null",\n'
        '  "occupancy_details": null,\n'
        '  "legal_risks": [],\n'
        '  "physical_risks": [],\n'
        '  "copropriete": null,\n'
        '  "servitudes": [],\n'
        '  "works_needed": null,\n'
        '  "summary": null,\n'
        '  "investor_notes": null,\n'
        '  "confidence": {\n'
        '    "property_type": 0.0,\n'
        '    "surface_m2": 0.0,\n'
        '    "rooms_count": 0.0,\n'
        '    "bedrooms_count": 0.0,\n'
        '    "occupancy_status": 0.0,\n'
        '    "legal_risks": 0.0,\n'
        '    "physical_risks": 0.0,\n'
        '    "copropriete": 0.0,\n'
        '    "servitudes": 0.0,\n'
        '    "display_description": 0.0,\n'
        '    "summary": 0.0\n'
        "  },\n"
        '  "evidence": {\n'
        '    "property_type": {"quote": null, "document_label": null, "page_number": null},\n'
        '    "surface_m2": {"quote": null, "document_label": null, "page_number": null},\n'
        '    "rooms_count": {"quote": null, "document_label": null, "page_number": null},\n'
        '    "bedrooms_count": {"quote": null, "document_label": null, "page_number": null},\n'
        '    "occupancy_status": {"quote": null, "document_label": null, "page_number": null},\n'
        '    "legal_risks": [{"quote": null, "document_label": null, "page_number": null}],\n'
        '    "physical_risks": [{"quote": null, "document_label": null, "page_number": null}],\n'
        '    "servitudes": [{"quote": null, "document_label": null, "page_number": null}]\n'
        "  },\n"
        '  "investment_facts": [\n'
        '    {"category": "asset|legal|technical|financial|evidence", "key": null, "status": "confirmed|negated|uncertain", "statement": null, "quote": null, "document_label": null, "page_number": null, "confidence": 0.0}\n'
        "  ],\n"
        '  "contradictions": [\n'
        '    {"field": null, "statement": null, "sources": [], "quote": null, "document_label": null, "page_number": null, "confidence": 0.0}\n'
        "  ],\n"
        '  "analysis_questions": [\n'
        '    {"question": null, "answer": null, "status": "answered|to_verify|unknown", "quote": null, "document_label": null, "page_number": null}\n'
        "  ],\n"
        '  "scoring_guidance": [\n'
        '    {"axis": "financial_attractiveness|asset_quality|legal_security|liquidity_resale|analysis_confidence", "impact": "positive|negative|neutral|uncertain", "reasoning": null, "quote": null, "document_label": null, "page_number": null}\n'
        "  ]\n"
        "}\n\n"
        "Texte fourni :\n"
        f"{context_text}"
    )


def build_display_description_prompt(context_text: str) -> str:
    return (
        "Voici le contexte extrait d'une vente immobilière judiciaire. "
        "Produis uniquement une synthèse d'affichage publique, sans extraction de due diligence complète.\n\n"
        "Règles obligatoires :\n"
        "- Utilise uniquement les faits explicitement présents dans le contexte.\n"
        "- Un seul paragraphe en français naturel, sans titre, sans markdown, sans retour à la ligne.\n"
        "- Ton neutre, factuel et homogène, sans promesse de rentabilité ni conseil juridique.\n"
        "- Priorise les contraintes explicites et incertitudes (occupation, urbanisme, indivision, régularisation, travaux), puis type de bien, localisation, surface et composition.\n"
        "- Ne transpose pas un chiffre entre surface habitable, terrain, prix, charges mensuelles ou annuelles. Conserve son unité et sa portée.\n"
        "- N’ajoute aucune formule commerciale comme exceptionnel, idéal ou sans risque.\n"
        "- En cas de contradiction ou d'information peu fiable, omets le point ou mentionne sobrement qu'il est à vérifier.\n"
        "- Vise 70 à 105 mots. Si le contexte est pauvre, reste plus court.\n\n"
        "Schéma JSON attendu, sans markdown et sans commentaire :\n"
        "{\n"
        '  "display_description": "paragraphe public ou null",\n'
        '  "confidence": {"display_description": 0.0}\n'
        "}\n\n"
        "Texte fourni :\n"
        f"{context_text}"
    )
