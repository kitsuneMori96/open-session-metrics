import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Digit wheels for values that change under you.
 *
 * A number that jumps from 803.1M to 812.4M reads as a different number; the same number
 * rolling over reads as the same quantity moving. Only digits roll — the sign, the decimal
 * point, the separators and the unit stay put, so the eye keeps its anchor while the
 * magnitude changes underneath.
 */

const ROLL_MS = 190;
const DIGIT = /^[0-9]$/;

const reduceMotion = (): boolean =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The short way round the wheel: 9 → 0 rolls forward, through the carry. */
const rollsUp = (from: string, to: string): boolean => (Number(to) - Number(from) + 10) % 10 <= 5;

function Digit({ ch }: { ch: string }) {
  const seen = useRef(ch);
  const [roll, setRoll] = useState<{ from: string; up: boolean } | null>(null);

  useLayoutEffect(() => {
    const from = seen.current;
    if (from === ch) return;
    seen.current = ch;
    if (reduceMotion()) return;
    setRoll({ from, up: rollsUp(from, ch) });
    const done = setTimeout(() => setRoll(null), ROLL_MS + 60);
    return () => clearTimeout(done);
  }, [ch]);

  return (
    <span className="roll-cell">
      {/* Holds the advance and the baseline whether or not a roll is running. */}
      <span className={roll ? "invisible" : undefined}>{ch}</span>
      {roll && (
        <>
          <span className="roll-layer" data-roll={roll.up ? "out-up" : "out-down"}>
            {roll.from}
          </span>
          <span className="roll-layer" data-roll={roll.up ? "in-up" : "in-down"}>
            {ch}
          </span>
        </>
      )}
    </span>
  );
}

export function Roll({ text }: { text: string }): ReactNode {
  return Array.from(text).map((ch, i) => (DIGIT.test(ch) ? <Digit key={i} ch={ch} /> : <span key={i}>{ch}</span>));
}
