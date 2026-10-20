import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Digit wheels for values that change under you.
 *
 * A number that jumps from 803.1M to 812.4M reads as a different number; the same number
 * rolling over reads as the same quantity moving. Only digits roll — the sign, the decimal
 * point, the separators and the unit stay put, so the eye keeps its anchor while the
 * magnitude changes underneath.
 *
 * The two glyphs are always both painted: the old one slides out while the new one slides
 * in, and they cross-fade. Masking the cell instead and sliding a full line height looks
 * like a real drum, but a digit's ink is only ~0.73 em of that line, so mid-roll the cell
 * is left holding the bottom of one glyph and the top of the next with a blank band
 * between them — at 19px and 190ms that reads as a blink. Overlapping costs the crisp
 * mechanical edge and buys a transition that never empties the cell.
 */

const ROLL_MS = 190;
const TRAVEL = 58; // % of the cell; far enough to read as motion, short enough to stay legible
const EASE = "cubic-bezier(0.22, 0.7, 0.25, 1)";
const DIGIT = /^[0-9]$/;

const reduceMotion = (): boolean =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The short way round the wheel: 9 → 0 rolls forward, through the carry. */
const rollsUp = (from: string, to: string): boolean => (Number(to) - Number(from) + 10) % 10 <= 5;

function Digit({ ch }: { ch: string }) {
  const cell = useRef<HTMLSpanElement | null>(null);
  const seen = useRef(ch);
  const [out, setOut] = useState<{ ch: string; up: boolean } | null>(null);

  useLayoutEffect(() => {
    const from = seen.current;
    if (from === ch) return;
    seen.current = ch;
    if (reduceMotion()) return;
    setOut({ ch: from, up: rollsUp(from, ch) });
  }, [ch]);

  // Animate after the outgoing glyph exists. The Web Animations API restarts on every
  // call, so a second change mid-roll simply rolls from where the eye already is.
  useLayoutEffect(() => {
    const el = cell.current;
    if (!out || !el) return;
    const away = out.up ? -1 : 1;
    el.querySelector(".roll-out")?.animate(
      [
        { transform: "none", opacity: 1 },
        { transform: `translateY(${away * TRAVEL}%)`, opacity: 0 },
      ],
      { duration: ROLL_MS, easing: EASE }
    );
    el.querySelector(".roll-cur")?.animate(
      [
        { transform: `translateY(${-away * TRAVEL}%)`, opacity: 0 },
        { transform: "none", opacity: 1 },
      ],
      { duration: ROLL_MS, easing: EASE }
    );
    const done = setTimeout(() => setOut(null), ROLL_MS + 40);
    return () => clearTimeout(done);
  }, [out]);

  return (
    <span ref={cell} className="roll-cell">
      {/* The glyph in flow: it defines the advance and the baseline at every moment. */}
      <span className="roll-cur">{ch}</span>
      {out && (
        <span className="roll-out" aria-hidden>
          {out.ch}
        </span>
      )}
    </span>
  );
}

export function Roll({ text }: { text: string }): ReactNode {
  return Array.from(text).map((ch, i) => (DIGIT.test(ch) ? <Digit key={i} ch={ch} /> : <span key={i}>{ch}</span>));
}
