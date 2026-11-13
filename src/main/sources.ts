import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  rowChanges,
  FIELD_NAMES,
  compareVersions,
  readRows,
  type ComparedField,
  type FieldChange,
  type FileFormat,
  type Grid,
  type ImportedRow,
} from '../shared/importRules';
import {
  detectLanguage,
  translationStateFor,
  type Task,
} from '../shared/model';
import type {
  ApplySelection,
  LinkInput,
  Review,
  ReviewChange,
  SourceFile,
  SourceState,
} from '../shared/sources';
import type { Store } from './store';

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? '' : String(v));

/** What was read from disk: the grid of the format's sheet and the file's facts. */
export interface ReadVersion {
  file: string;
  grid: Grid;
  snapshot: string;
  fingerprint: string;
  size: number;
  mtimeMs: number;
  /** Today, for reading dates without a year. */
  readDay: string;
}

const COMPARED_LABEL: Record<ComparedField, string> = {
  title: FIELD_NAMES.title,
  description: FIELD_NAMES.description,
  assignee: FIELD_NAMES.assignee,
  plannedStart: FIELD_NAMES.plannedStart,
  plannedEnd: FIELD_NAMES.plannedEnd,
  actualStart: FIELD_NAMES.actualStart,
  actualEnd: FIELD_NAMES.actualEnd,
  statusWord: FIELD_NAMES.status,
  priorityWord: FIELD_NAMES.priority,
  category: FIELD_NAMES.category,
  remarks: FIELD_NAMES.remarks,
};
export const changeLabel = (field: string): string =>
  field.startsWith('extra:')
    ? field.slice(6)
    : (COMPARED_LABEL[field as ComparedField] ?? field);

/** The app's current value for a compared field, to tell the owner's edits from the file's. */
function appValue(
  t: Task,
  field: string,
  before: ImportedRow,
): { value: string; changed: boolean } {
  switch (field) {
    case 'title':
      return {
        value: t.titleOriginal,
        changed: t.titleOriginal !== before.title,
      };
    case 'description':
      return {
        value: t.descriptionOriginal,
        changed: t.descriptionOriginal !== before.description,
      };
    case 'statusWord':
      return { value: t.status, changed: t.status !== before.status };
    case 'priorityWord':
      return { value: t.priority, changed: t.priority !== before.priority };
    case 'assignee':
    case 'category':
    case 'remarks':
      return { value: t[field], changed: t[field] !== before[field] };
    case 'plannedStart':
    case 'plannedEnd':
    case 'actualStart':
    case 'actualEnd':
      return {
        value: t[field] ?? '',
        changed: (t[field] ?? null) !== (before[field] ?? null),
      };
    default:
      return { value: '', changed: false };
  }
}

/** Linked source files: importing them, and reviewing and applying new versions. */
export class Sources {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: Store,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private toSource(r: Row): SourceFile {
    const count = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE source_file_id = ? AND file_state = 'in_file'",
      )
      .get(str(r.id)) as { n: number };
    return {
      id: str(r.id),
      projectId: str(r.project_id),
      path: str(r.path),
      pattern: r.pattern == null ? null : str(r.pattern),
      currentFile: str(r.current_file),
      format: JSON.parse(str(r.format)),
      mainLanguage: str(r.main_language) as SourceFile['mainLanguage'],
      lastReadAt: str(r.last_read_at),
      state: str(r.state) as SourceState,
      stateDetail: str(r.state_detail),
      taskCount: Number(count.n),
    };
  }

  list(): SourceFile[] {
    return (
      this.db
        .prepare('SELECT * FROM source_files ORDER BY created_at')
        .all() as Row[]
    ).map((r) => this.toSource(r));
  }

  get(id: string): SourceFile {
    const r = this.db
      .prepare('SELECT * FROM source_files WHERE id = ?')
      .get(id) as Row | undefined;
    if (!r) throw new Error('This linked file no longer exists.');
    return this.toSource(r);
  }

  /** The last version read, used to tell a touched file from a changed one. */
  facts(id: string): { fingerprint: string; size: number; mtimeMs: number } {
    const r = this.db
      .prepare(
        'SELECT fingerprint, size, mtime_ms FROM source_files WHERE id = ?',
      )
      .get(id) as Row;
    return {
      fingerprint: str(r.fingerprint),
      size: Number(r.size),
      mtimeMs: Number(r.mtime_ms),
    };
  }

  /** Points a link at the file's new place: the file itself, or a file in the pattern's new folder. */
  relocate(id: string, file: string): SourceFile {
    const s = this.get(id);
    this.db
      .prepare(
        "UPDATE source_files SET path = ?, current_file = ?, state = 'ok', state_detail = '' WHERE id = ?",
      )
      .run(s.pattern ? path.dirname(file) : file, file, id);
    return this.get(id);
  }

  setState(id: string, state: SourceState, detail = ''): void {
    this.db
      .prepare(
        'UPDATE source_files SET state = ?, state_detail = ? WHERE id = ?',
      )
      .run(state, detail, id);
  }

  /** Records that the file was touched but its content is the same. */
  touch(id: string, size: number, mtimeMs: number): void {
    this.db
      .prepare(
        "UPDATE source_files SET size = ?, mtime_ms = ?, state = 'ok', state_detail = '' WHERE id = ?",
      )
      .run(size, mtimeMs, id);
  }

  updateFormat(id: string, format: FileFormat): SourceFile {
    this.db
      .prepare('UPDATE source_files SET format = ? WHERE id = ?')
      .run(JSON.stringify(format), id);
    return this.get(id);
  }

  remove(id: string): void {
    this.tx(() => {
      this.db
        .prepare(
          "UPDATE tasks SET file_state = 'removed' WHERE source_file_id = ?",
        )
        .run(id);
      this.db.prepare('DELETE FROM source_files WHERE id = ?').run(id);
    });
  }

  private recordVersion(
    id: string,
    v: ReadVersion,
    summary: { added: number; changed: number; removed: number },
  ): void {
    this.db
      .prepare(
        'INSERT INTO file_versions (id, source_id, read_at, fingerprint, snapshot, file_name, summary) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        randomUUID(),
        id,
        this.now(),
        v.fingerprint,
        v.snapshot,
        path.basename(v.file),
        JSON.stringify(summary),
      );
    this.db
      .prepare(
        "UPDATE source_files SET current_file = ?, fingerprint = ?, size = ?, mtime_ms = ?, last_read_at = ?, state = 'ok', state_detail = '' WHERE id = ?",
      )
      .run(v.file, v.fingerprint, v.size, v.mtimeMs, this.now(), id);
  }

  /** Snapshots beyond the last ten of a source, for the caller to delete from disk. */
  oldSnapshots(id: string): string[] {
    const rows = this.db
      .prepare(
        'SELECT id, snapshot FROM file_versions WHERE source_id = ? ORDER BY read_at DESC',
      )
      .all(id) as Row[];
    const old = rows.slice(10);
    for (const r of old)
      this.db.prepare('DELETE FROM file_versions WHERE id = ?').run(str(r.id));
    return old.map((r) => str(r.snapshot));
  }

  /** Links a file to a project and adds every task row as a task. */
  link(
    input: LinkInput,
    v: ReadVersion,
    id: string = randomUUID(),
  ): { source: SourceFile; added: number; skipped: number } {
    const read = readRows(v.grid, input.format, v.readDay);
    if (read.unmappedStatus.length || read.unmappedPriority.length) {
      throw new Error(
        `Some values have no meaning yet: ${[...read.unmappedStatus, ...read.unmappedPriority].join(', ')}. Map them first.`,
      );
    }
    if (!read.rows.length)
      throw new Error('No task rows were found with this file format.');
    // The same sheet of the same file twice would make every task twice (spec 04 allows
    // another sheet of the same file, which is another source).
    const same = (a: string, b: string) => {
      const n = (x: string) => {
        const r = path.resolve(x);
        return process.platform === 'linux' ? r : r.toLowerCase();
      };
      return n(a) === n(b);
    };
    const dup = this.list().find(
      (s) =>
        s.projectId === input.projectId &&
        s.format.sheet === input.format.sheet &&
        (same(s.currentFile, v.file) ||
          (!!input.pattern &&
            s.pattern === input.pattern &&
            same(s.path, path.dirname(input.file)))),
    );
    if (dup)
      throw new Error(
        `The sheet “${input.format.sheet}” of ${path.basename(v.file)} is already linked to this project. Review its changes under Files instead, or link another sheet.`,
      );
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO source_files (id, project_id, path, pattern, current_file, format, main_language, fingerprint, size, mtime_ms, last_read_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.pattern ? path.dirname(input.file) : input.file,
          input.pattern,
          v.file,
          JSON.stringify(input.format),
          input.mainLanguage,
          v.fingerprint,
          v.size,
          v.mtimeMs,
          this.now(),
          this.now(),
        );
      this.recordVersion(id, v, {
        added: read.rows.length,
        changed: 0,
        removed: 0,
      });
      for (const row of read.rows)
        this.addTask(
          input.projectId,
          id,
          row,
          input.mainLanguage,
          path.basename(v.file),
        );
    });
    return {
      source: this.get(id),
      added: read.rows.length,
      skipped: read.skipped.length,
    };
  }

  private addTask(
    projectId: string,
    sourceId: string,
    row: ImportedRow,
    mainLanguage: SourceFile['mainLanguage'],
    fileName: string,
  ): void {
    const project = this.store.getProject(projectId);
    const language = detectLanguage(
      row.title,
      project.originalLanguages,
      mainLanguage,
    );
    const translationState = translationStateFor(
      { language, titleTranslation: '', translationState: 'Not translated' },
      project.workingLanguage,
    );
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, customer_id, source, language, title_original, description_original,
           translation_state, status, priority, assignee, category, remarks, planned_start, planned_end, actual_start,
           actual_end, source_file_id, sheet_row, file_state, status_word, priority_word, extra, file_row, created_at, updated_at)
         VALUES (?, ?, ?, 'file', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_file', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        row.customerId,
        language,
        row.title,
        row.description,
        translationState,
        row.status,
        row.priority,
        row.assignee,
        row.category,
        row.remarks,
        row.plannedStart,
        row.plannedEnd,
        row.actualStart,
        row.actualEnd,
        sourceId,
        row.row,
        row.statusWord,
        row.priorityWord,
        JSON.stringify(row.extra),
        JSON.stringify(row),
        this.now(),
        this.now(),
      );
    this.store.log(id, 'Import', `Read from ${fileName}, row ${row.row}.`);
  }

  /** The tasks of a source with the rows they were last read as. */
  /** Whether the owner deleted the task of this row: same ID, or same title for rows without one. */
  private wasDeleted(sourceId: string, r: ImportedRow): boolean {
    const row = (
      r.customerId
        ? this.db
            .prepare(
              'SELECT 1 FROM deleted_rows WHERE source_id = ? AND customer_id = ?',
            )
            .get(sourceId, r.customerId)
        : this.db
            .prepare(
              "SELECT 1 FROM deleted_rows WHERE source_id = ? AND customer_id = '' AND title = ?",
            )
            .get(sourceId, r.title)
    ) as Row | undefined;
    return !!row;
  }

  private baseline(sourceId: string): {
    rows: ImportedRow[];
    taskOf: Map<ImportedRow, Task>;
  } {
    const ids = this.db
      .prepare(
        'SELECT id, file_row FROM tasks WHERE source_file_id = ? AND file_row IS NOT NULL',
      )
      .all(sourceId) as Row[];
    const rows: ImportedRow[] = [];
    const taskOf = new Map<ImportedRow, Task>();
    for (const r of ids) {
      const row = JSON.parse(str(r.file_row)) as ImportedRow;
      rows.push(row);
      taskOf.set(row, this.store.getTask(str(r.id)));
    }
    return { rows, taskOf };
  }

  /** Compares a new version of the file with what the app last read from it. */
  review(sourceId: string, v: ReadVersion, byTitle = false): Review {
    const source = this.get(sourceId);
    const read = readRows(v.grid, source.format, v.readDay);
    const { rows, taskOf } = this.baseline(sourceId);
    // Rows already marked removed only come back if they reappear in the file.
    const active = rows.filter((r) => taskOf.get(r)!.fileState === 'in_file');
    const removedBefore = rows.filter(
      (r) => taskOf.get(r)!.fileState === 'removed',
    );
    const c = compareVersions(
      [...active, ...removedBefore],
      read.rows,
      byTitle,
    );
    return {
      sourceId,
      fileName: path.basename(v.file),
      modifiedAt: new Date(v.mtimeMs).toISOString(),
      added: c.added,
      deletedRows: c.added
        .filter((r) => this.wasDeleted(sourceId, r))
        .map((r) => r.row),
      changed: c.changed
        .map(({ before, after, changes }) => {
          const t = taskOf.get(before)!;
          const list: ReviewChange[] = changes.map((ch) => {
            const a = appValue(t, ch.field, before);
            return { ...ch, conflict: a.changed, appValue: a.value };
          });
          if (t.fileState === 'removed')
            list.unshift({
              field: 'extra:Back in the file',
              from: 'Removed',
              to: `Row ${after.row}`,
              conflict: false,
              appValue: '',
            });
          return {
            taskId: t.id,
            customerId: t.customerId,
            title: t.titleTranslation || t.titleOriginal,
            changes: list,
          };
        })
        .concat(
          // Removed rows that came back unchanged still need to return to the file.
          c.unchangedPairs
            .filter(({ before }) => taskOf.get(before)!.fileState === 'removed')
            .map(({ before, after }) => {
              const t = taskOf.get(before)!;
              return {
                taskId: t.id,
                customerId: t.customerId,
                title: t.titleTranslation || t.titleOriginal,
                changes: [
                  {
                    field: 'extra:Back in the file',
                    from: 'Removed',
                    to: `Row ${after.row}`,
                    conflict: false,
                    appValue: '',
                  },
                ],
              };
            }),
        ),
      removed: c.removed
        .filter((r) => taskOf.get(r)!.fileState === 'in_file')
        .map((r) => {
          const t = taskOf.get(r)!;
          return {
            taskId: t.id,
            customerId: t.customerId,
            title: t.titleTranslation || t.titleOriginal,
          };
        }),
      skipped: read.skipped,
      unmappedStatus: read.unmappedStatus,
      unmappedPriority: read.unmappedPriority,
      looksRenumbered: c.looksRenumbered,
      byTitle,
    };
  }

  /** Applies the changes the owner selected. Nothing else changes (spec 04). */
  apply(
    sourceId: string,
    v: ReadVersion,
    sel: ApplySelection,
  ): { added: number; changed: number; removed: number } {
    const source = this.get(sourceId);
    const read = readRows(v.grid, source.format, v.readDay);
    if (read.unmappedStatus.length || read.unmappedPriority.length)
      throw new Error('Map the new values first.');
    const { rows, taskOf } = this.baseline(sourceId);
    const c = compareVersions(rows, read.rows, sel.byTitle);
    const fileName = path.basename(v.file);
    const chosen = new Map(
      sel.change.map((x) => [x.taskId, new Set(x.keepMine)]),
    );
    let added = 0;
    let changed = 0;
    let removed = 0;
    const joins = new Map((sel.join ?? []).map((j) => [j.row, j.taskId]));
    const joined = new Set(joins.values());
    if (joined.size !== joins.size)
      throw new Error('Join each task to one row only.');
    this.tx(() => {
      for (const r of c.added) {
        const joinTo = joins.get(r.row);
        if (joinTo) {
          const before = rows.find((x) => taskOf.get(x)!.id === joinTo);
          const t = before && taskOf.get(before);
          const free =
            t &&
            (t.fileState === 'removed' ||
              c.removed.some((x) => taskOf.get(x)!.id === t.id));
          if (!before || !t || !free)
            throw new Error(
              'A row can only be joined to a task of this file that is no longer in it.',
            );
          // The file's values, except fields the owner changed and has not written yet.
          const changes = rowChanges(before, r).filter(
            (ch) => !appValue(t, ch.field, before).changed,
          );
          this.applyRow(t, r, changes, fileName);
          if (r.customerId !== t.customerId)
            this.db
              .prepare('UPDATE tasks SET customer_id = ? WHERE id = ?')
              .run(r.customerId, t.id);
          this.store.log(
            t.id,
            'Import',
            `Joined by hand to row ${r.row} of ${fileName}${r.customerId !== t.customerId ? `, No. ${t.customerId || '(none)'} → ${r.customerId || '(none)'}` : ''}.`,
          );
          changed++;
          continue;
        }
        if (!sel.addRows.includes(r.row)) continue;
        // Brought back by the owner: no longer a deleted row.
        this.db
          .prepare(
            "DELETE FROM deleted_rows WHERE source_id = ? AND customer_id = ? AND (customer_id <> '' OR title = ?)",
          )
          .run(sourceId, r.customerId, r.title);
        this.addTask(
          source.projectId,
          sourceId,
          r,
          source.mainLanguage,
          fileName,
        );
        added++;
      }
      const pairs = [
        ...c.changed,
        ...c.unchangedPairs.map((p) => ({ ...p, changes: [] })),
      ];
      for (const { before, after, changes } of pairs) {
        const t = taskOf.get(before)!;
        const keep = chosen.get(t.id);
        if (!keep) continue;
        this.applyRow(
          t,
          after,
          changes.filter((x) => !keep.has(x.field)),
          fileName,
        );
        changed++;
      }
      for (const r of c.removed) {
        const t = taskOf.get(r)!;
        if (
          !sel.removeTaskIds.includes(t.id) ||
          t.fileState !== 'in_file' ||
          joined.has(t.id)
        )
          continue;
        this.db
          .prepare(
            "UPDATE tasks SET file_state = 'removed', updated_at = ? WHERE id = ?",
          )
          .run(this.now(), t.id);
        this.store.log(
          t.id,
          'Import',
          `No longer in ${fileName}. The task is kept with its history.`,
        );
        removed++;
      }
      this.recordVersion(sourceId, v, { added, changed, removed });
    });
    return { added, changed, removed };
  }

  /** Writes the file's new values into a task, except the fields the owner keeps. */
  private applyRow(
    t: Task,
    row: ImportedRow,
    changes: FieldChange[],
    fileName: string,
  ): void {
    const fields = changes.map((c) => c.field as string);
    const f = new Set(fields);
    const pick = <T>(field: string, fileValue: T, appVal: T): T =>
      f.has(field) ? fileValue : appVal;
    const titleChanged = f.has('title') || f.has('description');
    const project = this.store.getProject(t.projectId);
    // A new title may be in another language, such as an ID that needs no translation.
    const language =
      f.has('title') && !t.languageSet
        ? detectLanguage(
            row.title,
            project.originalLanguages,
            t.sourceFileId ? this.get(t.sourceFileId).mainLanguage : undefined,
          )
        : t.language;
    const translationState =
      language === project.workingLanguage
        ? 'Not needed'
        : titleChanged && t.translationState === 'Translated'
          ? 'Needs review'
          : translationStateFor({ ...t, language }, project.workingLanguage);
    const extra = Object.fromEntries(
      Object.keys({ ...t.extra, ...row.extra })
        .filter((k) =>
          f.has(`extra:${k}`)
            ? row.extra[k] !== undefined
            : t.extra[k] !== undefined,
        )
        .map((k) => [k, f.has(`extra:${k}`) ? row.extra[k] : t.extra[k]]),
    );
    this.db
      .prepare(
        `UPDATE tasks SET language = ?, title_original = ?, description_original = ?, assignee = ?, planned_start = ?, planned_end = ?,
           actual_start = ?, actual_end = ?, status = ?, status_word = ?, priority = ?, priority_word = ?, category = ?,
           remarks = ?, extra = ?, translation_state = ?, sheet_row = ?, file_state = 'in_file', file_row = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        language,
        pick('title', row.title, t.titleOriginal),
        pick('description', row.description, t.descriptionOriginal),
        pick('assignee', row.assignee, t.assignee),
        pick('plannedStart', row.plannedStart, t.plannedStart),
        pick('plannedEnd', row.plannedEnd, t.plannedEnd),
        pick('actualStart', row.actualStart, t.actualStart),
        pick('actualEnd', row.actualEnd, t.actualEnd),
        pick('statusWord', row.status, t.status),
        pick('statusWord', row.statusWord, t.statusWord),
        pick('priorityWord', row.priority, t.priority),
        pick('priorityWord', row.priorityWord, t.priorityWord),
        pick('category', row.category, t.category),
        pick('remarks', row.remarks, t.remarks),
        JSON.stringify(extra),
        translationState,
        row.row,
        JSON.stringify(row),
        this.now(),
        t.id,
      );
    const parts = changes.map(
      (c) =>
        `${changeLabel(c.field)} ${c.from || '(empty)'} → ${c.to || '(empty)'}`,
    );
    if (t.fileState === 'removed') parts.unshift('Back in the file');
    this.store.log(
      t.id,
      'Import',
      parts.length
        ? `From ${fileName}: ${parts.join('; ')}.`
        : `Matched in ${fileName}, row ${row.row}.`,
    );
  }
}
