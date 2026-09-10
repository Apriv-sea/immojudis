import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Cormorant_Garamond, IBM_Plex_Sans } from "next/font/google";
import "./../styles.css";
import { AppProviders } from "./providers";
import { resolveSiteOrigin } from "@/lib/site-url";

const cormorantGaramond = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-cormorant-garamond",
  preload: false,
});

const ibmPlexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-ibm-plex-sans",
});

const siteOrigin = resolveSiteOrigin(process.env, "http://localhost:3000")!;

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  title: {
    default: "Immojudis - Les enchères immobilières en toute clarté",
    template: "%s - Immojudis",
  },
  description:
    "Tribunal, notaire ou État : annonces immobilières référencées, procédures expliquées et analyses pour préparer votre achat.",
  authors: [{ name: "Immojudis" }],
  icons: {
    icon: "/brand/immojudis-justice-temple.svg",
    apple: "/brand/immojudis-justice-temple.svg",
  },
  openGraph: {
    title: "Immojudis - Les enchères immobilières en toute clarté",
    description:
      "Ventes au tribunal, notariales et domaniales référencées : comprenez les règles et préparez votre achat avec Immojudis.",
    type: "website",
    url: siteOrigin,
  },
  twitter: {
    card: "summary",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={`${cormorantGaramond.variable} ${ibmPlexSans.variable}`}>
      <body>
        <AppProviders>{children}</AppProviders>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
