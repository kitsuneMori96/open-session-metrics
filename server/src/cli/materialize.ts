import { SOURCE_KIND, SOURCE_KINDS, type SourceKind } from "../config";
import { rebuild } from "../metrics/store";

/**
 * `osm materialize [--full] [--source qoder]`
 *
 * The server builds the store it is asked for on its own; this is for a first
 * build before start, or for forcing a schema refresh. Without `--source` it
 * materializes the same source the server would use by default.
 */
const args = process.argv.slice(2);
const full = args.includes("--full");
const flag = args.indexOf("--source");
const raw = flag >= 0 ? args[flag + 1] : undefined;
const kind: SourceKind = (SOURCE_KINDS as readonly string[]).includes(raw ?? "") ? (raw as SourceKind) : SOURCE_KIND;

const report = await rebuild(kind, { full });
console.log(`[osm] ${kind} materialized →`, JSON.stringify(report, null, 2));
process.exit(0);
