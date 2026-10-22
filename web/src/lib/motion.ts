import { useEffect, useRef, type RefObject } from "react";

/* ------------------------------------------------------------------ *
 * The motion system's JS half.
 *
 * Only two things need code: the figure redraw (a keyed clip-path wipe that
 * must restart when the data changes, not when the element mounts) and a
 * content fingerprint to key it on. Tokens and the pointer/overlay verbs live
 * in motion.css.
 * ------------------------------------------------------------------ */

export const DUR = { fast: 90, base: 170, middle: 120, slow: 260, out: 60 } as const;
export const EASE = "cubic-bezier(0.4, 0, 0.2, 1)";
export const EASE_TRACK = "cubic-bezier(0.65, 0, 0.35, 1)";
export const STAGGER = 12;
/** Panels past this one start together: the eye should not wait for the page. */
const STAGGER_CAP = 4;

export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A cheap content fingerprint for a series, so "the data changed" can be told
 * apart from "the component rendered again".
 *
 * FNV-1a over the numbers, plus the length and any context the caller wants in
 * the key (axis choice, granularity). A collision only costs an animation — it
 * can never show the wrong figure — so a 32-bit hash is enough.
 */
export function fingerprint(values: ArrayLike<number>, extra: string | number = ""): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < values.length; i++) {
    // Numbers arrive as counts and tokens; fold both halves of the double in.
    const v = values[i] | 0;
    h = Math.imul(h ^ v, 0x01000193);
    h = Math.imul(h ^ (values[i] >>> 0), 0x01000193);
  }
  return `${values.length}:${(h >>> 0).toString(36)}:${extra}`;
}

/* Figures that redraw in the same commit are staggered by 12ms so the eye
   follows the page instead of seeing one flat flash. The batch is defined by
   time, not by a shared key, because each figure is keyed on its own data. */
let batchAt = -Infinity;
let batchN = 0;

function nextDelay(): number {
  const now = performance.now();
  if (now - batchAt > 80) batchN = 0;
  batchAt = now;
  return Math.min(batchN++, STAGGER_CAP) * STAGGER;
}

/**
 * Redraw a figure when its data key changes.
 *
 * A wipe, not a cross-fade: two half-transparent shapes make the eye read both
 * curves at once, while a clip that travels left to right keeps exactly one
 * shape on screen and matches the order the figure is read in.
 *
 * Never runs on mount, so first paint and a remount (route change, resize)
 * draw the figure outright. Polls that return the same content produce the
 * same fingerprint and therefore no motion at all.
 */
export function useWipe(ref: RefObject<HTMLElement | null>, key: unknown): void {
  const seen = useRef(key);

  useEffect(() => {
    if (key === seen.current) return;
    seen.current = key;
    const el = ref.current;
    if (!el || prefersReducedMotion() || typeof el.animate !== "function") return;
    const anim = el.animate([{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], {
      duration: DUR.slow,
      delay: nextDelay(),
      easing: EASE,
      fill: "backwards",
    });
    // A second change interrupts the first rather than queueing behind it.
    return () => anim.cancel();
  }, [key, ref]);
}
