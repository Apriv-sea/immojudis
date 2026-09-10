from __future__ import annotations

import re
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from src.asset_normalization import (
    ScoreComponent,
    build_auction_features_row,
    build_auction_surfaces_row,
)
from src.asset_normalization_helpers import (
    _axis_label,
    _compact_dict,
    _component_axis,
    _component_decision,
    _component_facts,
    _component_question,
    _component_raw_fact_label,
    _confidence_note,
    _default_factor_criterion,
    _evidence,
    _factor_status,
    _float_or_none,
    _format_decimal,
    _format_eur,
    _json_safe,
    _occupancy_status_label,
    _proof_level,
    _property_type_label,
    _quality_flag_label,
    _quality_penalty_breakdown,
    _risk_penalty_breakdown,
    _risk_to_evidence_ref,
    _sale_text,
    _sale_type_context,
    _surface_evidence_refs,
    _text_has_works_signal,
)
from src.asset_premium_analysis import (
    _analysis_contradictions,
    _build_premium_investment_analysis,
    _load_scoring_weights,
)
from src.asset_surface_normalization import (
    _business_rule,
    _business_rule_refs,
    _business_rule_to_ref,
)
from src.models import AuctionSale


def _score_sale(sale: AuctionSale, risks: list[dict[str, Any]]) -> None:
    if any(risk.get("severity") is None for risk in risks):
        # Reviewed documentary reservations may be real without a quantified severity.
        # Do not crash on Decimal(None), invent a penalty, or retain the previous score.
        sale.investment_score = None
        sale.score_confidence = None
        sale.score_version = None
        sale.score_factors = []
        sale.investment_summary = "Score non calculé : des risques documentés restent à qualifier."
        sale.raw_payload["score_factors"] = []
        sale.raw_payload.pop("investment_analysis", None)
        sale.raw_payload["score_status"] = "withheld_unqualified_risks"
        return
    sale.raw_payload.pop("score_status", None)
    weights = _load_scoring_weights()
    sale.score_version = str(weights.get("version", "v1"))
    components = [
        _score_occupation(sale),
        _score_condition(sale, risks),
        _score_property_type(sale),
        _score_location(sale),
        _score_surface(sale),
        _score_price_per_m2(sale),
        _score_amenities(sale),
        _score_risks(sale, risks),
        _score_data_quality(sale),
    ]
    total = Decimal(str(weights.get("base_score", 50)))
    factor_rows = []
    for index, component in enumerate(components):
        weight = Decimal(str(weights.get(component.name, 1)))
        delta = component.points * weight
        score_before = total
        total += delta
        factor_rows.append(_score_factor_payload(component, delta, weight, index, score_before, total))
    total = max(Decimal("0"), min(Decimal("100"), total))
    sale.investment_score = total.quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
    sale.score_confidence = _score_confidence(sale, components)
    sale.score_factors = factor_rows
    sale.raw_payload["score_factors"] = factor_rows
    sale.raw_payload["investment_analysis"] = _build_premium_investment_analysis(
        sale,
        risks,
        components,
        factor_rows,
    )
    sale.investment_summary = "; ".join(
        f"{item.name}: {item.reason} ({Decimal(str(factor_rows[index]['delta'])):+})"
        for index, item in enumerate(components)
    )


def _score_occupation(sale: AuctionSale) -> ScoreComponent:
    conflict_rule = _business_rule(sale, "occupation_conflict_requires_confirmation")
    if sale.occupancy_status == "unknown" and conflict_rule:
        evidence = str(conflict_rule.get("evidence") or "") or None
        confidence = Decimal(str(conflict_rule.get("confidence") or "0.65"))
        return ScoreComponent(
            "occupation",
            Decimal("-3"),
            "occupation à confirmer : bail ou locataire détecté",
            confidence=confidence,
            evidence=evidence,
            raw_value=sale.occupancy_status,
            criterion="Le statut d'occupation pèse directement sur la liquidité, les délais et la capacité à visiter ou relouer.",
            calculation=(
                "Une source peut annoncer un bien libre, mais un document opérationnel mentionne bail, locataire "
                "ou loyer sans preuve de départ effectif. Le bonus de bien libre est donc retiré : -3 points."
            ),
            interpretation=str(conflict_rule.get("reasoning") or ""),
            limits=(
                "À lever avec une attestation de libération, un état des lieux de sortie, "
                "un PV plus récent ou une confirmation du cabinet avant enchère."
            ),
            evidence_refs=[_business_rule_to_ref(conflict_rule)],
        )
    mapping = {
        "vacant": (Decimal("12"), "libre, liquidité meilleure"),
        "unknown": (Decimal("-3"), "occupation à confirmer"),
        "rented": (Decimal("3"), "loué, rendement possible mais bail à vérifier"),
        "occupied": (Decimal("-10"), "occupé, libération incertaine"),
        "owner_occupied": (Decimal("-8"), "occupé par propriétaire"),
        "squatted": (Decimal("-18"), "squat ou occupation sans droit"),
    }
    points, reason = mapping.get(sale.occupancy_status or "", (Decimal("-3"), "occupation non renseignée"))
    confidence = (
        Decimal("0.55")
        if sale.occupancy_status == "unknown"
        else Decimal("0.85")
        if sale.occupancy_status
        else Decimal("0.45")
    )
    status_label = _occupancy_status_label(sale.occupancy_status)
    return ScoreComponent(
        "occupation",
        points,
        reason,
        confidence=confidence,
        raw_value=sale.occupancy_status,
        criterion="Le statut d'occupation pèse directement sur la liquidité, les délais et la capacité à visiter ou relouer.",
        calculation=f"Statut retenu : {status_label}. Barème appliqué : {points:+} point(s).",
        interpretation=(
            "Le bien est considéré comme immédiatement exploitable si l'occupation est libre. "
            "Une occupation inconnue ou contrainte est pénalisée car elle crée un coût et un délai potentiel."
        ),
        limits=(
            "À confirmer dans le PV descriptif, le bail ou le cahier des conditions de vente "
            "si le statut vient uniquement de l'annonce."
        ),
    )


def _score_condition(sale: AuctionSale, risks: list[dict[str, Any]]) -> ScoreComponent:
    works_risk = next((risk for risk in risks if risk.get("risk_label") == "travaux"), None)
    if works_risk:
        severity = int(works_risk.get("severity") or 4)
        confidence = Decimal(str(works_risk.get("confidence") or "0.78"))
        evidence = str(works_risk.get("evidence") or "") or None
        evidence_refs = [_risk_to_evidence_ref(works_risk)] if evidence else []
        if severity >= 5:
            return ScoreComponent(
                "état",
                Decimal("-14"),
                "désordre lourd ou remise en état importante documentée",
                confidence=confidence,
                evidence=evidence,
                criterion="L'état du bien mesure les coûts probables avant revente, relocation ou occupation.",
                calculation=f"Signal travaux retenu avec sévérité {severity}/5 : -14 points.",
                interpretation=(
                    "Le contexte contient un désordre matériel explicite rattaché au bien "
                    "(dégât des eaux, infiltrations, gros travaux ou remise en état importante)."
                ),
                limits="Le score ne chiffre pas encore le coût des travaux ; il indique un risque à budgéter avant enchère.",
                evidence_refs=evidence_refs,
            )
        return ScoreComponent(
            "état",
            Decimal("-6"),
            "travaux ou état dégradé documentés",
            confidence=confidence,
            evidence=evidence,
            criterion="L'état du bien mesure les coûts probables avant revente, relocation ou occupation.",
            calculation=f"Signal travaux retenu avec sévérité {severity}/5 : -6 points.",
            interpretation=(
                "Le contexte mentionne un état dégradé ou des travaux liés au bien, "
                "sans atteindre le seuil des désordres lourds."
            ),
            limits="À confronter aux photos, au PV descriptif complet et aux devis si disponibles.",
            evidence_refs=evidence_refs,
        )
    text = _sale_text(sale)
    positive_condition = re.search(
        r"\bbon\s+[ée]tat\b|\br[ée]nov[ée]e?\b|\brefaite?\b|\baucun\s+travaux\b",
        text,
        re.I,
    )
    if positive_condition and not _text_has_works_signal(text):
        return ScoreComponent(
            "état",
            Decimal("4"),
            "bon état explicitement mentionné",
            confidence=Decimal("0.75"),
            evidence=_evidence(text, positive_condition.start(), positive_condition.end()),
            criterion="L'état du bien mesure les coûts probables avant revente, relocation ou occupation.",
            calculation="Mention positive d'état détectée : +4 points.",
            interpretation="Le texte indique un bien en bon état ou rénové, sans signal travaux retenu.",
            limits="Cette lecture reste déclarative si elle ne provient pas d'un PV descriptif ou d'un diagnostic.",
        )
    return ScoreComponent(
        "état",
        Decimal("0"),
        "état non qualifié",
        confidence=Decimal("0.45"),
        criterion="L'état du bien mesure les coûts probables avant revente, relocation ou occupation.",
        calculation="Aucun signal positif ou négatif exploitable : 0 point.",
        interpretation="Aucun élément suffisamment contextualisé ne permet de conclure sur l'état réel du bien.",
        limits="Le lecteur doit consulter les PV, diagnostics et photographies avant de considérer ce facteur comme neutre.",
    )


def _score_property_type(sale: AuctionSale) -> ScoreComponent:
    mapping = {
        "apartment": (Decimal("5"), "appartement, marché liquide"),
        "house": (Decimal("4"), "maison, demande large"),
        "building": (Decimal("6"), "immeuble, potentiel locatif"),
        "mixed": (Decimal("1"), "actif mixte, analyse plus complexe"),
        "commercial": (Decimal("-2"), "commercial, sortie plus spécialisée"),
        "land": (Decimal("-3"), "terrain, valorisation spécifique"),
        "parking": (Decimal("1"), "parking"),
    }
    points, reason = mapping.get(sale.property_type or "", (Decimal("-2"), "type non qualifié"))
    confidence = Decimal("0.82") if sale.property_type not in {None, "unknown", "other"} else Decimal("0.45")
    type_rule = _business_rule(sale, "property_type_from_specific_asset")
    evidence = None
    evidence_refs: list[dict[str, Any]] = []
    calculation = f"Type retenu : {_property_type_label(sale.property_type)}. Barème appliqué : {points:+} point(s)."
    interpretation = (
        "Les appartements, maisons et immeubles sont favorisés car les usages et comparables sont plus lisibles. "
        "Les actifs spécialisés demandent une analyse de marché plus fine."
    )
    if type_rule and sale.property_type == "apartment":
        evidence = str(type_rule.get("evidence") or "") or None
        evidence_refs = [_business_rule_to_ref(type_rule)]
        confidence = Decimal(str(type_rule.get("confidence") or confidence))
        reason = "appartement/studio documenté, marché liquide"
        calculation = (
            "Le document décrit l'actif vendu comme un logement ou studio précis. "
            f"Type retenu : appartement. Barème appliqué : {points:+} point(s)."
        )
        interpretation = str(type_rule.get("reasoning") or interpretation)
    return ScoreComponent(
        "type",
        points,
        reason,
        confidence=confidence,
        evidence=evidence,
        raw_value=sale.property_type,
        criterion="Le type de bien sert à estimer la profondeur du marché et la facilité de sortie.",
        calculation=calculation,
        interpretation=interpretation,
        limits="Le type peut être corrigé si le cahier de vente décrit un actif mixte ou une dépendance dominante.",
        evidence_refs=evidence_refs,
    )


def _score_location(sale: AuctionSale) -> ScoreComponent:
    prime = {"Bordeaux", "Pau", "Bayonne", "Mérignac", "Merignac", "Périgueux", "Perigueux", "Urrugne"}
    secondary = {"Libourne", "Dax", "Agen", "Bergerac", "Mont-de-Marsan", "Floirac", "Cenon", "Biganos"}
    if sale.city in prime:
        return ScoreComponent(
            "localisation",
            Decimal("8"),
            f"{sale.city} marché profond",
            confidence=Decimal("0.75"),
            raw_value=sale.city,
            criterion="La localisation est notée selon la profondeur supposée du marché et la facilité de comparaison.",
            calculation=f"Ville classée marché prioritaire : {sale.city}. Barème appliqué : +8 points.",
            interpretation="La commune dispose d'une demande plus large et d'un volume de transactions plus exploitable.",
            limits="Cette pondération doit être complétée par l'adresse précise, l'environnement immédiat et les comparables.",
        )
    if sale.city in secondary:
        return ScoreComponent(
            "localisation",
            Decimal("4"),
            f"{sale.city} marché qualifié",
            confidence=Decimal("0.7"),
            raw_value=sale.city,
            criterion="La localisation est notée selon la profondeur supposée du marché et la facilité de comparaison.",
            calculation=f"Ville classée marché secondaire : {sale.city}. Barème appliqué : +4 points.",
            interpretation="La commune est exploitable, mais le marché est moins profond qu'une grande centralité.",
            limits="Le quartier et la distance aux services peuvent fortement modifier cette lecture.",
        )
    if sale.tribunal:
        return ScoreComponent(
            "localisation",
            Decimal("3"),
            "localisation qualifiée",
            confidence=Decimal("0.55"),
            raw_value=sale.tribunal,
            criterion="La localisation est notée selon la profondeur supposée du marché et la facilité de comparaison.",
            calculation=f"Ville non classée, tribunal identifié ({sale.tribunal}) : +3 points.",
            interpretation="Le dossier est localisable, mais la liquidité du micro-marché reste à confirmer.",
            limits="À compléter par les coordonnées GPS, la carte et les références locales.",
        )
    return ScoreComponent(
        "localisation",
        Decimal("-2"),
        "localisation peu qualifiée",
        confidence=Decimal("0.35"),
        criterion="La localisation est notée selon la profondeur supposée du marché et la facilité de comparaison.",
        calculation="Aucune commune ou tribunal suffisamment fiable : -2 points.",
        interpretation="L'absence de localisation exploitable réduit la fiabilité du scoring.",
        limits="Le score doit être recalculé dès que l'adresse ou la commune est confirmée.",
    )


def _score_surface(sale: AuctionSale) -> ScoreComponent:
    surface = sale.app_surface_m2
    if surface is None:
        if "ambiguous_surface" in sale.quality_flags:
            return ScoreComponent(
                "surface",
                Decimal("-8"),
                "surface ambiguë, non exploitable",
                confidence=Decimal("0.35"),
                criterion="La surface utilisée doit correspondre à la surface réellement valorisable du bien.",
                calculation="Plusieurs surfaces ou une surface annexe semblent mélangées : -8 points.",
                interpretation="Le prix au m² et la comparaison marché ne sont pas fiables tant que la surface n'est pas clarifiée.",
                limits="Vérifier le PV descriptif, le diagnostic Carrez et la désignation des lots.",
            )
        return ScoreComponent(
            "surface",
            Decimal("-6"),
            "surface exploitable absente",
            confidence=Decimal("0.3"),
            criterion="La surface utilisée doit correspondre à la surface réellement valorisable du bien.",
            calculation="Aucune surface exploitable retenue : -6 points.",
            interpretation="Le score pénalise l'absence de base de calcul pour le prix au m².",
            limits="À compléter dès qu'une surface habitable, Carrez ou bâtie est extraite d'un document fiable.",
        )
    confidence = sale.surface_confidence or Decimal("0.65")
    if Decimal("25") <= surface <= Decimal("160"):
        return ScoreComponent(
            "surface",
            Decimal("6"),
            f"{surface} m2 exploitable",
            confidence=confidence,
            evidence=sale.surface_evidence,
            raw_value=float(surface),
            criterion="La surface utilisée doit correspondre à la surface réellement valorisable du bien.",
            calculation=f"Surface retenue : {_format_decimal(surface)} m2, dans la plage standard 25-160 m2 : +6 points.",
            interpretation="La surface permet de calculer un prix au m² et de comparer le bien au marché résidentiel courant.",
            limits="La surface reste à confirmer si elle ne provient pas d'une mention Carrez, habitable ou d'un PV descriptif.",
            evidence_refs=_surface_evidence_refs(sale),
        )
    if surface < Decimal("15"):
        return ScoreComponent(
            "surface",
            Decimal("-5"),
            "surface très faible",
            confidence=confidence,
            evidence=sale.surface_evidence,
            raw_value=float(surface),
            criterion="La surface utilisée doit correspondre à la surface réellement valorisable du bien.",
            calculation=f"Surface retenue : {_format_decimal(surface)} m2, inférieure au seuil de 15 m2 : -5 points.",
            interpretation="Une très petite surface limite les usages et peut réduire la liquidité.",
            limits="Vérifier qu'il ne s'agit pas d'une pièce, cave, garage ou annexe isolée.",
            evidence_refs=_surface_evidence_refs(sale),
        )
    if surface > Decimal("300") and sale.property_type not in {"building", "commercial", "mixed", "land"}:
        return ScoreComponent(
            "surface",
            Decimal("-2"),
            "surface atypique pour ce type",
            confidence=confidence,
            evidence=sale.surface_evidence,
            raw_value=float(surface),
            criterion="La surface utilisée doit correspondre à la surface réellement valorisable du bien.",
            calculation=f"Surface retenue : {_format_decimal(surface)} m2, atypique pour {_property_type_label(sale.property_type)} : -2 points.",
            interpretation="La surface peut mélanger bâti, terrain ou dépendances ; la comparaison marché devient plus fragile.",
            limits="À confirmer dans la désignation des lots et les diagnostics.",
            evidence_refs=_surface_evidence_refs(sale),
        )
    return ScoreComponent(
        "surface",
        Decimal("1"),
        "surface atypique mais exploitable",
        confidence=confidence,
        evidence=sale.surface_evidence,
        raw_value=float(surface),
        criterion="La surface utilisée doit correspondre à la surface réellement valorisable du bien.",
        calculation=f"Surface retenue : {_format_decimal(surface)} m2 : +1 point.",
        interpretation="La donnée est exploitable mais ne rentre pas dans le cas résidentiel standard.",
        limits="À vérifier selon la nature exacte du bien.",
        evidence_refs=_surface_evidence_refs(sale),
    )


def _score_price_per_m2(sale: AuctionSale) -> ScoreComponent:
    surface = sale.app_surface_m2
    if not surface:
        return ScoreComponent(
            "prix_m2",
            Decimal("-4"),
            "prix/m2 non calculable sans surface",
            confidence=Decimal("0.3"),
            criterion="Le prix au m² rapproche la mise à prix d'un ordre de grandeur local.",
            calculation="Mise à prix / surface impossible car aucune surface exploitable n'est retenue : -4 points.",
            interpretation="Sans surface fiable, l'attractivité financière ne peut pas être comparée proprement.",
            limits="Ce facteur sera recalculé automatiquement dès qu'une surface exploitable sera disponible.",
        )
    if not sale.starting_price_eur:
        return ScoreComponent(
            "prix_m2",
            Decimal("-2"),
            "mise à prix absente",
            confidence=Decimal("0.35"),
            criterion="Le prix au m² rapproche la mise à prix d'un ordre de grandeur local.",
            calculation="Mise à prix absente : -2 points.",
            interpretation="Le potentiel financier ne peut pas être estimé sans prix de départ.",
            limits="Vérifier l'annonce officielle ou le cahier des conditions de vente.",
        )
    price_m2 = sale.starting_price_eur / surface
    low, fair, high = _price_bands_for_sale(sale)
    rounded = price_m2.quantize(Decimal("1"))
    confidence = min(sale.surface_confidence or Decimal("0.65"), Decimal("0.8"))
    if price_m2 < low:
        return ScoreComponent(
            "prix_m2",
            Decimal("12"),
            f"mise à prix attractive env. {rounded} €/m2",
            confidence=confidence,
            raw_value=float(price_m2),
            criterion="Le prix au m² rapproche la mise à prix d'un ordre de grandeur local.",
            calculation=f"{_format_eur(sale.starting_price_eur)} / {_format_decimal(surface)} m2 = {_format_eur(rounded)}/m2, sous le seuil attractif {_format_eur(low)}/m2 : +12 points.",
            interpretation="La mise à prix laisse théoriquement une marge de sécurité avant le niveau de marché indicatif.",
            limits="Ce n'est pas une estimation de valeur vénale : frais, travaux, occupation et concurrence aux enchères restent à intégrer.",
        )
    if price_m2 < fair:
        return ScoreComponent(
            "prix_m2",
            Decimal("6"),
            f"mise à prix correcte env. {rounded} €/m2",
            confidence=confidence,
            raw_value=float(price_m2),
            criterion="Le prix au m² rapproche la mise à prix d'un ordre de grandeur local.",
            calculation=f"{_format_eur(sale.starting_price_eur)} / {_format_decimal(surface)} m2 = {_format_eur(rounded)}/m2, sous le seuil correct {_format_eur(fair)}/m2 : +6 points.",
            interpretation="La mise à prix est cohérente avec un dossier à analyser, sans signal de surprix initial.",
            limits="Le résultat dépend fortement de la surface retenue et des coûts annexes.",
        )
    if price_m2 > high:
        return ScoreComponent(
            "prix_m2",
            Decimal("-8"),
            f"mise à prix élevée env. {rounded} €/m2",
            confidence=confidence,
            raw_value=float(price_m2),
            criterion="Le prix au m² rapproche la mise à prix d'un ordre de grandeur local.",
            calculation=f"{_format_eur(sale.starting_price_eur)} / {_format_decimal(surface)} m2 = {_format_eur(rounded)}/m2, au-dessus du seuil élevé {_format_eur(high)}/m2 : -8 points.",
            interpretation="La marge de sécurité paraît faible au regard de la seule mise à prix.",
            limits="Un emplacement premium ou un actif rare peut justifier un prix au m² supérieur.",
        )
    return ScoreComponent(
        "prix_m2",
        Decimal("0"),
        f"mise à prix neutre env. {rounded} €/m2",
        confidence=confidence,
        raw_value=float(price_m2),
        criterion="Le prix au m² rapproche la mise à prix d'un ordre de grandeur local.",
        calculation=f"{_format_eur(sale.starting_price_eur)} / {_format_decimal(surface)} m2 = {_format_eur(rounded)}/m2, dans la zone neutre : 0 point.",
        interpretation="La mise à prix ne crée ni avantage clair ni alerte forte sur ce critère seul.",
        limits="Comparer avec des références récentes autour de l'adresse avant décision.",
    )


def _price_bands_for_sale(sale: AuctionSale) -> tuple[Decimal, Decimal, Decimal]:
    prime_cities = {"Bordeaux", "Bayonne", "Pau", "Mérignac", "Merignac", "Urrugne"}
    secondary_cities = {"Périgueux", "Perigueux", "Floirac", "Cenon", "Biganos", "Libourne"}
    if sale.city in prime_cities:
        return Decimal("1800"), Decimal("3200"), Decimal("5200")
    if sale.city in secondary_cities:
        return Decimal("1400"), Decimal("2600"), Decimal("4200")
    if sale.department == "33":
        return Decimal("1400"), Decimal("2800"), Decimal("4800")
    if sale.department == "64":
        return Decimal("1500"), Decimal("3000"), Decimal("5200")
    return Decimal("1000"), Decimal("2200"), Decimal("3600")


def _score_amenities(sale: AuctionSale) -> ScoreComponent:
    points = Decimal("0")
    labels = []
    weights = (
        ("has_garden", "jardin", Decimal("3")),
        ("has_garage", "garage", Decimal("2")),
        ("has_terrace", "terrasse", Decimal("2")),
        ("has_pool", "piscine", Decimal("1")),
    )
    for flag_name, label, value in weights:
        if getattr(sale, flag_name):
            points += value
            labels.append(label)
    if sale.parking_count and sale.parking_count > 0 and not sale.has_garage:
        points += Decimal("1")
        labels.append("parking")
    points = min(points, Decimal("7"))
    confidence = Decimal("0.75") if labels else Decimal("0.55")
    return ScoreComponent(
        "atouts",
        points,
        ", ".join(labels) if labels else "aucun atout détecté",
        confidence=confidence,
        raw_value=labels,
        criterion="Les atouts d'usage améliorent la revente, la location ou la qualité d'occupation.",
        calculation=(
            f"Atouts retenus : {', '.join(labels)}. Total plafonné : {points:+} point(s)."
            if labels
            else "Aucun atout exploitable détecté dans les textes : 0 point."
        ),
        interpretation=(
            "Les équipements sont ajoutés uniquement lorsqu'ils sont explicitement détectés. "
            "Le plafond évite de survaloriser une simple accumulation de mots-clés."
        ),
        limits="L'absence d'atout détecté ne prouve pas son absence réelle ; elle signale seulement une donnée non trouvée.",
    )


def _score_risks(sale: AuctionSale, risks: list[dict[str, Any]]) -> ScoreComponent:
    penalty = sum(Decimal(str(row.get("severity", 1))) for row in risks)
    penalty = min(penalty, Decimal("18"))
    no_documents = not sale.documents
    labels = (
        ", ".join(row["risk_label"] for row in risks[:4])
        if risks
        else "aucun risque sourcé : pièces officielles absentes"
        if no_documents
        else "aucun risque contextualisé retenu"
    )
    if risks:
        confidence = sum((Decimal(str(row.get("confidence") or "0.7")) for row in risks), Decimal("0")) / Decimal(
            str(len(risks))
        )
    else:
        confidence = Decimal("0.25") if no_documents else Decimal("0.5")
    evidence = risks[0].get("evidence") if risks else None
    return ScoreComponent(
        "risques",
        -penalty,
        labels,
        confidence=confidence,
        evidence=evidence,
        raw_value=[r.get("risk_label") for r in risks],
        criterion="Les risques ne sont retenus que lorsqu'un contexte indique qu'ils concernent le bien, pas une clause générique.",
        calculation=(
            f"Somme des sévérités retenues ({_risk_penalty_breakdown(risks)}) plafonnée à -18 : {-penalty:+} point(s)."
            if risks
            else (
                "Aucune pièce officielle n'est disponible : le moteur ne peut pas conclure à l'absence de risque, "
                "il signale seulement qu'aucun risque n'est sourcé dans les données structurées : 0 point."
                if no_documents
                else "Aucun risque contextualisé retenu dans les pièces analysées : 0 point."
            )
        ),
        interpretation=(
            "Chaque risque est relié à un extrait et à un type de document lorsque la source est disponible. "
            "Les mentions génériques de cahier de vente ou les diagnostics listés sans résultat positif sont ignorés. "
            "Quand les pièces sont absentes, l'absence d'alerte ne vaut jamais absence de risque."
        ),
        limits="Un risque absent du scoring peut encore exister si le document n'a pas été extrait ou si l'OCR est incomplet.",
        evidence_refs=[_risk_to_evidence_ref(risk) for risk in risks[:3] if risk.get("evidence")],
    )


def _score_data_quality(sale: AuctionSale) -> ScoreComponent:
    penalties: list[tuple[Decimal, str]] = []
    flags = set(sale.quality_flags)
    contradictions = _analysis_contradictions(sale)
    if "ambiguous_surface" in flags:
        penalties.append((Decimal("5"), "surface ambiguë"))
    if "low_confidence_extraction" in flags:
        penalties.append((Decimal("4"), "extraction faible"))
    if "missing_gps" in flags:
        penalties.append((Decimal("3"), "GPS manquant"))
    if not sale.documents:
        penalties.append((Decimal("6"), "pièces officielles absentes"))
    if sale.rooms_count is None:
        penalties.append((Decimal("2"), "pièces manquantes"))
    if sale.bedrooms_count is None and sale.property_type in {"apartment", "house"}:
        penalties.append((Decimal("2"), "chambres manquantes"))
    if not sale.occupancy_status or sale.occupancy_status == "unknown":
        penalties.append((Decimal("3"), "occupation à confirmer"))
    if contradictions:
        penalties.append((min(Decimal(str(len(contradictions) * 2)), Decimal("5")), "contradictions à lever"))
    total_penalty = min(sum((points for points, _reason in penalties), Decimal("0")), Decimal("18"))
    reason = ", ".join(reason for _points, reason in penalties[:4]) if penalties else "données exploitables"
    confidence = Decimal("0.85") if not penalties else Decimal("0.55")
    return ScoreComponent(
        "qualité",
        -total_penalty,
        reason,
        confidence=confidence,
        raw_value=[_quality_flag_label(flag) for flag in sale.quality_flags],
        criterion="La qualité des données mesure la fiabilité minimale nécessaire pour utiliser le score.",
        calculation=(
            f"Pénalités qualité : {_quality_penalty_breakdown(penalties)}. Total plafonné à -18 : {-total_penalty:+} point(s)."
            if penalties
            else "Aucune pénalité qualité : 0 point."
        ),
        interpretation=(
            "Le score baisse quand les informations structurantes manquent ou semblent ambiguës, "
            "même si le bien paraît intéressant par ailleurs. Les corrections automatiques sont tracées "
            "comme des règles métier pour expliquer quelle information a été préférée et pourquoi."
        ),
        limits="Cette rubrique indique surtout ce qu'il faut vérifier avant de prendre une décision.",
        evidence_refs=_business_rule_refs(sale),
        axis="analysis_confidence",
        question="Les données et preuves sont-elles suffisantes pour utiliser le score ?",
    )


def _score_factor_payload(
    component: ScoreComponent,
    delta: Decimal,
    weight: Decimal,
    index: int,
    score_before: Decimal,
    score_after: Decimal,
) -> dict[str, Any]:
    axis = component.axis or _component_axis(component.name)
    explanation = _compact_dict(
        {
            "status": _factor_status(delta),
            "axis": axis,
            "axis_label": _axis_label(axis),
            "question": component.question or _component_question(component.name),
            "decision": _component_decision(component, delta),
            "criterion": component.criterion or _default_factor_criterion(component.name),
            "reasoning": component.interpretation or component.reason,
            "calculation": component.calculation or f"{component.points:+} x poids {weight} = {delta:+}",
            "score_before": float(score_before),
            "score_after": float(score_after),
            "confidence_note": _confidence_note(component.confidence),
            "limits": component.limits,
            "raw_value_label": _component_raw_fact_label(component),
            "facts": _component_facts(component),
            "proof_level": _proof_level(component),
        }
    )
    return {
        "factor_order": index,
        "factor_key": component.name,
        "label": component.name,
        "reason": component.reason,
        "base_points": float(component.points),
        "weight": float(weight),
        "delta": float(delta),
        "confidence": float(max(Decimal("0"), min(Decimal("1"), component.confidence))),
        "evidence": component.evidence,
        "raw_value": _json_safe(component.raw_value),
        "normalized_value": explanation,
        "evidence_refs": [_compact_dict(_json_safe(ref)) for ref in component.evidence_refs],
    }


def _score_confidence(sale: AuctionSale, components: list[ScoreComponent]) -> Decimal:
    if not components:
        return Decimal("0")
    average = sum((component.confidence for component in components), Decimal("0")) / Decimal(str(len(components)))
    penalty = Decimal("0")
    flags = set(sale.quality_flags)
    if "ambiguous_surface" in flags:
        penalty += Decimal("0.12")
    if "low_confidence_extraction" in flags:
        penalty += Decimal("0.1")
    if not sale.documents:
        penalty += Decimal("0.14")
    if sale.app_surface_m2 is None:
        penalty += Decimal("0.12")
    if not sale.occupancy_status:
        penalty += Decimal("0.06")
    contradictions = _analysis_contradictions(sale)
    if contradictions:
        penalty += min(Decimal("0.18"), Decimal("0.06") * Decimal(str(len(contradictions))))
    if _sale_type_context(sale).get("status") == "non_judicial":
        penalty += Decimal("0.03")
    confidence = max(Decimal("0"), min(Decimal("1"), average - penalty))
    return confidence.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _write_asset_payload(sale: AuctionSale, risks: list[dict[str, Any]]) -> None:
    sale.raw_payload["asset_normalization"] = {
        "features": build_auction_features_row(sale),
        "surfaces": build_auction_surfaces_row(sale),
        "risks": risks,
        "score_confidence": _float_or_none(sale.score_confidence),
        "score_factors": sale.score_factors,
        "investment_analysis": sale.raw_payload.get("investment_analysis"),
        "quality_flags": sale.quality_flags,
        "score_version": sale.score_version,
    }
