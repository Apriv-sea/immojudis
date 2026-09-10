import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSharedPropertyReport } from "@/lib/property-reports";
import { ReportSourceChangedError } from "@/lib/property-report/source-integrity";
import { formatDate, formatPrice, formatPricePerM2 } from "@/lib/format";
import { reportSaleSchedule } from "@/lib/report-sale-schedule";
import { reportSimulationSchema } from "@/lib/report-simulation";

type PageParams = {
  params: Promise<{ token: string }>;
};

export const metadata: Metadata = {
  title: "Rapport partagé — ImmoJudis",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function SharedReportPage({ params }: PageParams) {
  const { token } = await params;
  const report = await getSharedPropertyReport({ token }).catch((error: unknown) =>
    error instanceof ReportSourceChangedError ? error : null,
  );
  if (!report) notFound();
  if (report instanceof ReportSourceChangedError) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-3xl font-semibold">Rapport à actualiser</h1>
        <p className="mt-4 text-slate-700">
          Les données de cette analyse ne peuvent plus être confirmées. Demandez à la personne qui
          vous a transmis ce lien de sauvegarder une nouvelle analyse depuis l’annonce, puis de vous
          partager le lien actualisé.
        </p>
      </main>
    );
  }

  const sale = report.sale;
  const analysis = report.analysis;
  const valueEstimate = asRecord(analysis.valueEstimate);
  const marketComparables = asRecord(analysis.marketComparablesAnalysis);
  const retainedComparables = normalizeMarketComparableRows(marketComparables.retainedComparables);
  const addressHistory = normalizeMarketComparableRows(marketComparables.addressHistory);
  const marketComparablesActions = normalizeStringList(marketComparables.nextActions);
  const valuationAudit = asRecord(analysis.valuationAudit);
  const valuationCheckpoints = normalizeValuationCheckpoints(valuationAudit.checkpoints);
  const valuationActions = normalizeStringList(valuationAudit.nextActions);
  const valuationRiskFlags = normalizeStringList(valuationAudit.riskFlags);
  const valuationLimitations = normalizeStringList(valuationAudit.limitations);
  const opportunity = asRecord(analysis.opportunity);
  const rentabilityScore = asRecord(opportunity.rentabilityScore);
  const acquisitionCosts = asRecord(opportunity.acquisitionCosts);
  const legalAttentionPoints = Array.isArray(analysis.legalAttentionPoints)
    ? analysis.legalAttentionPoints
    : [];
  const sourceTrace = report.sourceTrace;
  const limitations = report.limitations;
  const cadastral = asRecord(analysis.cadastralAnalysis);
  const cadastralReferences = normalizeCadastralReferences(cadastral.references);
  const cadastralActions = normalizeStringList(cadastral.nextActions);
  const cadastralSources = normalizeStringList(cadastral.sources);
  const nearbyServices = asRecord(analysis.nearbyServices);
  const nearbyCategories = normalizeNearbyCategoryLabels(nearbyServices.categories);
  const nearbyActions = normalizeStringList(nearbyServices.nextActions);
  const demographicAnalysis = asRecord(analysis.demographicAnalysis);
  const demographicSignals = normalizeDemographicSignals(demographicAnalysis.signals);
  const demographicActions = normalizeStringList(demographicAnalysis.nextActions);
  const demographicMissingData = normalizeStringList(demographicAnalysis.missingData);
  const demographicLimitations = normalizeStringList(demographicAnalysis.limitations);
  const occupancyAnalysis = asRecord(analysis.occupancyAnalysis);
  const occupancyEvidence = normalizeOccupancyEvidence(occupancyAnalysis.evidence);
  const occupancyActions = normalizeStringList(occupancyAnalysis.nextActions);
  const auctionCostAnalysis = asRecord(analysis.auctionCostAnalysis);
  const auctionCostSignals = normalizeStringList(auctionCostAnalysis.sourceFeeSignals);
  const auctionCostActions = normalizeStringList(auctionCostAnalysis.nextActions);
  const consignation = asRecord(auctionCostAnalysis.consignation);
  const legalAttentionAnalysis = asRecord(analysis.legalAttentionAnalysis);
  const legalAttentionItems = normalizeLegalAttentionItems(legalAttentionAnalysis.items);
  const legalAttentionActions = normalizeStringList(legalAttentionAnalysis.nextActions);
  const urbanPlanningAnalysis = asRecord(analysis.urbanPlanningAnalysis);
  const urbanPlanningItems = normalizeUrbanPlanningItems(urbanPlanningAnalysis.items);
  const urbanPlanningActions = normalizeStringList(urbanPlanningAnalysis.nextActions);
  const urbanPlanningMissingChecks = normalizeStringList(urbanPlanningAnalysis.missingChecks);
  const urbanPlanningLimitations = normalizeStringList(urbanPlanningAnalysis.limitations);
  const dpe = asRecord(analysis.dpe);
  const dpeEvidence = normalizeDpeEvidence(dpe.evidence);
  const dpeActions = normalizeStringList(dpe.nextActions);
  const renovationAnalysis = asRecord(analysis.renovationAnalysis);
  const renovationEvidence = normalizeRenovationEvidence(renovationAnalysis.evidence);
  const renovationActions = normalizeStringList(renovationAnalysis.nextActions);
  const renovationBudgetRange = formatRenovationBudgetRange(
    asRecord(renovationAnalysis.budgetRange),
  );
  const streetFacadeAnalysis = asRecord(analysis.streetFacadeAnalysis);
  const streetFacadeActions = normalizeStringList(streetFacadeAnalysis.nextActions);
  const streetFacadeLimitations = normalizeStringList(streetFacadeAnalysis.limitations);
  const streetLevelUrl = externalUrl(streetFacadeAnalysis.streetLevelUrl);
  const aerial3dUrl = externalUrl(streetFacadeAnalysis.aerial3dUrl);
  const mapUrl = externalUrl(streetFacadeAnalysis.mapUrl);
  const neighborhoodAnalysis = asRecord(analysis.neighborhoodAnalysis);
  const neighborhoodDimensions = normalizeStringList(neighborhoodAnalysis.dimensions);
  const neighborhoodSignals = normalizeNeighborhoodSignals(neighborhoodAnalysis.signals);
  const neighborhoodActions = normalizeStringList(neighborhoodAnalysis.nextActions);
  const activeComparablesAnalysis = asRecord(analysis.activeComparablesAnalysis);
  const activeComparableItems = normalizeActiveComparableItems(activeComparablesAnalysis.items);
  const activeComparableActions = normalizeStringList(activeComparablesAnalysis.nextActions);
  const audienceReadinessAnalysis = asRecord(analysis.audienceReadinessAnalysis);
  const audienceChecklistItems = normalizeAudienceChecklistItems(
    audienceReadinessAnalysis.checklist,
  );
  const audienceReadinessActions = normalizeStringList(audienceReadinessAnalysis.nextActions);
  const ceiling = asRecord(report.ceiling);
  const personalSimulation = reportSimulationSchema.safeParse(ceiling.personalSimulation);

  return (
    <main className="liquid-page min-h-screen px-4 py-10 text-foreground sm:px-6">
      <article className="mx-auto max-w-4xl rounded-lg border border-border bg-white/94 p-6 shadow-sm sm:p-8">
        <header className="border-b border-border pb-5">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-gold-soft">
            Rapport partagé ImmoJudis
          </p>
          <h1 className="mt-3 font-display text-3xl leading-tight text-foreground sm:text-4xl">
            {report.title}
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Mis à jour le {formatDate(report.updatedAt)} · partagé le{" "}
            {report.sharedAt ? formatDate(report.sharedAt) : "date inconnue"}
          </p>
        </header>

        <section className="grid gap-4 border-b border-border py-5 sm:grid-cols-2">
          <SharedMetric
            label="Localisation"
            value={joinValues(sale.address, sale.city, sale.department)}
          />
          <SharedMetric label="Tribunal" value={stringValue(sale.tribunal, "À confirmer")} />
          {reportSaleSchedule(sale).map(({ label, value }) => (
            <SharedMetric key={label} label={label} value={value} />
          ))}
          <SharedMetric
            label="Préparation audience"
            value={stringValue(audienceReadinessAnalysis.summary, "À compléter")}
          />
          <SharedMetric label="Mise à prix" value={formatPrice(numberValue(sale.startingPrice))} />
          <SharedMetric
            label="Occupation"
            value={stringValue(
              occupancyAnalysis.summary,
              stringValue(sale.occupancy, "À vérifier"),
            )}
          />
          <SharedMetric label="Type" value={stringValue(sale.propertyType, "Bien")} />
          <SharedMetric label="Surface" value={stringValue(sale.surfaceLabel, "À confirmer")} />
        </section>

        <section className="grid gap-4 border-b border-border py-5 sm:grid-cols-2">
          <SharedMetric
            label="Prix/m² médian"
            value={
              valueEstimate.medianPricePerM2
                ? formatPricePerM2(numberValue(valueEstimate.medianPricePerM2))
                : "À compléter"
            }
          />
          <SharedMetric
            label="Échantillon DVF"
            value={`${stringValue(valueEstimate.sampleSize, "0")} vente(s) comparable(s)`}
          />
          <SharedMetric
            label="Mise maximum conseillée"
            value={
              ceiling.available ? formatPrice(numberValue(ceiling.maxBid)) : "Données insuffisantes"
            }
          />
          <SharedMetric
            label="Qualité estimation"
            value={stringValue(
              marketComparables.confidenceLabel,
              stringValue(valueEstimate.qualityLabel, "Fragile"),
            )}
          />
          <SharedMetric
            label="Audit estimation"
            value={stringValue(valuationAudit.summary, "Audit estimation à construire")}
          />
          <SharedMetric
            label="Analyse quartier"
            value={stringValue(neighborhoodAnalysis.summary, "Quartier à qualifier")}
          />
          <SharedMetric
            label="Analyse démographique"
            value={stringValue(demographicAnalysis.summary, "Données démographiques à enrichir")}
          />
          <SharedMetric
            label="Comparables en vente"
            value={stringValue(activeComparablesAnalysis.summary, "À rechercher")}
          />
        </section>

        {personalSimulation.success ? (
          <section className="border-b border-border py-5" aria-labelledby="shared-simulation">
            <h2 id="shared-simulation" className="text-lg font-semibold text-foreground">
              Scénario personnel sauvegardé
            </h2>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Prix simulé"
                value={formatPrice(personalSimulation.data.price)}
              />
              <SharedMetric
                label="Travaux saisis"
                value={formatPrice(personalSimulation.data.works)}
              />
              <SharedMetric
                label="Frais préalables saisis"
                value={formatPrice(personalSimulation.data.fpt)}
              />
              <SharedMetric
                label="Scénario"
                value={
                  { prudent: "Prudent", offensif: "Offensif", custom: "Personnalisé" }[
                    personalSimulation.data.scenario
                  ]
                }
              />
              <SharedMetric
                label="Marge de sécurité"
                value={formatPercent(numberValue(ceiling.safetyDiscountPct))}
              />
              <SharedMetric
                label="Base retenue"
                value={stringValue(ceiling.basisLabel, "À confirmer")}
              />
              <SharedMetric
                label="Coût complet au prix simulé"
                value={
                  typeof acquisitionCosts.totalCost === "number"
                    ? formatPrice(acquisitionCosts.totalCost)
                    : "À confirmer"
                }
              />
              {personalSimulation.data.manualMarketPricePerM2 != null ? (
                <SharedMetric
                  label="Référence de marché saisie"
                  value={formatPricePerM2(personalSimulation.data.manualMarketPricePerM2)}
                />
              ) : null}
            </div>
          </section>
        ) : null}

        {marketComparables.available ? (
          <section className="border-b border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Comparables DVF
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Synthèse"
                value={stringValue(marketComparables.summary, "Comparables à compléter")}
              />
              <SharedMetric
                label="Mode"
                value={stringValue(marketComparables.comparableModeLabel, "À confirmer")}
              />
              <SharedMetric
                label="Fenêtre surface"
                value={stringValue(marketComparables.surfaceWindowLabel, "À confirmer")}
              />
              <SharedMetric
                label="Fourchette"
                value={stringValue(marketComparables.priceRangeLabel, "À confirmer")}
              />
            </div>
            {retainedComparables.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-foreground">
                {retainedComparables.slice(0, 5).map((row) => (
                  <li key={row}>{row}</li>
                ))}
              </ul>
            ) : null}
            {addressHistory.length ? (
              <div className="mt-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                  Historique adresse
                </p>
                <ul className="mt-2 space-y-2 text-sm leading-relaxed text-foreground">
                  {addressHistory.slice(0, 3).map((row) => (
                    <li key={row}>{row}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {marketComparablesActions.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground">
                {marketComparablesActions.slice(0, 3).map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {valuationAudit.available || valuationCheckpoints.length ? (
          <section className="border-b border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Audit de valorisation
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Synthèse"
                value={stringValue(valuationAudit.summary, "Audit estimation à construire")}
              />
              <SharedMetric
                label="Niveau"
                value={stringValue(valuationAudit.confidenceLabel, "À vérifier")}
              />
              <SharedMetric label="Score" value={`${stringValue(valuationAudit.score, "0")}/100`} />
              <SharedMetric
                label="Impact décision"
                value={stringValue(
                  valuationAudit.decisionImpact,
                  "Estimation à recouper avant plafond",
                )}
              />
            </div>
            {valuationCheckpoints.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-foreground">
                {valuationCheckpoints.slice(0, 8).map((checkpoint) => (
                  <li key={checkpoint}>{checkpoint}</li>
                ))}
              </ul>
            ) : null}
            {valuationRiskFlags.length ? (
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                Points à risque : {valuationRiskFlags.slice(0, 5).join(" · ")}
              </p>
            ) : null}
            {valuationActions.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground">
                {valuationActions.slice(0, 4).map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            ) : null}
            {valuationLimitations.length ? (
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                {valuationLimitations.slice(0, 2).join(" · ")}
              </p>
            ) : null}
          </section>
        ) : null}

        {activeComparablesAnalysis.available ? (
          <section className="border-b border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Biens comparables en vente
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Synthèse"
                value={stringValue(activeComparablesAnalysis.summary, "Comparables à rechercher")}
              />
              <SharedMetric
                label="Périmètre"
                value={stringValue(activeComparablesAnalysis.scopeLabel, "À confirmer")}
              />
              <SharedMetric
                label="Niveau de confiance"
                value={stringValue(activeComparablesAnalysis.confidenceLabel, "À vérifier")}
              />
              <SharedMetric
                label="Impact décision"
                value={stringValue(
                  activeComparablesAnalysis.decisionImpact,
                  "À croiser avec le plafond",
                )}
              />
            </div>
            {activeComparableItems.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-foreground">
                {activeComparableItems.slice(0, 5).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
            {activeComparableActions.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground">
                {activeComparableActions.slice(0, 3).map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {audienceReadinessAnalysis.available ? (
          <section className="border-b border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Préparation audience
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Synthèse"
                value={stringValue(audienceReadinessAnalysis.summary, "Préparation à compléter")}
              />
              <SharedMetric
                label="Urgence"
                value={stringValue(audienceReadinessAnalysis.urgencyLabel, "Date à confirmer")}
              />
              <SharedMetric
                label="Progression"
                value={`${stringValue(audienceReadinessAnalysis.progressPct, "0")} %`}
              />
              <SharedMetric
                label="Points prioritaires"
                value={stringValue(audienceReadinessAnalysis.highPriorityOpenCount, "0")}
              />
              <SharedMetric
                label="Impact décision"
                value={stringValue(
                  audienceReadinessAnalysis.decisionImpact,
                  "À arbitrer avant enchère",
                )}
              />
              <SharedMetric
                label="Visites"
                value={`${normalizeStringList(audienceReadinessAnalysis.visitDates).length} mention(s)`}
              />
            </div>
            {audienceChecklistItems.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-foreground">
                {audienceChecklistItems.slice(0, 8).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
            {audienceReadinessActions.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground">
                {audienceReadinessActions.slice(0, 4).map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        <section className="grid gap-4 border-b border-border py-5 sm:grid-cols-2">
          <SharedMetric
            label="Score d'opportunité"
            value={
              opportunity.score != null
                ? `${stringValue(opportunity.score, "")}/100 · ${stringValue(opportunity.label, "À qualifier")}`
                : "À compléter"
            }
          />
          <SharedMetric
            label="Décote apparente"
            value={formatPercent(numberValue(opportunity.apparentDiscountPct))}
          />
          <SharedMetric
            label="Valeur médiane estimée"
            value={formatPrice(numberValue(opportunity.estimatedMarketValue))}
          />
          <SharedMetric
            label="Rendement brut potentiel"
            value={formatPercent(numberValue(opportunity.grossYieldPct))}
          />
          <SharedMetric
            label="Score rentabilité"
            value={
              rentabilityScore.score != null
                ? `${stringValue(rentabilityScore.score, "")}/100 · ${stringValue(rentabilityScore.label, "À qualifier")}`
                : "À compléter"
            }
          />
          <SharedMetric
            label="Rendement net estimé"
            value={formatPercent(numberValue(rentabilityScore.netYieldPct))}
          />
          <SharedMetric
            label="Cashflow mensuel"
            value={formatPrice(numberValue(rentabilityScore.cashflowMonthly))}
          />
          <SharedMetric
            label="Frais estimés"
            value={stringValue(
              auctionCostAnalysis.summary,
              formatPrice(numberValue(acquisitionCosts.acquisitionFeesTotal)),
            )}
          />
          <SharedMetric
            label="Travaux / état"
            value={stringValue(renovationAnalysis.summary, "À qualifier")}
          />
          <SharedMetric
            label="Coût complet"
            value={formatPrice(numberValue(acquisitionCosts.totalCost))}
          />
        </section>

        <section className="grid gap-4 py-5 sm:grid-cols-2">
          <SharedMetric
            label="Cadastre"
            value={stringValue(
              cadastral.summary,
              cadastral.available ? "Repère disponible" : "À connecter ou confirmer",
            )}
          />
          <SharedMetric
            label="DPE / diagnostics"
            value={stringValue(
              dpe.summary,
              dpe.available ? stringValue(dpe.class, "Diagnostic repéré") : "À rechercher",
            )}
          />
          <SharedMetric
            label="Urbanisme / permis"
            value={stringValue(
              urbanPlanningAnalysis.summary,
              "Urbanisme, permis et servitudes à vérifier",
            )}
          />
          <SharedMetric
            label="Travaux / état"
            value={stringValue(renovationAnalysis.summary, "À qualifier")}
          />
          <SharedMetric
            label="Façade et rue"
            value={stringValue(streetFacadeAnalysis.summary, "Localisation à confirmer")}
          />
          <SharedMetric
            label="Services de proximité"
            value={stringValue(
              nearbyServices.summary,
              nearbyServices.available ? "Signaux repérés" : "À qualifier",
            )}
          />
          <SharedMetric
            label="Analyse du quartier"
            value={stringValue(neighborhoodAnalysis.summary, "À qualifier")}
          />
          <SharedMetric
            label="Démographie locale"
            value={stringValue(demographicAnalysis.summary, "Données locales à enrichir")}
          />
          <SharedMetric
            label="Documents"
            value={`${stringValue(analysis.documentsCount, "0")} pièce(s)`}
          />
          <SharedMetric label="Vues du lien" value={String(report.viewCount)} />
        </section>

        {cadastral.available ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Analyse cadastrale
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Niveau de confiance"
                value={stringValue(cadastral.confidenceLabel, "À confirmer")}
              />
              <SharedMetric
                label="Surface terrain"
                value={formatSurfaceM2(numberValue(cadastral.landSurfaceM2))}
              />
            </div>
            {cadastralReferences.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-foreground">
                {cadastralReferences.map((reference) => (
                  <li key={reference}>{reference}</li>
                ))}
              </ul>
            ) : null}
            {cadastralSources.length ? (
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                Sources : {cadastralSources.slice(0, 4).join(" · ")}
              </p>
            ) : null}
            {cadastralActions.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground">
                {cadastralActions.slice(0, 3).map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {dpe.available ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              DPE et diagnostics
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Niveau de confiance"
                value={stringValue(dpe.confidenceLabel, "À confirmer")}
              />
              <SharedMetric
                label="Impact"
                value={stringValue(dpe.impactLabel, "Impact à qualifier")}
              />
              <SharedMetric
                label="Priorité travaux"
                value={renovationPriorityLabel(stringValue(dpe.renovationPriority, ""))}
              />
              <SharedMetric label="Source" value={dpeSourceLabel(stringValue(dpe.source, ""))} />
            </div>
            {dpeEvidence.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-foreground">
                {dpeEvidence.slice(0, 4).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
            {dpeActions.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground">
                {dpeActions.slice(0, 3).map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {renovationAnalysis.available ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Travaux et état
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Priorité"
                value={renovationPriorityLabel(stringValue(renovationAnalysis.priority, ""))}
              />
              <SharedMetric
                label="Budget indicatif"
                value={renovationBudgetRange || "À chiffrer"}
              />
              <SharedMetric
                label="Niveau de confiance"
                value={stringValue(renovationAnalysis.confidenceLabel, "À confirmer")}
              />
              <SharedMetric
                label="Impact décision"
                value={stringValue(
                  renovationAnalysis.decisionImpact,
                  "État à confirmer avant enchère",
                )}
              />
            </div>
            {renovationEvidence.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-foreground">
                {renovationEvidence.slice(0, 4).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
            {renovationActions.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground">
                {renovationActions.slice(0, 3).map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {urbanPlanningAnalysis.status || urbanPlanningMissingChecks.length ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Urbanisme, permis et servitudes
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Synthèse"
                value={stringValue(
                  urbanPlanningAnalysis.summary,
                  "Urbanisme, permis et servitudes à vérifier",
                )}
              />
              <SharedMetric
                label="Niveau de confiance"
                value={stringValue(urbanPlanningAnalysis.confidenceLabel, "À vérifier")}
              />
              <SharedMetric
                label="Contrôles manquants"
                value={`${urbanPlanningMissingChecks.length} point(s)`}
              />
              <SharedMetric
                label="Impact décision"
                value={stringValue(
                  urbanPlanningAnalysis.decisionImpact,
                  "À intégrer avant le plafond d'enchère",
                )}
              />
            </div>
            {urbanPlanningItems.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-foreground">
                {urbanPlanningItems.slice(0, 6).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
            {urbanPlanningMissingChecks.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground">
                {urbanPlanningMissingChecks.slice(0, 4).map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
            ) : null}
            {urbanPlanningActions.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground">
                {urbanPlanningActions.slice(0, 4).map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            ) : null}
            {urbanPlanningLimitations.length ? (
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                {urbanPlanningLimitations.slice(0, 2).join(" · ")}
              </p>
            ) : null}
          </section>
        ) : null}

        {streetFacadeAnalysis.available ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Façade et rue
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Synthèse"
                value={stringValue(streetFacadeAnalysis.summary, "Localisation à confirmer")}
              />
              <SharedMetric
                label="Niveau de confiance"
                value={stringValue(streetFacadeAnalysis.confidenceLabel, "À confirmer")}
              />
              <SharedMetric
                label="Adresse"
                value={stringValue(streetFacadeAnalysis.addressLabel, "À confirmer")}
              />
              <SharedMetric
                label="Impact décision"
                value={stringValue(
                  streetFacadeAnalysis.decisionImpact,
                  "Vérifier l'environnement visible avant enchère",
                )}
              />
            </div>
            {mapUrl || streetLevelUrl || aerial3dUrl ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {streetLevelUrl ? (
                  <SharedExternalLink href={streetLevelUrl} label="Vue 3D du quartier" />
                ) : null}
                {aerial3dUrl ? <SharedExternalLink href={aerial3dUrl} label="Vue 3D" /> : null}
                {mapUrl ? <SharedExternalLink href={mapUrl} label="Carte" /> : null}
              </div>
            ) : null}
            {streetFacadeActions.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground">
                {streetFacadeActions.slice(0, 3).map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            ) : null}
            {streetFacadeLimitations.length ? (
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                {streetFacadeLimitations.slice(0, 2).join(" · ")}
              </p>
            ) : null}
          </section>
        ) : null}

        {neighborhoodAnalysis.available ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Analyse du quartier
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Synthèse"
                value={stringValue(neighborhoodAnalysis.summary, "Quartier à qualifier")}
              />
              <SharedMetric
                label="Niveau de confiance"
                value={stringValue(neighborhoodAnalysis.confidenceLabel, "À confirmer")}
              />
              <SharedMetric
                label="Marché local"
                value={stringValue(neighborhoodAnalysis.marketPositionLabel, "À calculer")}
              />
              <SharedMetric
                label="Services"
                value={stringValue(neighborhoodAnalysis.serviceCoverageLabel, "À qualifier")}
              />
              <SharedMetric
                label="Localisation"
                value={stringValue(neighborhoodAnalysis.locationQualityLabel, "À géocoder")}
              />
              <SharedMetric
                label="Impact décision"
                value={stringValue(
                  neighborhoodAnalysis.decisionImpact,
                  "À intégrer avant décision",
                )}
              />
            </div>
            {neighborhoodDimensions.length ? (
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                Dimensions : {neighborhoodDimensions.join(" · ")}
              </p>
            ) : null}
            {neighborhoodSignals.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-foreground">
                {neighborhoodSignals.slice(0, 5).map((signal) => (
                  <li key={signal}>{signal}</li>
                ))}
              </ul>
            ) : null}
            {neighborhoodActions.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground">
                {neighborhoodActions.slice(0, 3).map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {demographicAnalysis.status || demographicMissingData.length ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Analyse démographique
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Synthèse"
                value={stringValue(
                  demographicAnalysis.summary,
                  "Données démographiques à enrichir",
                )}
              />
              <SharedMetric
                label="Niveau de confiance"
                value={stringValue(demographicAnalysis.confidenceLabel, "À vérifier")}
              />
              <SharedMetric
                label="Profil local"
                value={stringValue(demographicAnalysis.profileLabel, "Profil à enrichir")}
              />
              <SharedMetric
                label="Demande"
                value={stringValue(demographicAnalysis.demandLabel, "Demande à qualifier")}
              />
              <SharedMetric
                label="Données manquantes"
                value={`${demographicMissingData.length} point(s)`}
              />
              <SharedMetric
                label="Impact décision"
                value={stringValue(
                  demographicAnalysis.decisionImpact,
                  "À intégrer avant de figer le scénario",
                )}
              />
            </div>
            {demographicSignals.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-foreground">
                {demographicSignals.slice(0, 6).map((signal) => (
                  <li key={signal}>{signal}</li>
                ))}
              </ul>
            ) : null}
            {demographicMissingData.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground">
                {demographicMissingData.slice(0, 4).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
            {demographicActions.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground">
                {demographicActions.slice(0, 4).map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            ) : null}
            {demographicLimitations.length ? (
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                {demographicLimitations.slice(0, 2).join(" · ")}
              </p>
            ) : null}
          </section>
        ) : null}

        {nearbyServices.available ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Services de proximité
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Niveau de confiance"
                value={stringValue(nearbyServices.confidenceLabel, "À confirmer")}
              />
              <SharedMetric
                label="Localisation"
                value={locationQualityLabel(stringValue(nearbyServices.locationQuality, ""))}
              />
            </div>
            {nearbyCategories.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-foreground">
                {nearbyCategories.map((category) => (
                  <li key={category}>{category}</li>
                ))}
              </ul>
            ) : null}
            {nearbyActions.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground">
                {nearbyActions.slice(0, 3).map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {occupancyAnalysis.available ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Occupation
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Niveau de confiance"
                value={stringValue(occupancyAnalysis.confidenceLabel, "À confirmer")}
              />
              <SharedMetric
                label="Impact décision"
                value={stringValue(occupancyAnalysis.decisionImpact, "À vérifier avant enchère")}
              />
            </div>
            {occupancyEvidence.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-foreground">
                {occupancyEvidence.slice(0, 4).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
            {occupancyActions.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground">
                {occupancyActions.slice(0, 3).map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {auctionCostAnalysis.available ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Frais et consignation
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Niveau de confiance"
                value={stringValue(auctionCostAnalysis.confidenceLabel, "À confirmer")}
              />
              <SharedMetric
                label="Consignation"
                value={formatKnownPrice(numberValue(consignation.amountEur))}
              />
              <SharedMetric
                label="Émoluments TTC"
                value={formatKnownPrice(numberValue(auctionCostAnalysis.emolumentsTtcEur))}
              />
              <SharedMetric
                label="Droits estimés"
                value={formatKnownPrice(numberValue(auctionCostAnalysis.registrationDutiesEur))}
              />
            </div>
            {auctionCostSignals.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-foreground">
                {auctionCostSignals.slice(0, 4).map((signal) => (
                  <li key={signal}>{signal}</li>
                ))}
              </ul>
            ) : null}
            {auctionCostActions.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground">
                {auctionCostActions.slice(0, 3).map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {legalAttentionAnalysis.available ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Revue juridique
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Synthèse"
                value={stringValue(legalAttentionAnalysis.summary, "Points à relire")}
              />
              <SharedMetric
                label="Niveau de revue"
                value={stringValue(legalAttentionAnalysis.confidenceLabel, "À vérifier")}
              />
            </div>
            {legalAttentionItems.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-foreground">
                {legalAttentionItems.slice(0, 6).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
            {legalAttentionActions.length ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground">
                {legalAttentionActions.slice(0, 4).map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            ) : null}
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              {stringValue(
                legalAttentionAnalysis.disclaimer,
                "Revue opérationnelle, sans avis juridique.",
              )}
            </p>
          </section>
        ) : null}

        {legalAttentionPoints.length ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Points d'attention
            </p>
            <ul className="mt-3 space-y-2 text-sm leading-relaxed text-foreground">
              {legalAttentionPoints.map((point, index) => (
                <li key={`${index}-${String(point)}`}>{stringValue(point, "")}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {sourceTrace.length ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Sources et traçabilité
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {sourceTrace.map((entry) => (
                <div key={entry.id} className="rounded-lg border border-border bg-muted/25 p-3">
                  <p className="text-sm font-semibold text-foreground">{entry.label}</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {entry.sourceName}
                    {entry.capturedAt ? ` · ${formatDate(entry.capturedAt)}` : ""}
                  </p>
                  {entry.detail ? (
                    <p className="mt-2 text-xs leading-relaxed text-foreground">{entry.detail}</p>
                  ) : null}
                  <p className="mt-2 text-[11px] font-semibold text-muted-foreground">
                    {entry.confidenceLabel}
                  </p>
                  {entry.url ? (
                    <a
                      className="mt-2 inline-flex text-xs font-semibold text-gold-soft underline-offset-4 hover:underline"
                      href={entry.url}
                      rel="noreferrer"
                      target={entry.url.startsWith("http") ? "_blank" : undefined}
                    >
                      Ouvrir la source
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {limitations.length ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Limites à confirmer
            </p>
            <ul className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
              {limitations.map((limitation, index) => (
                <li key={`${index}-${limitation}`}>{limitation}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="mt-4 rounded-lg border border-[#1e40af]/15 bg-[#1e40af]/8 p-4 text-sm leading-relaxed text-[#1e3a8a]">
          {report.disclaimer}
        </footer>
      </article>
    </main>
  );
}

function SharedMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-sm font-semibold text-foreground">{value || "À confirmer"}</p>
    </div>
  );
}

function SharedExternalLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      className="inline-flex min-h-10 items-center rounded-md border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted/40"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {label}
    </a>
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown, fallback: string | null): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback ?? "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
}

function normalizeCadastralReferences(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const section = stringValue(record.section, "");
      const number = stringValue(record.number, "");
      const raw = stringValue(record.raw, "");
      const prefix = stringValue(record.prefix, "");
      if (section && number) return `Section ${prefix ? `${prefix} ` : ""}${section} n° ${number}`;
      return raw;
    })
    .filter(Boolean);
}

function normalizeNearbyCategoryLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const status = stringValue(record.status, "");
      if (status !== "mentioned") return "";
      return stringValue(record.label, "");
    })
    .filter(Boolean);
}

function normalizeOccupancyEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const label = stringValue(record.label, "");
      const source = stringValue(record.source, "");
      const excerpt = stringValue(record.excerpt, "");
      return [label, source, excerpt].filter(Boolean).join(" · ");
    })
    .filter(Boolean);
}

function normalizeDpeEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const label = stringValue(record.label, "");
      const source = stringValue(record.source, "");
      const excerpt = stringValue(record.excerpt, "");
      return [label, source, excerpt].filter(Boolean).join(" · ");
    })
    .filter(Boolean);
}

function normalizeRenovationEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const label = stringValue(record.label, "");
      const source = stringValue(record.source, "");
      const excerpt = stringValue(record.excerpt, "");
      return [label, source, excerpt].filter(Boolean).join(" · ");
    })
    .filter(Boolean);
}

function normalizeNeighborhoodSignals(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const label = stringValue(record.label, "");
      const status = neighborhoodSignalStatusLabel(stringValue(record.status, ""));
      const source = stringValue(record.source, "");
      const detail = stringValue(record.detail, "");
      return [status, label, source, detail].filter(Boolean).join(" · ");
    })
    .filter(Boolean);
}

function normalizeDemographicSignals(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const status = demographicSignalStatusLabel(stringValue(record.status, ""));
      const label = stringValue(record.label, "");
      const source = stringValue(record.source, "");
      const detail = stringValue(record.detail, "");
      const impact = stringValue(record.impact, "");
      return [status, label, source, detail, impact].filter(Boolean).join(" · ");
    })
    .filter(Boolean);
}

function normalizeLegalAttentionItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const priority = stringValue(record.priority, "");
      const label = stringValue(record.label, "");
      const reason = stringValue(record.reason, "");
      const action = stringValue(record.action, "");
      return [
        priority ? priorityLabel(priority) : null,
        label,
        reason,
        action ? `Action : ${action}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    })
    .filter(Boolean);
}

function normalizeUrbanPlanningItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const priority = priorityLabel(stringValue(record.priority, ""));
      const status = urbanPlanningStatusLabel(stringValue(record.status, ""));
      const label = stringValue(record.label, "");
      const source = stringValue(record.source, "");
      const detail = stringValue(record.detail, "");
      const action = stringValue(record.action, "");
      return [priority, status, label, source, detail, action ? `Action : ${action}` : null]
        .filter(Boolean)
        .join(" · ");
    })
    .filter(Boolean);
}

function normalizeMarketComparableRows(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const date = stringValue(record.date, "");
      const type = stringValue(record.type, "Bien");
      const totalPrice = numberValue(record.totalPriceEur);
      const pricePerM2 = numberValue(record.pricePerM2);
      const surface = numberValue(record.surfaceM2);
      const distance = numberValue(record.distanceM);
      return [
        date ? formatDate(date) : null,
        type,
        totalPrice != null ? formatPrice(totalPrice) : null,
        pricePerM2 != null ? formatPricePerM2(pricePerM2) : null,
        surface != null ? `${Math.round(surface)} m²` : null,
        distance != null ? `${Math.round(distance)} m` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    })
    .filter(Boolean);
}

function normalizeValuationCheckpoints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const status = valuationStatusLabel(stringValue(record.status, ""));
      const label = stringValue(record.label, "");
      const detail = stringValue(record.detail, "");
      const action = stringValue(record.action, "");
      return [status, label, detail, action ? `Action : ${action}` : null]
        .filter(Boolean)
        .join(" · ");
    })
    .filter(Boolean);
}

function normalizeActiveComparableItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const title = stringValue(record.title, "Bien actif");
      const city = stringValue(record.city, "");
      const saleDate = stringValue(record.saleDate, "");
      const startingPrice = numberValue(record.startingPriceEur);
      const pricePerM2 = numberValue(record.pricePerM2);
      const surface = numberValue(record.surfaceM2);
      const matchLabel = stringValue(record.matchLabel, "");
      const matchScore = numberValue(record.matchScore);
      return [
        matchLabel && matchScore != null ? `${matchLabel} (${matchScore}/100)` : matchLabel,
        title,
        city,
        saleDate ? formatDate(saleDate) : null,
        startingPrice != null ? formatPrice(startingPrice) : null,
        pricePerM2 != null ? formatPricePerM2(pricePerM2) : null,
        surface != null ? `${Math.round(surface)} m²` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    })
    .filter(Boolean);
}

function normalizeAudienceChecklistItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const label = stringValue(record.label, "");
      const status = audienceChecklistStatusLabel(stringValue(record.status, ""));
      const priority = priorityLabel(stringValue(record.priority, ""));
      const detail = stringValue(record.detail, "");
      const action = stringValue(record.action, "");
      return [status, priority, label, detail, action ? `Action : ${action}` : null]
        .filter(Boolean)
        .join(" · ");
    })
    .filter(Boolean);
}

function priorityLabel(value: string): string {
  const labels: Record<string, string> = {
    high: "Prioritaire",
    medium: "À vérifier",
    low: "Contrôle",
  };
  return labels[value] ?? value;
}

function audienceChecklistStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    done: "OK",
    to_do: "À faire",
    watch: "À vérifier",
  };
  return labels[value] ?? value;
}

function urbanPlanningStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    documented: "Documenté",
    to_verify: "À confirmer",
    missing: "Manquant",
  };
  return labels[value] ?? value;
}

function renovationPriorityLabel(value: string): string {
  const labels: Record<string, string> = {
    low: "Faible",
    medium: "À calibrer",
    high: "Prioritaire",
    unknown: "À qualifier",
  };
  return labels[value] ?? "À confirmer";
}

function dpeSourceLabel(value: string): string {
  const labels: Record<string, string> = {
    source_blocks: "Données source",
    documents: "Pièces du dossier",
    risk_evidence: "Preuves de risques",
  };
  return labels[value] ?? "À confirmer";
}

function locationQualityLabel(value: string): string {
  const labels: Record<string, string> = {
    coordinates: "Coordonnées disponibles",
    address: "Adresse disponible",
    commune: "Commune disponible",
    missing: "À géocoder",
  };
  return labels[value] ?? "À confirmer";
}

function neighborhoodSignalStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    positive: "Atout",
    watch: "À vérifier",
    to_enrich: "À enrichir",
  };
  return labels[value] ?? value;
}

function demographicSignalStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    source_signal: "Signal source",
    proxy: "Proxy",
  };
  return labels[value] ?? value;
}

function valuationStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    ok: "OK",
    watch: "À surveiller",
    risk: "Risque",
    missing: "Manquant",
  };
  return labels[value] ?? value;
}

function formatSurfaceM2(value: number | null): string {
  if (value == null) return "À confirmer";
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(value)} m²`;
}

function formatKnownPrice(value: number | null): string {
  return value == null ? "À confirmer" : formatPrice(value);
}

function formatPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(value)} %`;
}

function formatRenovationBudgetRange(range: Record<string, unknown>): string {
  const lowEur = numberValue(range.lowEur);
  const highEur = numberValue(range.highEur);
  if (lowEur != null && highEur != null) {
    return `${formatPrice(lowEur)} - ${formatPrice(highEur)}`;
  }
  const lowPerM2 = numberValue(range.lowPerM2);
  const highPerM2 = numberValue(range.highPerM2);
  if (lowPerM2 != null && highPerM2 != null) {
    return `${formatPricePerM2(lowPerM2)} - ${formatPricePerM2(highPerM2)}`;
  }
  return "";
}

function externalUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.startsWith("https://") || trimmed.startsWith("http://") ? trimmed : "";
}

function joinValues(...values: unknown[]): string {
  return values
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .join(", ");
}
