import fs from 'node:fs';
import path from 'node:path';
import {
  headerNames,
  distinctValues,
  parseDate,
  readRows,
  IMPORT_FIELDS,
  type FileFormat,
  type ImportField,
} from '../shared/importRules';
import { toIsoDate } from '../shared/model';
import type {
  FileInspection,
  FormatPreview,
  SourceFile,
} from '../shared/sources';
import {
  sha256,
  snapshotAndRead,
  readWorkbook,
  READABLE,
  UnreadableFileError,
  type Workbook,
} from './workbook';
import type { ReadVersion, Sources } from './sources';

const today = () => toIsoDate(new Date());

const inside = (child: string, parent: string): boolean => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * Why WorkSync must not write into a folder, or null (spec 06): never inside a
 * linked customer file's folder or a Box Drive folder.
 */
export function writeTargetProblem(
  folder: string,
  sources: SourceFile[],
  instead: string,
): string | null {
  for (const s of sources) {
    const linked = s.pattern ? s.path : path.dirname(s.path);
    if (inside(folder, linked))
      return `This folder holds a linked customer file (${path.basename(s.currentFile)}). Choose ${instead} instead.`;
  }
  if (folder.split(/[\\/]/).some((part) => /^box( drive)?$/i.test(part))) {
    return `This folder is inside Box, where the customer could see it. Choose ${instead}.`;
  }
  return null;
}

/** Turns a name pattern such as `WBS_*.xlsx` into a test. `*` is any text and `?` one character. */
export function patternTest(pattern: string): (name: string) => boolean {
  const re = new RegExp(
    `^${pattern
      .split('')
      .map((c) =>
        c === '*'
          ? '.*'
          : c === '?'
            ? '.'
            : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'),
      )
      .join('')}$`,
    'i',
  );
  return (name) => re.test(name);
}

/** The file a source reads now: the linked file, or the newest file matching its pattern. */
export function currentFile(
  s: Pick<SourceFile, 'path' | 'pattern' | 'currentFile'>,
): string | null {
  if (!s.pattern) return fs.existsSync(s.path) ? s.path : null;
  let names: string[];
  try {
    names = fs.readdirSync(s.path);
  } catch {
    return null;
  }
  const test = patternTest(s.pattern);
  const matches = names
    .filter((n) => test(n) && !n.startsWith('~$'))
    .map((n) => {
      const full = path.join(s.path, n);
      try {
        return { full, mtime: fs.statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { full: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime);
  return matches[0]?.full ?? null;
}

const isBusy = (e: unknown) => {
  const code = (e as NodeJS.ErrnoException)?.code;
  return (
    code === 'EBUSY' ||
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'ETIMEDOUT' ||
    code === 'EAGAIN'
  );
};

/**
 * Linked files (spec 04, Linking files): checks them, takes snapshots and
 * reads versions. The app only ever reads customer files.
 */
export class FileLinks {
  /** Workbooks read while setting up a format, so each step does not read the file again. */
  private cache = new Map<string, { workbook: Workbook; mtimeMs: number }>();

  constructor(
    private readonly sources: Sources,
    private readonly snapshotRoot: string,
  ) {}

  private load(file: string): Workbook {
    const stat = fs.statSync(file);
    const hit = this.cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.workbook;
    if (!READABLE.includes(path.extname(file).toLowerCase())) {
      throw new UnreadableFileError(
        'WorkSync reads .xlsx, .xlsm, .xls and .csv files.',
      );
    }
    const workbook = readWorkbook(fs.readFileSync(file), file);
    this.cache.clear();
    this.cache.set(file, { workbook, mtimeMs: stat.mtimeMs });
    return workbook;
  }

  /** The sheets of a file with their first rows, for choosing the sheet and header rows. */
  inspect(file: string): FileInspection {
    const wb = this.load(file);
    return {
      file,
      fileName: path.basename(file),
      sheets: wb.sheetNames.map((name) => {
        const grid = wb.grid(name);
        return {
          name,
          rowCount: grid.length,
          rows: grid
            .slice(0, 40)
            .map((r) =>
              r.map((c) =>
                c === null ? '' : typeof c === 'object' ? c.date : String(c),
              ),
            ),
        };
      }),
    };
  }

  /** What a format would read from a file, before it is saved. */
  preview(file: string, format: FileFormat): FormatPreview {
    const grid = this.load(file).grid(format.sheet);
    const headers = headerNames(grid, format.headerRows);
    const from = Math.max(...format.headerRows) + 1;
    const result = readRows(grid, format, today());
    const col = (f: ImportField) => format.columns[f];
    const dates = IMPORT_FIELDS.filter(
      (f) =>
        ['plannedStart', 'plannedEnd', 'actualStart', 'actualEnd'].includes(
          f,
        ) && col(f) !== undefined,
    ).map((f) => {
      const samples = grid
        .slice(from)
        .map((r) => r[col(f)!] ?? null)
        .filter((c) => c !== null)
        .slice(0, 4)
        .map((c) => ({
          text: typeof c === 'object' ? c.date : String(c),
          date: parseDate(c, today(), format.dayFirst),
        }));
      return { field: f, samples };
    });
    return {
      headers,
      rows: result.rows.slice(0, 20),
      rowCount: result.rows.length,
      skipped: result.skipped,
      statusValues:
        col('status') === undefined
          ? []
          : distinctValues(grid, col('status')!, from),
      priorityValues:
        col('priority') === undefined
          ? []
          : distinctValues(grid, col('priority')!, from),
      dates,
    };
  }

  /** Copies the current file into the data folder and reads the format's sheet from the copy. */
  readVersion(
    source: Pick<
      SourceFile,
      'id' | 'path' | 'pattern' | 'currentFile' | 'format'
    >,
    file?: string,
  ): ReadVersion {
    const target = file ?? currentFile(source);
    if (!target)
      throw new Error(
        'The linked file was not found. Link it again at its new place.',
      );
    const read = snapshotAndRead(
      target,
      path.join(this.snapshotRoot, source.id),
    );
    if (!read.workbook.sheetNames.includes(source.format.sheet)) {
      throw new UnreadableFileError(
        `The sheet “${source.format.sheet}” is no longer in ${path.basename(target)}.`,
      );
    }
    for (const old of this.sources.oldSnapshots(source.id))
      fs.rmSync(old, { force: true });
    return {
      file: target,
      grid: read.workbook.grid(source.format.sheet),
      snapshot: read.snapshot,
      fingerprint: read.fingerprint,
      size: read.size,
      mtimeMs: read.mtimeMs,
      readDay: today(),
    };
  }

  /**
   * Checks one linked file: its size and time first, then a fingerprint of its
   * content, so a file that was only touched is not reported as changed.
   */
  check(s: SourceFile): void {
    const file = currentFile(s);
    if (!file) {
      this.sources.setState(
        s.id,
        'missing',
        s.pattern
          ? `No file in ${s.path} matches ${s.pattern}.`
          : `Nothing exists at ${s.path}.`,
      );
      return;
    }
    try {
      const stat = fs.statSync(file);
      const known = this.sources.facts(s.id);
      if (
        file === s.currentFile &&
        stat.size === known.size &&
        stat.mtimeMs === known.mtimeMs
      ) {
        if (s.state !== 'ok' && s.state !== 'changed')
          this.sources.setState(s.id, 'ok');
        return;
      }
      const fp = sha256(fs.readFileSync(file));
      if (fp === known.fingerprint)
        this.sources.touch(s.id, stat.size, stat.mtimeMs);
      else
        this.sources.setState(
          s.id,
          'changed',
          `${path.basename(file)} changed ${new Date(stat.mtimeMs).toLocaleString('en-GB')}.`,
        );
    } catch (e) {
      if (isBusy(e))
        this.sources.setState(
          s.id,
          'unavailable',
          'The file cannot be opened now, for example because Box has not downloaded it or it is open elsewhere. WorkSync tries again.',
        );
      else
        this.sources.setState(
          s.id,
          'unavailable',
          e instanceof Error ? e.message : String(e),
        );
    }
  }

  checkAll(): SourceFile[] {
    for (const s of this.sources.list()) this.check(s);
    return this.sources.list();
  }
}
