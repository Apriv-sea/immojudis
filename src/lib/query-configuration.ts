import { isSupabaseConfigured } from "@/integrations/supabase/client";

const CONFIGURATION_ERROR =
  "La configuration Supabase est absente. Ajoutez les variables d'environnement Supabase pour afficher les données.";

export function assertCloudConfigured() {
  if (isSupabaseConfigured) return true;
  // On the SSR worker the env may not be hydrated yet — return false so
  // callers can short-circuit with empty results and let the browser
  // refetch once the user session and env are available.
  if (typeof window === "undefined") return false;
  throw new Error(CONFIGURATION_ERROR);
}
