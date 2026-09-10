// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnimatedSection } from "./AnimatedSection";
import entryMotion from "@/components/ui/entry-motion.module.css";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AnimatedSection", () => {
  it("keeps the content and accessible name visible without an observer", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    render(
      <AnimatedSection id="details" aria-labelledby="details-title">
        <h2 id="details-title">Détails du bien</h2>
      </AnimatedSection>,
    );
    const section = screen.getByRole("region", { name: "Détails du bien" });
    expect(section.style.opacity).toBe("");
    expect(section.className).not.toContain(entryMotion.riseIn);
  });

  it("starts a single CSS entrance on intersection and disconnects on unmount", () => {
    let notify: IntersectionObserverCallback = () => {};
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          notify = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    const view = render(<AnimatedSection id="details">Contenu</AnimatedSection>);
    const section = screen.getByText("Contenu");
    expect(observe).toHaveBeenCalledWith(section);
    act(() =>
      notify(
        [{ isIntersecting: false }] as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      ),
    );
    expect(section.className).not.toContain(entryMotion.riseIn);
    act(() =>
      notify([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver),
    );
    expect(section.className).toContain(entryMotion.riseIn);
    expect(disconnect).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });
});
