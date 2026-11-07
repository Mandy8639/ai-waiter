"use client";

import { useEffect, useRef, type HTMLAttributes } from "react";

/**
 * Holds the CSS animations inside it until it scrolls into view, so the
 * hero's conversation plays when someone can see it (on a phone it sits
 * below the fold). Paused only once JavaScript has run and found it
 * off-screen: without JavaScript nothing is ever paused.
 */
export function PlayWhenVisible(props: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          el.dataset.play = "true";
          observer.disconnect();
        } else {
          el.dataset.armed = "true";
        }
      },
      { threshold: 0.35 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return <div ref={ref} {...props} />;
}
