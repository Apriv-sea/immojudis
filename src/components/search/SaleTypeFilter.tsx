import { Link } from "@/lib/router-compat";
import { SALE_TYPE_OPTIONS, type SaleTypeFilter as SaleTypeValue } from "@/lib/sale-types";

export function SaleTypeFilter({
  value,
  onChange,
}: {
  value: SaleTypeValue | "";
  onChange: (value: SaleTypeValue | "") => void;
}) {
  return (
    <fieldset className="min-w-0 border-0 p-0">
      <legend className="mb-2 text-xs font-semibold text-[#55626f]">Type de vente</legend>
      <div className="flex flex-wrap items-center gap-2">
        {[{ value: "" as const, label: "Toutes" }, ...SALE_TYPE_OPTIONS].map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={`min-h-9 cursor-pointer rounded-md border px-3 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e] focus-visible:ring-offset-2 ${
              value === option.value
                ? "border-[#132238] bg-[#132238] text-white"
                : "border-[#cbd5df] bg-white text-[#132238] hover:border-[#0f766e]"
            }`}
          >
            {option.label}
          </button>
        ))}
        <Link
          href="/ventes-immobilieres-judiciaires#differences"
          className="px-1 py-2 text-xs font-semibold text-[#0f766e] underline underline-offset-4"
        >
          Quelle différence ?
        </Link>
      </div>
    </fieldset>
  );
}
