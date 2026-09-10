import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import ScrollText from "lucide-react/dist/esm/icons/scroll-text.js";
import Building2 from "lucide-react/dist/esm/icons/building-2.js";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import { Link } from "@/lib/router-compat";
import { SALE_FAMILIES } from "@/lib/sale-types";

const FAMILY_ICONS = { tribunal: Landmark, notary: ScrollText, state: Building2 };

export function SaleTypesOverview({ detailed = false }: { detailed?: boolean }) {
  return (
    <div>
      <div className="grid gap-4 lg:grid-cols-3">
        {SALE_FAMILIES.map((family) => {
          const Icon = FAMILY_ICONS[family.type];
          return (
            <article
              key={family.type}
              className="flex flex-col rounded-lg border border-brand-navy/15 bg-white p-5 sm:p-6"
            >
              <Icon className="mb-4 h-6 w-6 text-gold-soft" aria-hidden />
              <h3 className="font-display text-2xl font-semibold text-brand-navy">
                {family.title}
              </h3>
              <p className="mt-1 text-xs font-semibold text-brand-navy/65">{family.subtitle}</p>
              <p className="mt-4 text-sm leading-relaxed text-brand-navy/80">
                {family.description}
              </p>
              <p className="mt-3 text-sm font-medium leading-relaxed text-brand-navy">
                {family.participation}
              </p>
              {detailed ? (
                <p className="mt-3 text-sm leading-relaxed text-brand-navy/75">{family.nextStep}</p>
              ) : null}
              <Link
                to="/sales"
                search={{ saleType: family.type }}
                className="mt-auto flex items-center gap-2 pt-5 text-sm font-semibold text-brand-navy underline underline-offset-4"
              >
                {family.linkLabel}
                <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
              </Link>
            </article>
          );
        })}
      </div>
      <p className="mt-4 text-xs leading-relaxed text-brand-navy/70">
        Immojudis rassemble les annonces de ses sources référencées, sans garantir une couverture
        exhaustive. La présence d’une catégorie ne signifie pas qu’une vente y est disponible
        aujourd’hui. Sur place ou en ligne : les modalités de participation sont précisées pour
        chaque dossier.
      </p>
    </div>
  );
}
