import type { Metadata } from "next";
import { HomePage } from "@/routes/index";

export const metadata: Metadata = {
  title: "Immojudis - Les enchères immobilières en toute clarté",
  description:
    "Ventes au tribunal, notariales et domaniales référencées : distinguez les procédures, trouvez une annonce et préparez votre achat immobilier.",
  alternates: { canonical: "/" },
};

export default function Page() {
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "ImmoJudis",
    url: "/",
    potentialAction: {
      "@type": "SearchAction",
      target: "/sales?q={search_term_string}",
      "query-input": "required name=search_term_string",
    },
  };
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
        }}
      />
      <HomePage />
    </>
  );
}
