/** Linked source files and their review (spec 04). Shared by the main process and the screens. */
import type {
  FieldChange,
  FileFormat,
  ImportedRow,
  SkippedRow,
} from './importRules';
import type { LanguageCode } from './model';

export type SourceState =
  | 'ok'
  | 'changed'
  | 'missing'
  | 'unavailable'
  | 'unreadable';

export const SOURCE_STATE_NAME: Record<SourceState, string> = {
  ok: 'Up to date',
  changed: 'Changed',
  missing: 'Missing',
  unavailable: 'Not available',
  unreadable: 'Cannot be read',
};

export interface SourceFile {
  id: string;
  projectId: string;
  /** The linked file, or the folder when a name pattern is used. */
  path: string;
  /** Such as `WBS_*.xlsx`: the newest matching file in `path` is read. */
  pattern: string | null;
  /** The file read last. */
  currentFile: string;
  format: FileFormat;
  mainLanguage: LanguageCode;
  lastReadAt: string;
  state: SourceState;
  stateDetail: string;
  taskCount: number;
}

/** A sheet as shown while setting up a file format. */
export interface SheetPreview {
  name: string;
  rowCount: number;
  /** The first rows as text, for choosing the header rows. */
  rows: string[][];
}

export interface FileInspection {
  file: string;
  fileName: string;
  sheets: SheetPreview[];
}

/** What a file format would read, shown before it is saved. */
export interface FormatPreview {
  headers: string[];
  /** Up to 20 tasks as they will be imported. */
  rows: ImportedRow[];
  rowCount: number;
  skipped: SkippedRow[];
  /** Every status and priority value in the matched columns. */
  statusValues: string[];
  priorityValues: string[];
  /** For each matched date column: a few cells as written and as read. */
  dates: { field: string; samples: { text: string; date: string | null }[] }[];
}

export interface LinkInput {
  projectId: string;
  file: string;
  /** Follow newer files in the same folder whose names match this, such as `WBS_*.xlsx`. */
  pattern: string | null;
  format: FileFormat;
  mainLanguage: LanguageCode;
}

export interface ReviewChange extends FieldChange {
  /** The owner also changed this field in the app since the file was last read. */
  conflict: boolean;
  /** The value in the app now, shown for a conflict. */
  appValue: string;
}

/** The differences between the file and the app, for the owner to apply (spec 03, Reviewing a new version). */
export interface Review {
  sourceId: string;
  fileName: string;
  modifiedAt: string;
  added: ImportedRow[];
  /** Rows among the new ones whose task the owner deleted; not ticked unless the owner wants them back. */
  deletedRows: number[];
  changed: {
    taskId: string;
    customerId: string;
    title: string;
    changes: ReviewChange[];
  }[];
  removed: { taskId: string; customerId: string; title: string }[];
  skipped: SkippedRow[];
  unmappedStatus: string[];
  unmappedPriority: string[];
  looksRenumbered: boolean;
  byTitle: boolean;
}

export interface ApplySelection {
  byTitle: boolean;
  /** Row numbers of new tasks to add. */
  addRows: number[];
  /** Tasks whose changes to apply, and per task the fields where the owner keeps the app's value. */
  change: { taskId: string; keepMine: string[] }[];
  /** Tasks to mark Removed from file. */
  removeTaskIds: string[];
  /**
   * New rows the owner joined to an existing task by hand, such as a row whose
   * ID changed. The task takes the row, with its new ID and values.
   */
  join?: { row: number; taskId: string }[];
}
