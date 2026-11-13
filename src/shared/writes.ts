/** Writing changes to the owner's copy of a customer file (spec 04). Shared by the main process and the screens. */
import type { ImportField } from './importRules';

/** Customer fields that can be written to the copy. ID, title and description never are. */
export const WRITABLE = [
  'assignee',
  'plannedStart',
  'plannedEnd',
  'actualStart',
  'actualEnd',
  'status',
  'priority',
  'category',
  'remarks',
] as const satisfies readonly ImportField[];
export type WritableField = (typeof WRITABLE)[number];

/** One cell that will change in the copy. */
export interface PendingChange {
  taskId: string;
  customerId: string;
  title: string;
  field: WritableField;
  label: string;
  /** The cell, such as H7. */
  cell: string;
  /** What the file says now, as written in it. */
  from: string;
  /** What will be written, as the file writes it. */
  to: string;
  /** Why it cannot be written, such as no word for a status in the file format. */
  problem: string | null;
  /** The remarks look like they are not in the file's language. */
  languageWarning: string | null;
}

export interface WritePlan {
  sourceId: string;
  fileName: string;
  sheet: string;
  changes: PendingChange[];
  /** A reason the copy cannot be made now, such as a new version waiting for review. */
  blocked: string | null;
  /** Where the copy goes by default. */
  suggestedFile: string;
}

export interface WriteResult {
  file: string;
  written: number;
  /** Cells left alone, such as formulas, for the owner to update by hand. */
  skipped: { cell: string; customerId: string; reason: string }[];
  /** The number of cells compared after saving. */
  checkedCells: number;
}
