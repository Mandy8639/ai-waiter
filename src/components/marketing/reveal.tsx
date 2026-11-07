"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Fades its children up the first time they scroll into view. Content is
 * only hidden once this has run and found it off-screen ("armed"), so
 * without JavaScript, before it loads, or for someone who asked for
 * reduced motion (the hidden state only exists inside the no-preference
 * media query in globals.css), the content is simply there.
 */
export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          el.dataset.shown = "true";
          observer.disconnect();
        } else {
          el.dataset.reveal = "armed";
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      data-reveal=""
      className={className}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}
