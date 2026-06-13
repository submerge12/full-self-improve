import type Database from "better-sqlite3";

import {
  recordMasteryUpdate,
  type MasteryRecord
} from "../db/content-store.js";
import type { TraceRecorder } from "./trace.js";

export type { MasteryRecord };

export interface RecordPersistentMasteryUpdateInput {
  conceptId: number;
  score: number;
  confidence: number;
  lastSeenAt?: string;
  trace?: TraceRecorder;
  runId?: string;
}

export function recordPersistentMasteryUpdate(
  db: Database.Database,
  input: RecordPersistentMasteryUpdateInput
): MasteryRecord {
  return recordMasteryUpdate(
    db,
    {
      conceptId: input.conceptId,
      score: input.score,
      confidence: input.confidence,
      lastSeenAt: input.lastSeenAt
    },
    { traceRecorder: input.trace, runId: input.runId }
  );
}
