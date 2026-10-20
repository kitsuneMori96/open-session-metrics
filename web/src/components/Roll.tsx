import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Digit wheels for values that change under you.
 *
 * A number that jumps from 803.1M to 812.4M reads as a different number; the same number
 * rolling over reads as the same quantity moving. Only digits roll — the sign, the decimal
 * point, the separators and the unit stay put, so the eye keeps its anchor while the
 * magnitude changes underneath.
 *
 * The wheel is a two-glyph strip behind a band: the old glyph leaves one way, the new one
 * arrives from the other, both moving together. Two things make it read as a wheel instead
 * of a blink, and both are about the band being the glyph's *ink box* rather than its line
 * box (see `inkBox`):
 *
 * - The strip's pitch is one ink height, so the bottom edge of the departing glyph and the
 *   top edge of the arriving one meet exactly, at every frame. Pitch the strip at the line
 *   height instead and the ~0.26 em of line that a digit does not fill travels through the
 *   band as a blank stripe — visible at 19px, and it was.
 * - No element ever starts an animation from a style it does not already have at rest. The
 *   departing glyph rests in the band, the arriving one rests outside it, and the current
 *   glyph stays in flow, merely painted transparent while the strip covers it. So a frame
 *   that lands before an animation is committed still paints the correct digits, and a
 *   missed frame costs the motion rather than showing a flash of the wrong thing.
 */

const ROLL_MS = 170;
// A curve with a middle. The obvious ease-out settles 68% of the travel inside the first
// quarter of the time, which the eye reads as the digit having flicked rather than rolled.
const EASE = "cubic-bezier(0.4, 0, 0.2, 1)";
// A row of counters that all snap on the same frame reads as a flash of the whole row;
// letting the places settle left to right reads as counting.
const STAGGER_MS = 12;
const STAGGER_MAX = 5;
const DIGIT = /^[0-9]$/;

const reduceMotion = (): boolean =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The short way round the wheel: 9 → 0 rolls forward, through the carry. */
const rollsUp = (from: string, to: string): boolean => (Number(to) - Number(from) + 10) % 10 <= 5;

type Ink = { top: number; height: number };

/** Measurements depend on the font in force, which the design keeps constant per size. */
const inks = new Map<string, Ink>();

/**
 * Where a digit's ink actually sits inside its line box, in px from the cell's top, and how
 * tall it is. An inline-block of zero height with `vertical-align: baseline` puts its bottom
 * edge on the baseline; canvas metrics give the ink above and below it.
 */
function inkBox(el: HTMLElement): Ink {
  const cs = getComputedStyle(el);
  const size = parseFloat(cs.fontSize) || 19;
  // Fallbacks are the measured ratio for the value font at 19px, so a missing canvas
  // degrades to a slightly wrong band rather than to no roll.
  const rough: Ink = { top: size * 0.1053, height: size * 0.7368 };
  const key = [cs.fontStyle, cs.fontWeight, cs.fontSize, cs.lineHeight, cs.fontFamily].join("|");
  const cached = inks.get(key);
  if (cached) return cached;

  const ctx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!ctx) return rough;

  const probe = document.createElement("span");
  probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
  el.appendChild(probe);
  const baseline = probe.getBoundingClientRect().top - el.getBoundingClientRect().top;
  probe.remove();

  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const m = ctx.measureText("0");
  const ink: Ink = {
    top: baseline - m.actualBoundingBoxAscent,
    height: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent,
  };
  if (!(ink.height > 0)) return rough;
  inks.set(key, ink);
  return ink;
}

function Digit({ ch, place }: { ch: string; place: number }) {
  const cell = useRef<HTMLSpanElement | null>(null);
  const seen = useRef(ch);
  const ink = useRef<Ink | null>(null);
  const [out, setOut] = useState<{ ch: string; up: boolean } | null>(null);

  useLayoutEffect(() => {
    const from = seen.current;
    if (from === ch) return;
    seen.current = ch;
    if (reduceMotion()) return;
    const el = cell.current;
    if (el) {
      const box = inkBox(el);
      ink.current = box;
      el.style.setProperty("--ink-top", `${box.top}px`);
      el.style.setProperty("--ink-h", `${box.height}px`);
    }
    setOut({ ch: from, up: rollsUp(from, ch) });
  }, [ch]);

  // Animate after the strip exists. The Web Animations API restarts on every call, so a
  // second change mid-roll simply rolls on from where the eye already is.
  useLayoutEffect(() => {
    const el = cell.current;
    const box = ink.current;
    if (!out || !el || !box) return;
    const away = out.up ? -1 : 1; // the old glyph leaves upward when the wheel rolls forward
    const travel = box.height;
    const delay = Math.min(place, STAGGER_MAX) * STAGGER_MS;
    const old = el.querySelector<HTMLElement>(".roll-old > span");
    const next = el.querySelector<HTMLElement>(".roll-new > span");
    const opts = { duration: ROLL_MS, easing: EASE, delay, fill: "both" } as const;
    if (next) next.style.transform = `translateY(${-away * travel}px)`;
    old?.animate([{ transform: "none" }, { transform: `translateY(${away * travel}px)` }], opts);
    next?.animate([{ transform: `translateY(${-away * travel}px)` }, { transform: "none" }], opts);
    const done = setTimeout(() => setOut(null), ROLL_MS + delay + 40);
    return () => clearTimeout(done);
  }, [out, place]);

  return (
    <span ref={cell} className={out ? "roll-cell is-rolling" : "roll-cell"}>
      {/* In flow, so it keeps spacing the number and stays in the accessibility tree. */}
      <span className="roll-now">{ch}</span>
      {out && (
        <>
          <span className="roll-band roll-old" aria-hidden>
            <span>{out.ch}</span>
          </span>
          <span className="roll-band roll-new" aria-hidden>
            <span>{ch}</span>
          </span>
        </>
      )}
    </span>
  );
}

export function Roll({ text }: { text: string }): ReactNode {
  return Array.from(text).map((ch, i) =>
    DIGIT.test(ch) ? <Digit key={i} ch={ch} place={i} /> : <span key={i}>{ch}</span>
  );
}
