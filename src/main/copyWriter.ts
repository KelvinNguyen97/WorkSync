import type { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {
  FIELD_NAMES,
  cellText,
  type Cell,
  type ImportedRow,
} from '../shared/importRules';
import {
  detectLanguage,
  fileDate,
  toIsoDate,
  type Level,
  type Status,
  type Task,
} from '../shared/model';
import type { SourceFile } from '../shared/sources';
import {
  WRITABLE,
  type PendingChange,
  type WritableField,
  type WritePlan,
  type WriteResult,
} from '../shared/writes';
import { writeTargetProblem, type FileLinks } from './fileLinks';
import type { Sources } from './sources';
import type { Store } from './store';
import { readWorkbook } from './workbook';
import { cellRef, editCells, type CellEdit, type CellValue } from './xlsxCells';
import { editCsvCells } from './csvCells';
import { XlsWriteError, editXlsCells } from './xlsCells';

/** The file types WorkSync writes copies of, each by changing only the cells written. */
const WRITABLE_TYPES = ['.xlsx', '.xlsm', '.xls', '.csv'];

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? '' : String(v));
const isDate = (f: WritableField) =>
  f === 'plannedStart' ||
  f === 'plannedEnd' ||
  f === 'actualStart' ||
  f === 'actualEnd';

/** The app's value of a field and the value the file had when last read. */
function values(
  t: Task,
  base: ImportedRow,
  f: WritableField,
): { app: string; file: string } {
  if (f === 'status') return { app: t.status, file: base.status };
  if (f === 'priority') return { app: t.priority, file: base.priority };
  if (isDate(f)) return { app: t[f] ?? '', file: base[f] ?? '' };
  return { app: t[f], file: base[f] };
}

/** The file's own word for a status or level: the task's word when it still means that, else the first word for it. */
function wordFor<T extends string>(
  words: Record<string, T>,
  value: T,
  current: string,
): string | null {
  if (current && words[current] === value) return current;
  return Object.keys(words).find((w) => words[w] === value) ?? null;
}

/**
 * Writing changes to the owner's copy (spec 04). The copy is made from the
 * latest snapshot, only target cells change, and the copy is read back and
 * compared with the snapshot before the changes stop being pending.
 */
export class CopyWriter {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: Store,
    private readonly sources: Sources,
    private readonly links: FileLinks,
    private readonly defaultFolder: string,
  ) {}

  private written(taskId: string): Record<string, string> {
    return JSON.parse(
      str(
        (
          this.db
            .prepare('SELECT written FROM tasks WHERE id = ?')
            .get(taskId) as Row
        ).written,
      ) || '{}',
    );
  }

  /** Every customer-field change of a source's tasks not yet in the file or a copy. */
  pending(source: SourceFile): PendingChange[] {
    const f = source.format;
    const project = this.store.getProject(source.projectId);
    const rows = this.db
      .prepare(
        "SELECT id, file_row FROM tasks WHERE source_file_id = ? AND file_state = 'in_file' AND file_row IS NOT NULL",
      )
      .all(source.id) as Row[];
    const out: PendingChange[] = [];
    for (const r of rows) {
      const t = this.store.getTask(str(r.id));
      const base = JSON.parse(str(r.file_row)) as ImportedRow;
      const done = this.written(t.id);
      for (const field of WRITABLE) {
        const col = f.columns[field];
        if (col === undefined || !t.sheetRow) continue;
        const v = values(t, base, field);
        if (v.app === v.file || done[field] === v.app) continue;
        let from = isDate(field) ? fileDate(v.file || null) : v.file;
        let to = isDate(field) ? fileDate(v.app || null) : v.app;
        let problem: string | null = null;
        if (field === 'status') {
          from = base.statusWord;
          const w = wordFor<Status>(f.statusWords, t.status, t.statusWord);
          to = w ?? t.status;
          if (!w)
            problem = `The file format has no word for ${t.status}. Add one under Files, or change it in Excel.`;
        }
        if (field === 'priority') {
          from = base.priorityWord;
          const w = wordFor<Level>(f.priorityWords, t.priority, t.priorityWord);
          to = w ?? t.priority;
          if (!w)
            problem = 'The file format has no value for this priority level.';
        }
        let languageWarning: string | null = null;
        if (field === 'remarks' && t.remarks.trim()) {
          // The working language counts too: remarks are often typed in it.
          const lang = detectLanguage(
            t.remarks,
            [
              ...new Set([
                ...project.originalLanguages,
                project.workingLanguage,
              ]),
            ],
            source.mainLanguage,
          );
          if (lang !== source.mainLanguage)
            languageWarning =
              'These remarks do not look like they are in the file’s language. Translate them first if the customer reads them.';
        }
        out.push({
          taskId: t.id,
          customerId: t.customerId,
          title: t.titleTranslation || t.titleOriginal,
          field,
          label: FIELD_NAMES[field],
          cell: cellRef(t.sheetRow - 1, col),
          from,
          to,
          problem,
          languageWarning,
        });
      }
    }
    return out.sort(
      (a, b) =>
        a.customerId.localeCompare(b.customerId, undefined, {
          numeric: true,
        }) || WRITABLE.indexOf(a.field) - WRITABLE.indexOf(b.field),
    );
  }

  pendingCount(): number {
    return this.sources.list().reduce((n, s) => n + this.pending(s).length, 0);
  }

  private latestSnapshot(sourceId: string): string {
    const r = this.db
      .prepare(
        'SELECT snapshot FROM file_versions WHERE source_id = ? ORDER BY read_at DESC, rowid DESC LIMIT 1',
      )
      .get(sourceId) as Row | undefined;
    if (!r || !fs.existsSync(str(r.snapshot)))
      throw new Error(
        'The copy of the last version read is missing. Check the file under Files so WorkSync reads it again.',
      );
    return str(r.snapshot);
  }

  private suggestedName(source: SourceFile, folder: string): string {
    const ext = path.extname(source.currentFile);
    const base = path
      .basename(source.currentFile, ext)
      .replace(/_WorkSync(-\d+)?$/, '');
    const stamp = toIsoDate(new Date()).replaceAll('-', '');
    let name = `${base}_${stamp}_WorkSync${ext}`;
    for (let i = 2; fs.existsSync(path.join(folder, name)); i++)
      name = `${base}_${stamp}_WorkSync-${i}${ext}`;
    return path.join(folder, name);
  }

  plans(): WritePlan[] {
    return this.sources
      .list()
      .map((s) => {
        this.links.check(s);
        const now = this.sources.get(s.id);
        const changes = this.pending(now);
        const ext = path.extname(now.currentFile).toLowerCase();
        const blocked =
          now.state === 'changed'
            ? 'The file has a new version. Review it first, so the copy is not based on an old file.'
            : !WRITABLE_TYPES.includes(ext)
              ? `WorkSync cannot write ${ext} files. Update this file in Excel.`
              : null;
        return {
          sourceId: now.id,
          fileName: path.basename(now.currentFile),
          sheet: now.format.sheet,
          changes,
          blocked,
          suggestedFile: this.suggestedName(now, this.defaultFolder),
        };
      })
      .filter((p) => p.changes.length);
  }

  /** Writes the chosen changes, as `taskId:field`, into a copy in `folder`, and checks the copy. */
  write(sourceId: string, chosen: string[], folder: string): WriteResult {
    const source = this.sources.get(sourceId);
    this.links.check(source);
    if (this.sources.get(sourceId).state === 'changed')
      throw new Error(
        'The file has a new version. Review it first, so the copy is not based on an old file.',
      );
    const problem = writeTargetProblem(
      folder,
      this.sources.list(),
      'a folder on your PC, outside Box and the linked file’s folder',
    );
    if (problem) throw new Error(problem);
    const ext = path.extname(source.currentFile).toLowerCase();
    if (!WRITABLE_TYPES.includes(ext))
      throw new Error(`WorkSync cannot write ${ext} files.`);

    const pick = new Set(chosen);
    const changes = this.pending(source).filter(
      (c) => pick.has(`${c.taskId}:${c.field}`) && !c.problem,
    );
    if (!changes.length) throw new Error('Nothing to write.');
    const tasks = new Map(
      changes.map((c) => [c.taskId, this.store.getTask(c.taskId)]),
    );
    const edits: (CellEdit & { change: PendingChange })[] = changes.map((c) => {
      const t = tasks.get(c.taskId)!;
      const col = source.format.columns[c.field]!;
      let value: CellValue;
      if (isDate(c.field)) {
        const iso = t[c.field as 'plannedStart'];
        value = iso ? { kind: 'date', iso } : { kind: 'empty' };
      } else value = c.to ? { kind: 'text', text: c.to } : { kind: 'empty' };
      return { row: t.sheetRow! - 1, col, value, change: c };
    });

    const snapshot = this.latestSnapshot(sourceId);
    const original = fs.readFileSync(snapshot);
    let result: ReturnType<typeof editCells>;
    try {
      result =
        ext === '.csv'
          ? editCsvCells(original, edits)
          : ext === '.xls'
            ? editXlsCells(original, source.format.sheet, edits)
            : editCells(original, source.format.sheet, edits);
    } catch (error) {
      if (error instanceof XlsWriteError) throw new Error(error.message);
      throw error;
    }
    const { data, skipped, written } = result;
    fs.mkdirSync(folder, { recursive: true });
    const target = this.suggestedName(source, folder);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);

    // Read the copy back: each written cell has its new value and no other cell changed.
    let checked = 0;
    try {
      const before = readWorkbook(original, snapshot);
      const after = readWorkbook(fs.readFileSync(tmp), target);
      const expect = new Map(
        edits
          .filter((e) => written.includes(cellRef(e.row, e.col)))
          .map((e) => [`${e.row},${e.col}`, e.value]),
      );
      for (const sheet of before.sheetNames) {
        const a = before.grid(sheet, false);
        const b = after.grid(sheet, false);
        const rows = Math.max(a.length, b.length);
        for (let r = 0; r < rows; r++) {
          const cols = Math.max(a[r]?.length ?? 0, b[r]?.length ?? 0);
          for (let c = 0; c < cols; c++) {
            checked++;
            const got = norm(b[r]?.[c] ?? null);
            const want =
              sheet === source.format.sheet
                ? expect.get(`${r},${c}`)
                : undefined;
            if (want) {
              const ok =
                want.kind === 'empty'
                  ? got === ''
                  : want.kind === 'date'
                    ? got === want.iso || got === fileDate(want.iso)
                    : got === want.text;
              if (!ok)
                throw new Error(
                  `Cell ${cellRef(r, c)} did not get its new value.`,
                );
            } else if (got !== norm(a[r]?.[c] ?? null)) {
              throw new Error(
                `Cell ${cellRef(r, c)} on ${sheet} changed although it should not have.`,
              );
            }
          }
        }
      }
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw new Error(
        `The copy failed its check and was not saved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    fs.renameSync(tmp, target);

    // The written changes are no longer pending; each task's history records the copy.
    const name = path.basename(target);
    const byTask = new Map<
      string,
      { field: WritableField; from: string; to: string }[]
    >();
    for (const e of edits) {
      if (!written.includes(cellRef(e.row, e.col))) continue;
      byTask.set(e.change.taskId, [
        ...(byTask.get(e.change.taskId) ?? []),
        e.change,
      ]);
    }
    this.db.exec('BEGIN');
    try {
      for (const [taskId, list] of byTask) {
        const t = tasks.get(taskId)!;
        const done = this.written(taskId);
        const base = JSON.parse(
          str(
            (
              this.db
                .prepare('SELECT file_row FROM tasks WHERE id = ?')
                .get(taskId) as Row
            ).file_row,
          ),
        ) as ImportedRow;
        for (const c of list) done[c.field] = values(t, base, c.field).app;
        this.db
          .prepare('UPDATE tasks SET written = ? WHERE id = ?')
          .run(JSON.stringify(done), taskId);
        this.store.log(
          taskId,
          'Write-back',
          `Written to ${name}: ${list.map((c) => `${FIELD_NAMES[c.field]} ${c.from || '(empty)'} → ${c.to || '(empty)'}`).join('; ')}.`,
        );
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return {
      file: target,
      written: written.length,
      skipped: skipped.map((s) => ({
        cell: s.ref,
        customerId:
          edits.find((e) => cellRef(e.row, e.col) === s.ref)?.change
            .customerId ?? '',
        reason: s.reason,
      })),
      checkedCells: checked,
    };
  }
}

const norm = (c: Cell): string => cellText(c);
