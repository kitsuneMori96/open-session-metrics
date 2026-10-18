import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { DATA_DIR, METRICS_DB } from "../config";
import { build, type BuildReport } from "./build";

const NEXT = METRICS_DB + ".next";
let handle: DatabaseSync | null = null;

export function current(): DatabaseSync {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!handle) handle = new DatabaseSync(METRICS_DB);
  return handle;
}

export function closeReader() {
  try {
    handle?.close();
  } catch {
    /* already closed */
  }
  handle = null;
}

/** Rebuild into a side file, then swap it in so readers never see a half-dropped schema. */
export async function rebuild(): Promise<BuildReport> {
  mkdirSync(DATA_DIR, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(NEXT + suffix)) rmSync(NEXT + suffix, { force: true });

  const writer = new DatabaseSync(NEXT);
  let report: BuildReport;
  try {
    report = await build(writer);
  } finally {
    writer.close();
  }

  closeReader();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(METRICS_DB + suffix, { force: true });
  renameSync(NEXT, METRICS_DB);
  return report;
}
