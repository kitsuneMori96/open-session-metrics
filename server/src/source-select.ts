import { QODER_PROJECTS, SOURCE_DB, SOURCE_KIND, type SourceKind } from "./config";
import { SourceReader, type SourceLike } from "./source";
import { QoderSource } from "./source-qoder";

/**
 * Bind the reader a store is built from.
 *
 * Both implementations produce the same normalized records, so nothing above
 * this function knows which tool the sessions came from. The kind is explicit
 * because two stores coexist: the default one is built at boot, the other when
 * the browser first asks for it.
 */
export function openSource(kind: SourceKind = SOURCE_KIND): SourceLike {
  return kind === "qoder" ? new QoderSource(QODER_PROJECTS) : new SourceReader(SOURCE_DB);
}

export type { SourceLike };
