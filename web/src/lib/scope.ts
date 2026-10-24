import { createContext, useContext } from "react";
import { BASE } from "./base";

/**
 * The source scope.
 *
 * Which tool's sessions you are looking at is the highest decision the panel
 * makes: it sits above the route, above the window and above every facet, so it
 * is chosen once and then forgotten. That is also why it is *not* in the URL —
 * a link to `/overview?src=qoder` would be a link into someone else's store, and
 * every `href` would have to carry it. It lives in `localStorage` instead, and
 * travels to the server in a request header.
 *
 * What is per source: the slice. Each store keeps its own window and filters, so
 * switching back restores what you were looking at rather than resetting to 24h.
 */
export type SourceKind = "opencode" | "qoder";

export const SOURCE_KINDS: readonly SourceKind[] = ["opencode", "qoder"];

export const isSourceKind = (v: string | null | undefined): v is SourceKind =>
  v === "opencode" || v === "qoder";

export interface SourceCounts {
  sessions: number;
  turns: number;
  tools: number;
}

export interface SourceView {
  kind: SourceKind;
  label: string;
  /** The tool that owns this data exists on this machine. */
  available: boolean;
  /** The store has been built at least once. */
  ready: boolean;
  /** Raw data the store is built from, e.g. `~/.qoder/projects`. */
  path: string;
  /** The materialized database. */
  store: string;
  /** `credit` for Qoder, `usd` for OpenCode — a property of the store, not of a row. */
  unit: "usd" | "credit" | null;
  sourceSchema: string | null;
  materializedAt: number;
  counts: SourceCounts | null;
}

export interface SourceList {
  default: SourceKind;
  sources: SourceView[];
}

const SOURCE_KEY = "osm.source";
const SLICE_KEY = "osm.slice";

/**
 * What the next request declares.
 *
 * Module state, not React state: `get()` runs outside the tree, and the value
 * must already be the new source when the rebuilt cache fires its first query.
 * The whole cache is thrown away on a switch, so nothing can be served from a
 * key that was written under the old scope.
 */
let committed: SourceKind | null = null;

export const committedSource = (): SourceKind | null => committed;

export function commitSource(kind: SourceKind) {
  committed = kind;
  try {
    localStorage.setItem(SOURCE_KEY, kind);
  } catch {
    /* private mode: the scope simply does not survive a reload */
  }
}

export function storedSource(): SourceKind | null {
  try {
    const v = localStorage.getItem(SOURCE_KEY);
    return isSourceKind(v) ? v : null;
  } catch {
    return null;
  }
}

type SliceMap = Partial<Record<SourceKind, string>>;

function readSlices(): SliceMap {
  try {
    const raw = localStorage.getItem(SLICE_KEY);
    const parsed = raw ? (JSON.parse(raw) as SliceMap) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** The last search string used in this source, e.g. `?range=90d&project=holo`. */
export const storedSlice = (kind: SourceKind): string => readSlices()[kind] ?? "";

export function rememberSlice(kind: SourceKind, search: string) {
  try {
    const map = readSlices();
    if (map[kind] === search) return;
    if (search) map[kind] = search;
    else delete map[kind];
    localStorage.setItem(SLICE_KEY, JSON.stringify(map));
  } catch {
    /* nothing to remember without storage */
  }
}

export async function fetchSources(signal?: AbortSignal): Promise<SourceList> {
  const res = await fetch(`${BASE}/api/sources`, { signal });
  if (!res.ok) throw new Error(`/api/sources → HTTP ${res.status}`);
  return (await res.json()) as SourceList;
}

/** `~` instead of the home prefix — the path is there to be recognised, not copied. */
export const tilde = (path: string): string => path.replace(/^\/(?:home|Users)\/[^/]+/, "~");

export interface ScopeValue {
  kind: SourceKind;
  list: SourceList;
  /** The entry for `kind`; may be absent on a machine with neither source built. */
  active: SourceView | undefined;
  /** Persist the slice, commit the scope, rebuild the cache, restore that source's slice. */
  switchTo: (kind: SourceKind) => void;
  /** Re-read `/api/sources` after a materialize, so the menu's counts stay honest. */
  reload: () => Promise<void>;
}

export const ScopeContext = createContext<ScopeValue | null>(null);

export function useScope(): ScopeValue {
  const value = useContext(ScopeContext);
  if (!value) throw new Error("useScope outside ScopeContext");
  return value;
}
