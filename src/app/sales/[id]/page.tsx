import type { Metadata } from "next";
import { Suspense } from "react";
import { formatPrice } from "@/lib/format";
import { getSaleById, getSalePreviewById } from "@/lib/queries";
import { getSaleProcedure, saleVenueLabel } from "@/lib/sale-procedure";
import { saleSeoTitle } from "@/lib/seo";
import { resolveSiteOrigin } from "@/lib/site-url";
import { SaleDetailPage } from "@/routes/sales.$id";

type PageProps = {
  params: Promise<{ id: string }>;
};

async function loadSaleDetail(id: string) {
  const sale = await getSaleById(id);
  if (sale) return { sale, preview: null };
  return { sale: null, preview: await getSalePreviewById(id) };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const data = await loadSaleDetail(id);
  const visibleSale = data.sale ?? data.preview ?? null;
  const title = saleSeoTitle(visibleSale);
  const venueLabel = visibleSale
    ? saleVenueLabel(getSaleProcedure(visibleSale).venueType).toLocaleLowerCase("fr-FR")
    : "vente aux enchères immobilière";

  return {
    title,
    description:
      visibleSale?.starting_price_eur != null
        ? `${venueLabel} Immojudis avec mise à prix ${formatPrice(
            visibleSale.starting_price_eur,
          )}. Consultez l’organisation et les règles de participation vérifiées.`
        : `Immojudis : ${venueLabel}, organisation et règles de participation vérifiées.`,
    openGraph: {
      title,
      description:
        visibleSale?.city != null
          ? `${venueLabel} à ${visibleSale.city}.`
          : `${venueLabel} Immojudis.`,
      type: "article",
    },
    alternates: {
      canonical: `/sales/${id}`,
    },
  };
}

export default async function Page({ params }: PageProps) {
  const { id } = await params;
  const data = await loadSaleDetail(id);
  const visibleSale = data.sale ?? data.preview;
  const siteOrigin = resolveSiteOrigin(process.env, "http://localhost:3000")!;
  const structuredData = visibleSale
    ? {
        "@context": "https://schema.org",
        "@type": "RealEstateListing",
        name: saleSeoTitle(visibleSale),
        url: `${siteOrigin}/sales/${id}`,
        address: {
          "@type": "PostalAddress",
          addressLocality: visibleSale.city ?? undefined,
          postalCode: visibleSale.postal_code ?? undefined,
          addressCountry: "FR",
        },
        offers:
          visibleSale.starting_price_eur == null
            ? undefined
            : {
                "@type": "Offer",
                price: visibleSale.starting_price_eur,
                priceCurrency: "EUR",
                availability: "https://schema.org/LimitedAvailability",
              },
      }
    : null;

  return (
    <>
      {structuredData ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
          }}
        />
      ) : null}
      <Suspense fallback={<SaleDetailFallback sale={visibleSale} />}>
        <SaleDetailPage
          id={id}
          initialData={data}
          adjudicationStatisticsEnabled={
            process.env.ADJUDICATION_PRICE_STATISTICS_ENABLED === "true"
          }
        />
      </Suspense>
    </>
  );
}

function SaleDetailFallback({
  sale,
}: {
  sale: Awaited<ReturnType<typeof loadSaleDetail>>["preview"];
}) {
  return (
    <main className="min-h-screen bg-[#f7f5f3] px-4 py-10 text-foreground sm:px-6">
      <section className="mx-auto max-w-3xl rounded-lg border border-border bg-white p-6 shadow-sm sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-soft">
          {sale ? saleVenueLabel(getSaleProcedure(sale).venueType) : "Vente aux enchères"}
        </p>
        <h1 className="mt-3 font-display text-3xl leading-tight sm:text-4xl">
          {saleSeoTitle(sale)}
        </h1>
        <dl className="mt-6 grid gap-4 rounded-md border border-border bg-muted/30 p-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Mise à prix
            </dt>
            <dd className="mt-1 text-xl font-semibold">
              {sale?.starting_price_eur == null
                ? "À consulter"
                : formatPrice(sale.starting_price_eur)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Localisation
            </dt>
            <dd className="mt-1 font-medium">{sale?.city ?? "Localisation à confirmer"}</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
