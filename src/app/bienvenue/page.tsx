import type { Metadata } from "next";
import { AuthGate } from "@/components/AuthGate";
import { InvestorOnboarding } from "@/components/InvestorOnboarding";

export const metadata: Metadata = {
  title: "Votre première recherche",
  description: "Préparer votre première recherche de vente immobilière avec Immojudis.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <AuthGate>
      <InvestorOnboarding />
    </AuthGate>
  );
}
