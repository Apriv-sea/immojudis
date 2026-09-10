import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import { parseDocs } from "@/lib/documents";
import { documentTypeLabel } from "@/lib/format";

export function DocumentsList({ documents }: { documents: unknown }) {
  const docs = parseDocs(documents);
  if (docs.length === 0) {
    return <p className="text-sm text-muted-foreground">Aucune pièce attachée pour le moment.</p>;
  }
  return (
    <ul className="divide-y divide-border/60 border-y border-border/60">
      {docs.map((d, i) => (
        <li key={i}>
          <a
            href={d.url}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex w-full items-center gap-4 py-4 text-sm transition-colors hover:bg-surface/40"
          >
            <FileText className="h-4 w-4 shrink-0 text-gold" />
            <span className="min-w-0 flex-1">
              <span className="block break-words font-medium text-foreground">
                {d.name ?? d.url.split("/").pop() ?? `Pièce ${i + 1}`}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                Disponible · {documentTypeLabel(d.type)}
              </span>
            </span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-gold-soft" />
          </a>
        </li>
      ))}
    </ul>
  );
}
