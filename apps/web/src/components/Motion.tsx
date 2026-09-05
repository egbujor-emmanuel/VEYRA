// Two small motion primitives, written here rather than pulled in.
//
// The obvious move was Magic UI (MIT, installs through the shadcn registry this app already uses)
// and it would have been a reasonable one. But the only two effects worth having on this site are
// a scroll reveal and a counting number, and both are a few lines of IntersectionObserver and
// requestAnimationFrame. Magic UI brings Motion with it, which is a real runtime dependency on a
// bundle already over 700KB, to animate two things. Not worth it.
//
// What is deliberately absent is decoration. This site's entire claim is that its numbers are
// checkable and its failures are on the record; glowing beams and particle fields would read as
// exactly the kind of gloss that invites the question of what is being distracted from. Motion
// here does one job -- draw the eye to a figure as it arrives -- and then stops.
//
// Both primitives honour prefers-reduced-motion by rendering the final state immediately. Someone
// who has asked their OS for less movement gets a static page, not a slower animation.

import { useEffect, useRef, useState, type ReactNode } from "react";

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Fires once when the element first enters the viewport. */
function useInView<T extends HTMLElement>(): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null) as React.RefObject<T>;
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    // No element, no IntersectionObserver (older browsers, some test runners), or reduced motion:
    // show the content rather than leaving it invisible forever. Failing open matters here --
    // a broken observer must never hide the page's actual evidence.
    if (!el || typeof IntersectionObserver === "undefined" || prefersReducedMotion()) {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            observer.disconnect(); // one-shot: re-animating on every scroll past is a nuisance
          }
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.05 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, inView];
}

/**
 * Fades and lifts its children into place the first time they are scrolled to.
 *
 * `delay` staggers siblings. Keep it small -- a grid of four cards at 60ms each finishes in under
 * a quarter of a second, which reads as considered; at 300ms each it reads as slow.
 */
export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: inView ? 1 : 0,
        transform: inView ? "none" : "translateY(12px)",
        transition: `opacity 520ms cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms, transform 520ms cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Counts a number up when it scrolls into view.
 *
 * Takes the value and a formatter rather than a display string, so the figure being animated is
 * the real one -- there is no second, prettier copy of the number to drift out of sync with it.
 */
export function CountUp({
  value,
  format,
  durationMs = 900,
  className = "",
}: {
  value: number;
  format: (n: number) => string;
  durationMs?: number;
  className?: string;
}) {
  const [ref, inView] = useInView<HTMLSpanElement>();
  const [shown, setShown] = useState(prefersReducedMotion() ? value : 0);

  useEffect(() => {
    if (!inView || prefersReducedMotion()) {
      setShown(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // Ease out: fast at first, settling at the end, so the final value is readable before it lands.
      setShown(value * (1 - Math.pow(1 - t, 3)));
      if (t < 1) raf = requestAnimationFrame(tick);
      else setShown(value);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, value, durationMs]);

  return (
    <span ref={ref} className={className}>
      {format(shown)}
    </span>
  );
}
