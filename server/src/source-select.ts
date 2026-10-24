import { QODER_PROJECTS, SOURCE_DB, SOURCE_KIND } from "./config";
import { SourceReader, type SourceLike } from "./source";
import { QoderSource } from "./source-qoder";

/**
 * Bind the reader the rest of the pipeline expects.
 *
 * Both implementations produce the same normalized records, so nothing above
 * this function knows which tool the sessions came from.
 */
export function openSource(): SourceLike {
  return SOURCE_KIND === "qoder" ? new QoderSource(QODER_PROJECTS) : new SourceReader(SOURCE_DB);
}

export type { SourceLike };
