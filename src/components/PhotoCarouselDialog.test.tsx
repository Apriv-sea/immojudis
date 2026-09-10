// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PhotoCarouselDialog } from "./PhotoCarouselDialog";

const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  if (originalScroll)
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

const images = [
  { url: "https://example.test/1.jpg", alt: "Salon" },
  { url: "https://example.test/2.jpg", alt: "Cuisine" },
];

describe("gallery keyboard and touch", () => {
  it("wraps focus in both directions and restores the opener on unmount", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const view = render(
      <PhotoCarouselDialog images={images} initialIndex={0} onClose={() => {}} />,
    );
    const first = screen.getByRole("button", { name: "Fermer la galerie" });
    const last = screen.getByRole("button", { name: "Afficher la photo 2" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("changes photo on horizontal swipes but ignores vertical and short gestures", () => {
    render(<PhotoCarouselDialog images={images} initialIndex={0} onClose={() => {}} />);
    const swipe = (x: number, y: number) => {
      const image = screen.getByRole("img");
      fireEvent.touchStart(image, { changedTouches: [{ clientX: 200, clientY: 300 }] });
      fireEvent.touchEnd(image, { changedTouches: [{ clientX: x, clientY: y }] });
    };
    swipe(180, 305);
    expect(screen.getByRole("img").getAttribute("alt")).toBe("Salon");
    swipe(180, 450);
    expect(screen.getByRole("img").getAttribute("alt")).toBe("Salon");
    swipe(80, 305);
    expect(screen.getByRole("img").getAttribute("alt")).toBe("Cuisine");
    swipe(320, 305);
    expect(screen.getByRole("img").getAttribute("alt")).toBe("Salon");
  });
});
