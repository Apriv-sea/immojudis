"use client";

import { useEffect, useRef, useState } from "react";
import type { PropsWithChildren } from "react";
import { cn } from "@/lib/utils";
import entryMotion from "@/components/ui/entry-motion.module.css";

type AnimatedSectionProps = PropsWithChildren<{
  id: string;
  className?: string;
  "aria-labelledby"?: string;
}>;

export function AnimatedSection({
  id,
  className,
  children,
  "aria-labelledby": ariaLabelledBy,
}: AnimatedSectionProps) {
  const sectionRef = useRef<HTMLElement>(null);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setEntered(true);
          observer.disconnect();
        }
      },
      { threshold: 0.18 },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={sectionRef}
      id={id}
      aria-labelledby={ariaLabelledBy}
      className={cn(
        "scroll-mt-28 [--entry-distance:18px] [--entry-duration:380ms]",
        entered && entryMotion.riseIn,
        className,
      )}
    >
      {children}
    </section>
  );
}
