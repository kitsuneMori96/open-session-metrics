import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import {
  DEFAULT_PRESET,
  PRESETS,
  resolveWindow,
  sliceOf,
  windowLabel,
  type Facets0,
  type PresetId,
  type Slice,
  type WindowSpec,
} from "./api";

const FACET_KEYS = ["project", "model", "agent"] as const;
export type FacetKey = (typeof FACET_KEYS)[number];

const isPreset = (id: string | null): id is PresetId => !!id && PRESETS.some((p) => p.id === id);

export interface SliceState {
  window: WindowSpec;
  facets: Facets0;
  /** Ready for `useAnalytics`; resolved against the clock at call time. */
  slice: Slice;
  label: string;
  filtered: boolean;
  setPreset: (id: PresetId) => void;
  /** Commit an absolute window, the result of brushing a chart. */
  setWindow: (from: number, to: number) => void;
  /** `null` clears the facet. Setting a facet keeps the rest, so filters compose. */
  setFacet: (key: FacetKey, value: string | null) => void;
  clearFacets: () => void;
  reset: () => void;
}

/**
 * The slice lives in the URL, which is the whole point of doing this in a browser:
 * every cross-filtered view is a link. `range=` keeps a preset relative; `from`/`to`
 * are only written when a chart brush commits a concrete window.
 */
export function useSlice(): SliceState {
  const [params, setParams] = useSearchParams();

  const window = useMemo<WindowSpec>(() => {
    const from = Number(params.get("from") ?? 0);
    const to = Number(params.get("to") ?? 0);
    if (from > 0 && to > from) return { kind: "custom", from, to };
    const range = params.get("range");
    return { kind: "preset", id: isPreset(range) ? range : DEFAULT_PRESET };
  }, [params]);

  const facets = useMemo<Facets0>(
    () => ({ project: params.get("project"), model: params.get("model"), agent: params.get("agent") }),
    [params]
  );

  const mutate = useCallback(
    (fn: (next: URLSearchParams) => void) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          fn(next);
          return next;
        },
        { replace: true }
      );
    },
    [setParams]
  );

  const setPreset = useCallback(
    (id: PresetId) => mutate((next) => {
      next.delete("from");
      next.delete("to");
      if (id === DEFAULT_PRESET) next.delete("range");
      else next.set("range", id);
    }),
    [mutate]
  );

  const setWindow = useCallback(
    (from: number, to: number) =>
      mutate((next) => {
        next.delete("range");
        next.set("from", String(Math.round(from)));
        next.set("to", String(Math.round(to)));
      }),
    [mutate]
  );

  const setFacet = useCallback(
    (key: FacetKey, value: string | null) =>
      mutate((next) => {
        if (value === null) next.delete(key);
        else next.set(key, value);
      }),
    [mutate]
  );

  const clearFacets = useCallback(
    () => mutate((next) => FACET_KEYS.forEach((k) => next.delete(k))),
    [mutate]
  );

  const reset = useCallback(
    () => mutate((next) => {
      FACET_KEYS.forEach((k) => next.delete(k));
      next.delete("from");
      next.delete("to");
      next.delete("range");
    }),
    [mutate]
  );

  const slice = useMemo(() => sliceOf(window, facets), [window, facets]);

  return {
    window,
    facets,
    slice,
    label: windowLabel(window),
    filtered: FACET_KEYS.some((k) => facets[k] !== null) || window.kind === "custom" || window.id !== DEFAULT_PRESET,
    setPreset,
    setWindow,
    setFacet,
    clearFacets,
    reset,
  };
}

/** The same state, readable from any component under the router. */
export const windowTimes = (w: WindowSpec, now = Date.now()): { from: number; to: number } => resolveWindow(w, now);
