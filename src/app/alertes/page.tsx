import type { Metadata } from "next";
import { AuthGate } from "@/components/AuthGate";
import { SavedAlerts } from "@/components/SavedAlerts";
export const metadata: Metadata = { title: "Mes alertes", robots: { index: false, follow: false } };
export default function Page() {
  return (
    <AuthGate>
      <SavedAlerts />
    </AuthGate>
  );
}
