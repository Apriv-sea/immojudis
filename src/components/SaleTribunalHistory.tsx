"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.js";
import BadgeEuro from "lucide-react/dist/esm/icons/badge-euro.js";
import BarChart3 from "lucide-react/dist/esm/icons/bar-chart-3.js";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.js";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { Skeleton } from "@/components/ui/skeleton";
import { bidBands, bidBandLabels } from "@/lib/adjudication-distributions";
import { fetchAdjudicationPriceStatistics } from "@/lib/adjudication-price-statistics-client";
import { adjudicationPriceStatisticsReliability } from "@/lib/adjudication-price-statistics";
import type {
  AdjudicationPriceStatisticsResponse,
  AdjudicationPriceStatisticsScope,
} from "@/lib/adjudication-price-statistics";
import { fetchTribunalJudicialActivity } from "@/lib/tribunal-judicial-activity-client";
import { fetchTribunalJudicialActivityDirectory } from "@/lib/tribunal-judicial-activity-directory-client";
import type { TribunalJudicialActivityDirectoryResponse } from "@/lib/tribunal-judicial-activity-directory";
import {
  TRIBUNAL_JUDICIAL_ACTIVITY_MIN_SAMPLE,
  TribunalCourtUnresolvedError,
} from "@/lib/tribunal-judicial-activity";
import type {
  TribunalJudicialActivityMetric,
  TribunalJudicialActivityRangeMetric,
  TribunalJudicialActivityResponse,
} from "@/lib/tribunal-judicial-activity";
import type { AuctionSale } from "@/lib/types";

export function SaleTribunalHistory({
  sale,
  premium = false,
}: {
  sale: AuctionSale;
  premium?: boolean;
}) {
  const [activityRequested, setActivityRequested] = useState(false);
  const courtLabel = sale.tribunal_name?.trim() || sale.tribunal?.trim() || null;
  const directoryQuery = useQuery({
    queryKey: ["tribunal-judicial-activity-directory", 36],
    queryFn: () => fetchTribunalJudicialActivityDirectory(36),
    enabled: activityRequested,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const tribunalQuery = useQuery({
    queryKey: ["tribunal-judicial-activity", sale.id, 36],
    queryFn: () => fetchTribunalJudicialActivity({ saleId: sale.id, historyMonths: 36 }),
    enabled: activityRequested && Boolean(sale.id),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const adjudicationStatisticsQuery = useQuery({
    queryKey: ["adjudication-price-statistics", sale.id],
    queryFn: () => fetchAdjudicationPriceStatistics(sale.id),
    enabled: premium && Boolean(sale.id),
    retry: false,
    staleTime: 5 * 60_000,
  });

  return (
    <section
      id="tribunal-history"
      className="scroll-mt-36 border-b border-brand-navy/10 bg-white"
      aria-labelledby="tribunal-history-title"
    >
      <div className="mx-auto max-w-[1260px] px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
        <div>
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-gold-soft">
            <Landmark className="h-4 w-4" aria-hidden />
            Statistiques des ventes judiciaires
          </p>
          <h2
            id="tribunal-history-title"
            className="mt-2 font-display text-4xl font-medium text-brand-navy sm:text-5xl"
          >
            Historique des enchères
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-brand-navy/65 sm:text-base">
            Les adjudications décrivent des ventes terminées. Le suivi des annonces décrit un autre
            échantillon. Ces historiques ne constituent pas une estimation de ce bien.
          </p>
        </div>

        {premium ? (
          <AdjudicationPriceStatistics
            data={adjudicationStatisticsQuery.data}
            loading={adjudicationStatisticsQuery.isLoading}
            unavailable={adjudicationStatisticsQuery.isError}
            courtLabel={courtLabel}
            propertyType={sale.property_type}
            onRetry={() => void adjudicationStatisticsQuery.refetch()}
            retrying={adjudicationStatisticsQuery.isFetching}
          />
        ) : null}

        <details
          className="mt-6 rounded-lg border border-slate-200 p-5"
          onToggle={(event) => {
            if (event.currentTarget.open) setActivityRequested(true);
          }}
        >
          <summary className="cursor-pointer font-semibold text-brand-navy">
            Suivi des annonces : couverture, visites et délais
          </summary>
          <p className="mt-3 text-sm text-slate-600">
            Échantillon du catalogue Immojudis, distinct des résultats Licitor et des transactions
            DVF. Les effectifs varient selon les champs renseignés. Le délai mesure la première
            détection par Immojudis jusqu’à la vente, pas la date de publication officielle.
          </p>
          <div className="mt-8">
            <ScopeHeading level="Niveau 1 · France entière" title="Repères nationaux" />
            {directoryQuery.isLoading ? (
              <ScopeSkeleton />
            ) : directoryQuery.isError || !directoryQuery.data ? (
              <ScopeUnavailable
                title="Repères France momentanément indisponibles"
                onRetry={() => void directoryQuery.refetch()}
                retrying={directoryQuery.isFetching}
                detail="Les statistiques nationales restent prévues sur cette fiche et seront de nouveau affichées dès que l’agrégat contrôlé sera accessible."
              />
            ) : (
              <NationalActivity data={directoryQuery.data} />
            )}
          </div>

          <div className="mt-10 border-t border-brand-navy/12 pt-8">
            <ScopeHeading
              level="Niveau 2 · Tribunal concerné"
              title={
                tribunalQuery.data?.court.name ?? courtLabel ?? "Tribunal en cours de rattachement"
              }
            />
            {tribunalQuery.isLoading ? (
              <ScopeSkeleton />
            ) : tribunalQuery.isError || !tribunalQuery.data ? (
              <ScopeUnavailable
                onRetry={
                  tribunalQuery.error instanceof TribunalCourtUnresolvedError
                    ? undefined
                    : () => void tribunalQuery.refetch()
                }
                retrying={tribunalQuery.isFetching}
                title={
                  courtLabel
                    ? `Statistiques de ${courtLabel} en cours de consolidation`
                    : "Rattachement exact au tribunal en cours"
                }
                detail="Immojudis publiera ce niveau lorsque le rattachement au référentiel officiel et l’échantillon du même tribunal auront été contrôlés ; aucune statistique approximative n’est substituée."
              />
            ) : isTribunalProfilePublishable(tribunalQuery.data) ? (
              <JudicialActivity activity={tribunalQuery.data} sale={sale} />
            ) : (
              <InsufficientTribunalData activity={tribunalQuery.data} />
            )}
          </div>
        </details>

        <div className="mt-7 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div className="text-xs leading-relaxed text-brand-navy/70">
            <p>
              Ces chiffres décrivent les annonces judiciaires vérifiées ou recoupées suivies par
              Immojudis ; ils ne mesurent pas l’activité exhaustive des greffes.
            </p>
            <p className="mt-2 font-semibold text-brand-navy/68">
              Les résultats Licitor, lorsqu’ils sont disponibles ci-dessus, restent une observation
              historique distincte du suivi des annonces et des transactions de marché DVF.
            </p>
          </div>
          <a
            href="/tribunaux"
            className="inline-flex min-h-10 shrink-0 items-center gap-2 text-xs font-semibold text-gold-soft hover:text-gold"
          >
            Explorer tous les tribunaux
            <ArrowUpRight className="h-4 w-4" aria-hidden />
          </a>
        </div>
      </div>
    </section>
  );
}

function AdjudicationPriceStatistics({
  data,
  loading,
  unavailable,
  courtLabel,
  propertyType,
  onRetry,
  retrying,
}: {
  data?: AdjudicationPriceStatisticsResponse;
  loading: boolean;
  unavailable: boolean;
  courtLabel: string | null;
  propertyType: string | null;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div className="mt-10 border-t border-brand-navy/12 pt-8">
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-gold-soft">
        <BadgeEuro className="h-4 w-4" aria-hidden />
        Résultats d’adjudication · Offre Analyse
      </p>
      <h3 className="mt-2 font-display text-2xl font-semibold text-brand-navy sm:text-3xl">
        Du prix de départ au prix adjugé
      </h3>
      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-brand-navy/62">
        Résultats publiés par Licitor. Le type de bien de cette annonce est présenté en priorité, au
        tribunal lorsqu’il est disponible, sinon à l’échelle nationale. Les écarts de surface,
        d’état, d’occupation et de localisation restent à prendre en compte.
      </p>

      {loading ? (
        <ScopeSkeleton />
      ) : unavailable || !data ? (
        <ScopeUnavailable
          title="Résultats d’adjudication en cours de validation"
          onRetry={onRetry}
          retrying={retrying}
          detail="Les résultats ne sont pas disponibles pour le moment. Les autres repères restent consultables."
        />
      ) : (
        <div className="mt-7 space-y-8">
          <RelevantAdjudications data={data} propertyType={propertyType} courtLabel={courtLabel} />
          <details className="rounded-lg border border-slate-200 p-5">
            <summary className="cursor-pointer font-semibold text-brand-navy">
              Détail historique tous biens confondus
            </summary>
            <p className="my-4 text-sm text-slate-600">
              Ces montants et multiplicateurs ne prédisent pas le prix de cette annonce. Ne
              multipliez pas sa mise à prix par le ratio historique pour en déduire une valeur.
            </p>
            <AdjudicationPriceScope heading="France entière" scope={data.national} />
            {data.tribunal ? (
              <AdjudicationPriceScope heading={data.tribunal.label} scope={data.tribunal} />
            ) : null}
          </details>
          <p className="text-xs leading-relaxed text-brand-navy/70">
            Source : {data.meta.sourceLabel}. {data.meta.warning} Données préparées le{" "}
            {formatDate(data.meta.builtAt.slice(0, 10))}, validé le{" "}
            {formatDate(data.meta.reviewedAt.slice(0, 10))}.
          </p>
        </div>
      )}
    </div>
  );
}

function RelevantAdjudications({
  data,
  propertyType,
  courtLabel,
}: {
  data: AdjudicationPriceStatisticsResponse;
  propertyType: string | null;
  courtLabel: string | null;
}) {
  const local = data.tribunal?.propertyTypes?.find((item) => item.propertyType === propertyType);
  const national = data.national.propertyTypes?.find((item) => item.propertyType === propertyType);
  const selected = local ?? national;
  const scope = local ? data.tribunal! : data.national;
  if (!selected)
    return (
      <p
        role="status"
        className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700"
      >
        Aucun échantillon publiable pour{" "}
        {propertyType
          ? propertyTypeLabel(propertyType).toLocaleLowerCase("fr-FR")
          : "ce type de bien"}
        . Le détail tous biens confondus reste consultable ci-dessous ; il ne permet pas d’estimer
        cette annonce.
      </p>
    );
  const { distribution } = selected;
  const aboveCount = distribution.bidDistribution
    .filter((bin) => !["below_starting", "at_starting"].includes(bin.band))
    .reduce((sum, bin) => sum + bin.count, 0);
  return (
    <section
      aria-label="Historique du même type de bien"
      className="rounded-lg border border-slate-200 p-5"
    >
      <h4 className="font-semibold text-brand-navy">
        {propertyTypeLabel(selected.propertyType)} · {local ? scope.label : "Échantillon national"}
      </h4>
      <p className="mt-2 text-sm text-slate-600">
        {distribution.sampleSize.toLocaleString("fr-FR")} résultats ·{" "}
        {formatDate(scope.periodStart)} → {formatDate(scope.periodEnd)} · Source : Licitor
      </p>
      {!local ? (
        <p className="mt-2 text-sm text-slate-600">
          Aucun échantillon publié pour ce type à {courtLabel ?? "ce tribunal"}. Les données
          nationales sont présentées.
        </p>
      ) : null}
      <LimitedAdjudicationSample sampleSize={distribution.sampleSize} />
      <dl className="mt-4 grid rounded-lg border border-slate-200 sm:grid-cols-3">
        <HistoryMetric
          label="Prix adjugés · 50 % centraux"
          value={`${formatCurrencyValue(distribution.hammerPriceMiddle50Eur.p25)} – ${formatCurrencyValue(distribution.hammerPriceMiddle50Eur.p75)}`}
          detail="Fourchette historique ; surfaces et états différents"
        />
        <HistoryMetric
          label="Multiplicateurs · 50 % centraux"
          value={`× ${distribution.ratioMiddle50.p25.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} – × ${distribution.ratioMiddle50.p75.toLocaleString("fr-FR", { maximumFractionDigits: 2 })}`}
          detail="Prix adjugé / mise à prix ; aucune prévision individuelle"
        />
        <HistoryMetric
          label="Au-dessus de la mise · même type"
          value={formatPercent(aboveCount / distribution.sampleSize)}
          detail={`${aboveCount.toLocaleString("fr-FR")} sur ${distribution.sampleSize.toLocaleString("fr-FR")} résultats`}
        />
      </dl>
    </section>
  );
}

function LimitedAdjudicationSample({ sampleSize }: { sampleSize: number }) {
  if (adjudicationPriceStatisticsReliability(sampleSize) !== "limited") return null;
  return (
    <p className="mt-3 rounded-md bg-amber-50 p-3 text-sm text-amber-950">
      Échantillon limité : moins de 30 résultats. Quelques ventes peuvent fortement modifier les
      pourcentages et les fourchettes. Ces repères ne permettent pas de prévoir votre adjudication.
    </p>
  );
}

function AdjudicationPriceScope({
  heading,
  scope,
}: {
  heading: string;
  scope: AdjudicationPriceStatisticsScope;
}) {
  return (
    <section aria-label={`Résultats d’adjudication · ${heading}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-brand-navy/70">
            {scope.scopeType === "national" ? "Niveau 1 · France" : "Niveau 2 · Tribunal"}
          </p>
          <h4 className="mt-1 font-display text-xl font-semibold text-brand-navy">{heading}</h4>
        </div>
        <span className="rounded-md border border-brand-navy/12 bg-[#f8fbfe] px-3 py-2 text-xs font-semibold text-brand-navy/65">
          {scope.sampleSize.toLocaleString("fr-FR")} adjudications · {reliabilityLabel(scope)}
        </span>
      </div>
      <LimitedAdjudicationSample sampleSize={scope.sampleSize} />
      <dl className="mt-4 grid overflow-hidden rounded-lg border border-brand-navy/12 bg-[#f8fbfe] sm:grid-cols-2 xl:grid-cols-5">
        <HistoryMetric
          label="Multiplicateur médian"
          value={`× ${scope.metrics.medianHammerToStartingRatio.toLocaleString("fr-FR", { maximumFractionDigits: 2 })}`}
          detail="Prix adjugé / mise à prix"
          accent
        />
        <HistoryMetric
          label="Au-dessus de la mise"
          value={formatPercent(scope.metrics.aboveStartingRate)}
          detail="Prix adjugé strictement supérieur"
        />
        <HistoryMetric
          label="Au moins doublé"
          value={formatPercent(scope.metrics.atLeastDoubleRate)}
          detail="Prix adjugé ≥ 2 × mise"
        />
        <HistoryMetric
          label="Prix adjugé médian"
          value={formatCurrencyValue(scope.metrics.medianHammerPriceEur)}
          detail={`${formatDate(scope.periodStart)} → ${formatDate(scope.periodEnd)}`}
        />
        <HistoryMetric
          label="Mise à prix médiane"
          value={formatCurrencyValue(scope.metrics.medianStartingPriceEur)}
          detail="Mises supérieures à 1 000 €"
        />
      </dl>
      {scope.distribution ? (
        <div className="mt-5 grid gap-6 lg:grid-cols-2">
          <div>
            <h5 className="font-semibold text-brand-navy">Où se situent les résultats ?</h5>
            <p className="mt-2 text-sm text-brand-navy/70">
              Les 50 % centraux des prix adjugés se situent entre{" "}
              {formatCurrencyValue(scope.distribution.hammerPriceMiddle50Eur.p25)} et{" "}
              {formatCurrencyValue(scope.distribution.hammerPriceMiddle50Eur.p75)}.
            </p>
            <p className="mt-2 text-sm text-brand-navy/70">
              La moitié centrale des multiplicateurs va de ×{" "}
              {scope.distribution.ratioMiddle50.p25.toLocaleString("fr-FR", {
                maximumFractionDigits: 2,
              })}
              {" à × "}
              {scope.distribution.ratioMiddle50.p75.toLocaleString("fr-FR", {
                maximumFractionDigits: 2,
              })}
              .
            </p>
            <p className="mt-2 text-xs text-brand-navy/70">
              Fourchettes historiques, tous biens confondus.
            </p>
          </div>
          <div>
            <h5 className="font-semibold text-brand-navy">
              Répartition des prix par rapport à la mise
            </h5>
            <dl className="mt-3 space-y-3">
              {bidBands.map((band) => {
                const bin = scope.distribution!.bidDistribution.find((item) => item.band === band)!;
                return (
                  <div key={band}>
                    <div className="flex justify-between gap-3 text-sm">
                      <dt>{bidBandLabels[band]}</dt>
                      <dd>{formatPercent(bin.share)}</dd>
                    </div>
                    <div aria-hidden className="mt-1 h-2 overflow-hidden rounded bg-slate-100">
                      <div
                        className="h-full bg-gold-soft"
                        style={{ width: `${bin.share * 100}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </dl>
          </div>
        </div>
      ) : null}
      {scope.propertyTypes?.length ? (
        <div className="mt-6">
          <h5 className="font-semibold text-brand-navy">Repères par type de bien</h5>
          <p className="mt-1 text-xs text-brand-navy/60">
            Types comptant au moins 10 résultats. Les fourchettes couvrent les 50 % centraux, sans
            constituer une estimation du bien.
          </p>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            {scope.propertyTypes.map(({ propertyType, distribution }) => (
              <div key={propertyType} className="rounded-lg border border-slate-200 p-3">
                <dt className="text-sm font-semibold">{propertyTypeLabel(propertyType)}</dt>
                <dd className="mt-1 text-sm text-brand-navy/70">
                  <p>{distribution.sampleSize.toLocaleString("fr-FR")} résultats</p>
                  <LimitedAdjudicationSample sampleSize={distribution.sampleSize} />
                  <p>
                    Prix adjugés : {formatCurrencyValue(distribution.hammerPriceMiddle50Eur.p25)} –{" "}
                    {formatCurrencyValue(distribution.hammerPriceMiddle50Eur.p75)}
                  </p>
                  <p>
                    Multiplicateur : ×{" "}
                    {distribution.ratioMiddle50.p25.toLocaleString("fr-FR", {
                      maximumFractionDigits: 2,
                    })}{" "}
                    – ×{" "}
                    {distribution.ratioMiddle50.p75.toLocaleString("fr-FR", {
                      maximumFractionDigits: 2,
                    })}
                  </p>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </section>
  );
}

function reliabilityLabel(scope: AdjudicationPriceStatisticsScope): string {
  if (scope.reliability === "extended") return "échantillon étendu";
  if (scope.reliability === "descriptive") return "échantillon descriptif";
  return "échantillon limité";
}

function ScopeHeading({ level, title }: { level: string; title: string }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gold-soft">{level}</p>
        <h3 className="mt-2 font-display text-2xl font-semibold text-brand-navy sm:text-3xl">
          {title}
        </h3>
      </div>
    </div>
  );
}

function NationalActivity({ data }: { data: TribunalJudicialActivityDirectoryResponse }) {
  const { national, period } = data;
  return (
    <>
      <dl className="mt-6 grid overflow-hidden rounded-lg border border-brand-navy/12 bg-[#f8fbfe] sm:grid-cols-2 lg:grid-cols-4">
        <HistoryMetric
          label="Mise à prix médiane · France"
          value={formatRangeMedianCurrency(national.startingPriceRangeEur)}
          detail={formatRangeCurrency(national.startingPriceRangeEur, "tous biens confondus")}
          accent
        />
        <HistoryMetric
          label="Détection → vente · France"
          value={formatRangeMedianDays(national.discoveryLeadRangeDays)}
          detail={formatRangeDays(national.discoveryLeadRangeDays)}
        />
        <HistoryMetric
          label="Ventes passées observées"
          value={formatNumberValue(national.observedPastSales)}
          detail={`${formatNumberValue(national.upcomingSales)} ventes à venir suivies`}
        />
        <HistoryMetric
          label="Visite annoncée · France"
          value={formatPercentMetric(national.visitCoverage)}
          detail={sampleLabel(national.visitCoverage, "annonce")}
        />
      </dl>

      <p className="mt-3 text-xs leading-relaxed text-brand-navy/70">
        Historique observé depuis le {formatDate(period.historyStart)} ·{" "}
        {national.coverage.trackedCourts}{" "}
        {national.coverage.trackedCourts > 1 ? "tribunaux suivis" : "tribunal suivi"}.
      </p>
    </>
  );
}

function JudicialActivity({
  activity,
  sale,
}: {
  activity: TribunalJudicialActivityResponse;
  sale: AuctionSale;
}) {
  const { court, period, reliability } = activity;
  const metrics = activity.activity;
  const dominantPropertyType = metrics.topPropertyTypes[0];
  const propertyBenchmark = sale.property_type
    ? metrics.propertyTypeBenchmarks.find(
        (benchmark) => benchmark.propertyType === sale.property_type,
      )
    : null;
  const priceRange = publishedRangeOrFallback(
    propertyBenchmark?.startingPriceRangeEur,
    metrics.startingPriceRangeEur,
  );
  const leadRange = publishedRangeOrFallback(
    propertyBenchmark?.discoveryLeadRangeDays,
    metrics.discoveryLeadRangeDays,
  );
  const benchmarkScope =
    propertyBenchmark && priceRange === propertyBenchmark.startingPriceRangeEur
      ? propertyTypeLabel(propertyBenchmark.propertyType).toLocaleLowerCase("fr-FR")
      : "tous biens confondus";
  const priceComparison =
    propertyBenchmark && priceRange === propertyBenchmark.startingPriceRangeEur
      ? startingPriceComparison(sale.starting_price_eur, priceRange, benchmarkScope)
      : null;

  return (
    <>
      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="max-w-3xl text-sm leading-relaxed text-brand-navy/62">
          Activité des annonces rattachées exactement à {court.name}
          {court.judicialRegion ? `, ressort de ${court.judicialRegion}` : ""}. Les rattachements
          incertains et les annonces en conflit sont exclus.
        </p>
        <ReliabilityBadge level={reliability.level} label={reliability.label} />
      </div>

      {priceComparison ? (
        <div className="mt-6 border-l-4 border-gold-soft bg-[#fffaf2] px-4 py-4">
          <p className="text-sm font-semibold text-brand-navy">{priceComparison}</p>
          <p className="mt-1 text-xs leading-relaxed text-brand-navy/70">
            Positionnement de la mise initiale uniquement : ce repère n’est ni une estimation de
            valeur, ni un conseil ou plafond d’enchère.
          </p>
        </div>
      ) : null}

      <dl className="mt-6 grid overflow-hidden rounded-lg border border-brand-navy/12 bg-[#f8fbfe] sm:grid-cols-2 lg:grid-cols-4">
        <HistoryMetric
          label="Ventes à venir suivies"
          value={formatNumberValue(metrics.upcomingSales)}
          detail={`${formatNumberValue(metrics.upcomingSales90Days)} dans les 90 prochains jours`}
        />
        <HistoryMetric
          label="Mise à prix médiane · Tribunal"
          value={formatRangeMedianCurrency(priceRange)}
          detail={formatRangeCurrency(priceRange, benchmarkScope)}
          accent
        />
        <HistoryMetric
          label="Détection → vente · Tribunal"
          value={formatRangeMedianDays(leadRange)}
          detail={formatRangeDays(leadRange)}
        />
        <HistoryMetric
          label="Visite annoncée · Tribunal"
          value={formatPercentMetric(metrics.visitCoverage)}
          detail={sampleLabel(metrics.visitCoverage, "annonce")}
        />
      </dl>

      <dl className="mt-7 grid gap-4 border-y border-brand-navy/10 py-5 sm:grid-cols-2 xl:grid-cols-5">
        <ActivityFact
          icon={CalendarDays}
          label="Prochaine audience suivie"
          value={formatDate(metrics.nextSaleAt)}
        />
        <ActivityFact
          icon={BarChart3}
          label="Jours d’audience à venir"
          value={formatNumberValue(metrics.upcomingHearingDays)}
        />
        <ActivityFact
          icon={Landmark}
          label="Lots médians par jour d’audience"
          value={formatNumberMetric(metrics.medianLotsPerHearingDay)}
        />
        <ActivityFact
          icon={CalendarDays}
          label="Intervalle médian entre audiences"
          value={formatCadenceMetric(metrics.medianDaysBetweenHearingDays)}
        />
        <ActivityFact
          icon={ShieldCheck}
          label="Type de bien le plus suivi"
          value={
            dominantPropertyType
              ? `${propertyTypeLabel(dominantPropertyType.propertyType)} · ${formatPercent(dominantPropertyType.share)}`
              : "Non publié"
          }
        />
      </dl>

      <p className="mt-4 text-xs leading-relaxed text-brand-navy/70">
        {metrics.observedPastSales} vente{metrics.observedPastSales > 1 ? "s" : ""} passée
        {metrics.observedPastSales > 1 ? "s" : ""} suivie
        {metrics.observedPastSales > 1 ? "s" : ""} depuis le {formatDate(period.historyStart)}.
      </p>
    </>
  );
}

function HistoryMetric({
  label,
  value,
  detail,
  accent = false,
}: {
  label: string;
  value: string;
  detail: string;
  accent?: boolean;
}) {
  return (
    <div className="border-b border-brand-navy/10 p-5 last:border-b-0 sm:[&:nth-last-child(-n+2)]:border-b-0 lg:border-b-0 lg:border-r lg:last:border-r-0">
      <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-brand-navy/70">
        {label}
      </dt>
      <dd
        className={`mt-3 font-display text-3xl font-semibold tabular-nums ${accent ? "text-gold-soft" : "text-brand-navy"}`}
      >
        {value}
      </dd>
      <dd className="mt-2 text-xs text-brand-navy/70">{detail}</dd>
    </div>
  );
}

function ActivityFact({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Landmark;
  label: string;
  value: string;
}) {
  return (
    <div className="flex gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-gold-soft" aria-hidden />
      <div>
        <dt className="text-xs text-brand-navy/70">{label}</dt>
        <dd className="mt-1 text-sm font-semibold text-brand-navy">{value}</dd>
      </div>
    </div>
  );
}

function ReliabilityBadge({ level, label }: { level: string; label: string }) {
  const classes =
    level === "strong"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
      : level === "descriptive"
        ? "border-sky-200 bg-sky-50 text-sky-900"
        : "border-amber-200 bg-amber-50 text-amber-950";
  return (
    <span
      className={`inline-flex w-fit items-center gap-2 rounded-md border px-3 py-2 text-xs font-semibold ${classes}`}
    >
      <ShieldCheck className="h-4 w-4" aria-hidden />
      {label}
    </span>
  );
}

function InsufficientTribunalData({ activity }: { activity: TribunalJudicialActivityResponse }) {
  return (
    <div className="mt-5 flex gap-3 border-y border-amber-200 bg-amber-50 px-4 py-5 text-amber-950">
      <CircleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      <div>
        <p className="font-semibold">Profil local en cours de consolidation</p>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed">
          Les statistiques de {activity.court.name} seront affichées ici lorsque au moins{" "}
          {TRIBUNAL_JUDICIAL_ACTIVITY_MIN_SAMPLE} mises à prix et{" "}
          {TRIBUNAL_JUDICIAL_ACTIVITY_MIN_SAMPLE} délais de découverte contrôlés seront disponibles.
          Les repères France peuvent servir de comparaison uniquement lorsqu’ils sont publiés ; leur
          absence ne permet aucune conclusion sur ce tribunal.
        </p>
      </div>
    </div>
  );
}

function ScopeUnavailable({
  title,
  detail,
  onRetry,
  retrying = false,
}: {
  title: string;
  detail: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div className="mt-5 flex gap-4 border-y border-brand-navy/10 bg-[#f8fbfe] px-4 py-5">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-gold/10 text-gold-soft">
        <BarChart3 className="h-5 w-5" aria-hidden />
      </span>
      <div>
        <p className="font-semibold text-brand-navy">{title}</p>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-brand-navy/62">{detail}</p>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            aria-label={`Réessayer : ${title}`}
            className="mt-3 min-h-11 rounded-md border border-brand-navy/20 px-4 text-sm font-semibold text-brand-navy disabled:opacity-60"
          >
            {retrying ? "Chargement…" : "Réessayer"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ScopeSkeleton() {
  return (
    <div
      className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      aria-label="Chargement des statistiques"
      role="status"
    >
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-28 bg-brand-navy/5" />
      ))}
    </div>
  );
}

function isTribunalProfilePublishable(activity: TribunalJudicialActivityResponse): boolean {
  return (
    activity.activity.startingPriceRangeEur.status === "published" &&
    activity.activity.discoveryLeadRangeDays.status === "published"
  );
}

function sampleLabel(metric: TribunalJudicialActivityMetric, noun: string): string {
  const count = metric.sampleSize;
  return `${count} ${noun}${count > 1 ? "s" : ""} retenue${count > 1 ? "s" : ""}`;
}

function formatPercentMetric(metric: TribunalJudicialActivityMetric): string {
  return metric.status === "published" ? formatPercent(metric.value) : "Non publié";
}

function formatNumberMetric(metric: TribunalJudicialActivityMetric): string {
  if (metric.status !== "published") return "Non publié";
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(metric.value);
}

function formatCadenceMetric(metric: TribunalJudicialActivityMetric): string {
  if (metric.status !== "published") return "Non publié";
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(metric.value)} jours`;
}

function publishedRangeOrFallback(
  candidate: TribunalJudicialActivityRangeMetric | undefined,
  fallback: TribunalJudicialActivityRangeMetric,
): TribunalJudicialActivityRangeMetric {
  return candidate?.status === "published" ? candidate : fallback;
}

function formatRangeMedianCurrency(metric: TribunalJudicialActivityRangeMetric): string {
  if (metric.status !== "published") return "Non publié";
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(metric.p50);
}

function formatRangeCurrency(metric: TribunalJudicialActivityRangeMetric, scope: string): string {
  if (metric.status !== "published") return `${metric.sampleSize} annonces retenues`;
  return `50 % entre ${formatCurrencyValue(metric.p25)} et ${formatCurrencyValue(metric.p75)} · ${scope}`;
}

function formatRangeMedianDays(metric: TribunalJudicialActivityRangeMetric): string {
  if (metric.status !== "published") return "Non publié";
  return `${formatNumberValue(metric.p50)} jours`;
}

function formatRangeDays(metric: TribunalJudicialActivityRangeMetric): string {
  if (metric.status !== "published") return `${metric.sampleSize} délais retenus`;
  return `50 % entre ${formatNumberValue(metric.p25)} et ${formatNumberValue(metric.p75)} jours`;
}

function startingPriceComparison(
  startingPriceEur: number | null,
  metric: TribunalJudicialActivityRangeMetric,
  scope: string,
): string | null {
  if (startingPriceEur == null || startingPriceEur <= 0 || metric.status !== "published") {
    return null;
  }
  const difference = (startingPriceEur / metric.p50 - 1) * 100;
  const formattedPrice = formatCurrencyValue(startingPriceEur);
  const medianLabel =
    scope === "France entière" ? "la médiane nationale" : `la médiane du tribunal (${scope})`;
  if (Math.abs(difference) < 1) {
    return `Cette mise à prix de ${formattedPrice} est proche de ${medianLabel}.`;
  }
  return `Cette mise à prix de ${formattedPrice} se situe ${formatNumberValue(Math.abs(difference))} % ${difference < 0 ? "sous" : "au-dessus de"} ${medianLabel}.`;
}

function formatCurrencyValue(value: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatNumberValue(value: number): string {
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(value);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(value: string | null): string {
  if (!value) return "Aucune date publiée";
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "long",
    timeZone: "Europe/Paris",
  }).format(new Date(value));
}

function propertyTypeLabel(value: string): string {
  return (
    {
      apartment: "Appartement",
      house: "Maison",
      commercial: "Local commercial",
      building: "Immeuble",
      land: "Terrain",
      parking: "Stationnement",
      mixed: "Bien mixte",
      other: "Autre",
    }[value] ?? value
  );
}
