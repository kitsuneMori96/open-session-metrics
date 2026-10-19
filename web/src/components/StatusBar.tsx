export default function StatusBar({ hints, info }: { hints: string; info?: string }) {
  return (
    <footer className="hairline-t flex h-6 shrink-0 items-center gap-3 bg-paper-raised/70 px-2">
      <span className="tape truncate text-ink-faint">{hints}</span>
      <div className="flex-1" />
      {info && <span className="tape shrink-0 text-flow">{info}</span>}
    </footer>
  );
}
