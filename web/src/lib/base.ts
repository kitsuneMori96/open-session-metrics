/**
 * Where the API lives.
 *
 * Empty means same origin: `osm` serves the API and the web build from one
 * process, and `vite dev` proxies `/api` to the server. Pinning a port here
 * would break every `OSM_PORT` override — the page would load from :8899 and
 * query whatever stale server happened to hold :8787. `VITE_OSM_API` remains
 * for split deployments.
 */
export const BASE = (import.meta.env.VITE_OSM_API as string | undefined) ?? "";
