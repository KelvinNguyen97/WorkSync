import type { ImportColumn } from './releaseFormat';

/** A file as an import read it. */
export interface ReleaseImportFile {
  fileName: string;
  module: string;
  type: string;
  destination: string;
  category: string;
  environment: string;
  version: string;
  changes: string;
  purpose: string;
  verification: string;
  /** Unknown columns, by the field key they would get. */
  extra: Record<string, string>;
}

/** A release as an import read it: its rows of the same product, version and date. */
export interface ReleaseImportRelease {
  key: string;
  product: string;
  version: string;
  target: string;
  releasedOn: string | null;
  status: 'released' | 'planned';
  summary: string;
  purpose: string;
  changes: string;
  verification: string;
  files: ReleaseImportFile[];
  /** The project's release with the same product, version and date, if any. */
  match: string | null;
}

export type ImportProblem =
  | 'date'
  | 'noProduct'
  | 'noVersion'
  | 'noDate'
  | 'noFile'
  | 'tooMany';

/** What an import would do, read from the file without saving anything. */
export interface ReleaseImportPlan {
  fileName: string;
  sheet: string;
  /** Rows with something in them, below the headings. */
  rows: number;
  /** The file is the app's own release export. */
  ownExport: boolean;
  /** Rows that repeated a file (or a release's text) already read, put together with it. */
  merged: number;
  /** The known columns found, in the sheet's order. */
  columns: ImportColumn[];
  /** Columns the format does not know: candidates for the project's own fields. */
  unknown: { name: string; key: string; known: boolean }[];
  releases: ReleaseImportRelease[];
  /** Rows left out, with why. */
  problems: { row: number; code: ImportProblem; value: string }[];
}
