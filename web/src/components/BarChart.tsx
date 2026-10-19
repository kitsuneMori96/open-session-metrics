/**
 * Column chart with a counted baseline, standing in for the TUI's block-glyph
 * BarChart. `labels` are already thinned by the server (trend buckets) or hand-picked
 * (the 24-hour axis), and each label sits in its own bucket column, so the axis lines
 * up with the bars.
 */
export default function BarChart({
  values,
  labels,
  color = "var(--color-ink)",
  height = 44,
  unit = "",
}: {
  values: number[];
  labels?: string[];
  color?: string;
  height?: number;
  unit?: string;
}) {
  const max = Math.max(...values, 0);
  return (
    <div className="w-full">
      <div className="hairline-b relative w-full" style={{ height }}>
        <div className="absolute inset-0 flex items-end gap-px">
          {values.map((v, i) => {
            const label = labels?.[i] ?? String(i);
            return (
              <div key={i} className="relative flex-1" style={{ height: "100%" }} title={`${label}: ${v}${unit}`}>
                <i
                  className="absolute bottom-0 left-0 right-0 block"
                  style={{
                    height: max > 0 ? `${(v / max) * 100}%` : 0,
                    minHeight: v > 0 ? 2 : 0,
                    background: v > 0 ? color : undefined,
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
      {labels && (
        <div className="flex gap-px">
          {labels.map((l, i) => (
            <span key={i} className="tape flex-1 overflow-hidden whitespace-nowrap text-ink-faint">
              {l}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
