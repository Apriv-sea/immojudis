// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { MoreFiltersModal } from "./SearchFilters";
import { emptySearchDraft } from "./search-page-state";
vi.mock("@/lib/router-compat", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));
afterEach(cleanup);

function Harness() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(emptySearchDraft);
  return (
    <>
      <button onClick={() => setOpen(true)}>Ouvrir les filtres</button>
      <MoreFiltersModal
        open={open}
        draft={draft}
        setDraft={setDraft}
        activeFiltersCount={0}
        preview
        analysisLocked
        onClose={() => setOpen(false)}
        onReset={vi.fn()}
      />
    </>
  );
}
it("closes on Escape, restores focus and disables unavailable criteria", async () => {
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "Ouvrir les filtres" });
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "Filtres avancés" })).toBeTruthy();
  expect(
    (screen.getByRole("combobox", { name: "Occupation" }) as HTMLSelectElement).closest("fieldset")
      ?.disabled,
  ).toBe(true);
  fireEvent.keyDown(screen.getByRole("button", { name: "Fermer" }), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.activeElement).toBe(trigger);
});
