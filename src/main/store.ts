import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  DATE_FORMATS,
  DEFAULT_VIEWS,
  STATUSES,
  EMPTY_SITUATION,
  LANGUAGES,
  LEVEL_NAME,
  detectLanguage,
  linkKind,
  personKey,
  translationStateFor,
  type ActivityEntry,
  type AiResult,
  type BulkChange,
  type DateFormat,
  type GlossaryTerm,
  type Person,
  type ImportSummary,
  type Level,
  type Project,
  type ProjectInput,
  type SituationInput,
  type TableSettings,
  type Status,
  type Task,
  type TaskInput,
  type TaskLink,
  type ViewKey,
} from '../shared/model';
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/settings';
import type { OwnerTranslation } from '../shared/ownerBatch';
import { cleanBoard, type BoardSettings } from '../shared/board';

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? '' : String(v));
const opt = (v: unknown): string | null =>
  v == null || v === '' ? null : String(v);

/** Field names as the owner sees them, for history entries. */
const FIELD_LABELS: Partial<Record<keyof TaskInput, string>> = {
  customerId: 'No.',
  titleOriginal: 'Original title',
  titleTranslation: 'Title translation',
  descriptionOriginal: 'Original description',
  descriptionTranslation: 'Description translation',
  summary: 'Summary',
  notes: 'Notes',
  status: 'Status',
  priority: 'Priority',
  labels: 'Labels',
  assignee: 'Assignee',
  category: 'Category',
  remarks: 'Remarks',
  plannedStart: 'Planned start',
  plannedEnd: 'Planned end',
  actualStart: 'Actual start',
  actualEnd: 'Actual end',
  nextAction: 'Next action',
  nextActionDate: 'Next action date',
};

/**
 * All reads and writes of WorkSync's data. Takes an open database so it can be
 * used from the main process and from tests alike.
 */
export class Store {
  constructor(
    private readonly db: DatabaseSync,
    /** Returns now as an ISO timestamp; replaceable in tests. */
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private today(): string {
    const d = new Date(this.now());
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  private depth = 0;

  /** Runs fn in one transaction. Nested calls join the outer transaction. */
  private tx<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.depth++;
    try {
      return this.txOuter(fn);
    } finally {
      this.depth--;
    }
  }

  private txOuter<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ------------------------------------------------------------ settings

  getSettings(): AppSettings {
    const rows = this.db
      .prepare('SELECT key, value FROM settings')
      .all() as Row[];
    const saved = Object.fromEntries(
      rows.map((r) => [str(r.key), JSON.parse(str(r.value))]),
    );
    return { ...DEFAULT_SETTINGS, ...saved };
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const days = patch.dueSoonDays;
    if (
      days !== undefined &&
      !(Number.isInteger(days) && days >= 1 && days <= 60)
    )
      throw new Error('Due soon must be between 1 and 60 days.');
    if (
      patch.theme !== undefined &&
      !['system', 'light', 'dark'].includes(patch.theme)
    )
      throw new Error('Choose System, Light or Dark.');
    if (
      patch.uiLanguage !== undefined &&
      !['system', 'en', 'ja'].includes(patch.uiLanguage)
    )
      throw new Error('Choose the app language from the list.');
    this.tx(() => {
      const put = this.db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      );
      for (const [k, v] of Object.entries(patch))
        if (k in DEFAULT_SETTINGS && v !== undefined)
          put.run(k, JSON.stringify(v));
    });
    return this.getSettings();
  }

  // ------------------------------------------------------------ projects

  private toProject(r: Row): Project {
    return {
      id: str(r.id),
      name: str(r.name),
      customer: str(r.customer),
      originalLanguages: JSON.parse(str(r.original_languages)),
      workingLanguage: str(r.working_language) as Project['workingLanguage'],
      views: { ...DEFAULT_VIEWS, ...JSON.parse(str(r.views)), focus: true },
      dueSoonDays: Number(r.due_soon_days),
      publishFolder: r.publish_folder == null ? null : str(r.publish_folder),
      publishNotes: Number(r.publish_notes) === 1,
      publishOnClose: Number(r.publish_on_close) === 1,
      board: cleanBoard(r.board ? JSON.parse(str(r.board)) : null),
      showNumbers: Number(r.show_numbers ?? 1) === 1,
      dateFormat: (DATE_FORMATS as readonly string[]).includes(
        str(r.date_format),
      )
        ? (str(r.date_format) as DateFormat)
        : 'YYYY/MM/DD',
      tableSettings: r.table_settings
        ? (JSON.parse(str(r.table_settings)) as TableSettings)
        : null,
      createdAt: str(r.created_at),
    };
  }

  listProjects(): Project[] {
    return (
      this.db
        .prepare('SELECT * FROM projects ORDER BY created_at, name')
        .all() as Row[]
    ).map((r) => this.toProject(r));
  }

  getProject(id: string): Project {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | Row
      | undefined;
    if (!r) throw new Error(`Project ${id} not found`);
    return this.toProject(r);
  }

  createProject(input: ProjectInput): Project {
    const name = input.name.trim();
    if (!name) throw new Error('A project needs a name.');
    if (!input.originalLanguages.length)
      throw new Error('Choose at least one original language.');
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO projects (id, name, customer, original_languages, working_language, views, due_soon_days, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        input.customer.trim(),
        JSON.stringify(input.originalLanguages),
        input.workingLanguage,
        JSON.stringify(DEFAULT_VIEWS),
        this.getSettings().dueSoonDays,
        this.now(),
      );
    return this.getProject(id);
  }

  updateProject(
    id: string,
    patch: Partial<ProjectInput> & {
      views?: Partial<Record<ViewKey, boolean>>;
      dueSoonDays?: number;
      dateFormat?: DateFormat;
      showNumbers?: boolean;
    },
  ): Project {
    const p = this.getProject(id);
    if (patch.name !== undefined && !patch.name.trim())
      throw new Error('A project needs a name.');
    if (patch.originalLanguages && !patch.originalLanguages.length)
      throw new Error('Choose at least one original language.');
    if (
      patch.dueSoonDays !== undefined &&
      !(
        Number.isInteger(patch.dueSoonDays) &&
        patch.dueSoonDays >= 1 &&
        patch.dueSoonDays <= 60
      )
    )
      throw new Error('Due soon must be between 1 and 60 days.');
    const next = {
      name: patch.name?.trim() || p.name,
      customer: patch.customer?.trim() ?? p.customer,
      originalLanguages: patch.originalLanguages ?? p.originalLanguages,
      workingLanguage: patch.workingLanguage ?? p.workingLanguage,
      views: { ...p.views, ...patch.views, focus: true },
      dueSoonDays: patch.dueSoonDays ?? p.dueSoonDays,
    };
    this.db
      .prepare(
        `UPDATE projects SET name = ?, customer = ?, original_languages = ?, working_language = ?, views = ?, due_soon_days = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.customer,
        JSON.stringify(next.originalLanguages),
        next.workingLanguage,
        JSON.stringify(next.views),
        next.dueSoonDays,
        id,
      );
    if (patch.showNumbers !== undefined)
      this.db
        .prepare('UPDATE projects SET show_numbers = ? WHERE id = ?')
        .run(patch.showNumbers ? 1 : 0, id);
    if (patch.dateFormat && DATE_FORMATS.includes(patch.dateFormat))
      this.db
        .prepare('UPDATE projects SET date_format = ? WHERE id = ?')
        .run(patch.dateFormat, id);
    return this.getProject(id);
  }

  /**
   * Saves the Board's columns. Tasks in an own column that is removed go back
   * to the column of their status.
   */
  setBoard(id: string, board: BoardSettings): Project {
    const b = cleanBoard(board);
    this.getProject(id);
    const names = b.columns.map((c) => c.name.toLowerCase());
    const clash = b.columns.find(
      (c, i) =>
        STATUSES.some((s) => s.toLowerCase() === names[i]) ||
        names.indexOf(names[i]) !== i,
    );
    if (clash)
      throw new Error(
        `There is already a column called ${clash.name}. Choose another name.`,
      );
    this.tx(() => {
      this.db
        .prepare('UPDATE projects SET board = ? WHERE id = ?')
        .run(JSON.stringify(b), id);
      const keep = b.columns.map((c) => c.id);
      const rows = this.db
        .prepare(
          'SELECT id, board_column FROM tasks WHERE project_id = ? AND board_column IS NOT NULL',
        )
        .all(id) as Row[];
      for (const r of rows)
        if (!keep.includes(str(r.board_column)))
          this.db
            .prepare('UPDATE tasks SET board_column = NULL WHERE id = ?')
            .run(str(r.id));
    });
    return this.getProject(id);
  }

  /** Puts a task in one of the Board's own columns, or back in its status column. */
  setBoardColumn(taskId: string, columnId: string | null): Task {
    const t = this.getTask(taskId);
    const col = columnId
      ? this.getProject(t.projectId).board.columns.find(
          (c) => c.id === columnId,
        )
      : null;
    if (columnId && !col)
      throw new Error('That Board column no longer exists.');
    if (col && col.status !== t.status)
      throw new Error(`Set the status to ${col.status} first.`);
    if ((t.boardColumn ?? null) === (columnId ?? null)) return t;
    this.tx(() => {
      this.db
        .prepare(
          'UPDATE tasks SET board_column = ?, updated_at = ? WHERE id = ?',
        )
        .run(columnId, this.now(), taskId);
      if (col)
        this.log(taskId, 'Edit', `Moved to the Board column ${col.name}.`);
    });
    return this.getTask(taskId);
  }

  /** Remembers the Tasks table's columns, sort and filters; null goes back to the defaults. */
  setTableSettings(id: string, settings: TableSettings | null): Project {
    this.getProject(id);
    this.db
      .prepare('UPDATE projects SET table_settings = ? WHERE id = ?')
      .run(settings ? JSON.stringify(settings) : null, id);
    return this.getProject(id);
  }

  /**
   * Deletes a project with everything WorkSync keeps for it: tasks and their
   * history, linked-file records, glossary, people and publish records.
   * Files on disk, such as the customer's file, copies, reports and the
   * published page, are not touched.
   */
  deleteProject(id: string): { tasks: number } {
    const p = this.getProject(id);
    const tasks = Number(
      (
        this.db
          .prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?')
          .get(p.id) as { n: number }
      ).n,
    );
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
    return { tasks };
  }

  // ------------------------------------------------------------ tasks

  private toTask(r: Row): Task {
    const difficulties = (
      this.db
        .prepare(
          'SELECT * FROM difficulties WHERE task_id = ? ORDER BY position, raised_on',
        )
        .all(str(r.id)) as Row[]
    ).map((d) => ({
      id: str(d.id),
      text: str(d.text),
      raisedOn: str(d.raised_on),
      resolver: str(d.resolver),
      open: Number(d.open) === 1,
    }));
    return {
      id: str(r.id),
      projectId: str(r.project_id),
      links: JSON.parse(str(r.links) || '[]'),
      languageSet: Number(r.language_set) === 1,
      boardColumn: opt(r.board_column),
      customerId: str(r.customer_id),
      source: str(r.source) as Task['source'],
      sourceFileId: opt(r.source_file_id),
      sheetRow: r.sheet_row == null ? null : Number(r.sheet_row),
      fileState: (str(r.file_state) || 'hand') as Task['fileState'],
      statusWord: str(r.status_word),
      priorityWord: str(r.priority_word),
      extra: JSON.parse(str(r.extra) || '{}'),
      language: str(r.language) as Task['language'],
      titleOriginal: str(r.title_original),
      titleTranslation: str(r.title_translation),
      descriptionOriginal: str(r.description_original),
      descriptionTranslation: str(r.description_translation),
      translationState: str(r.translation_state) as Task['translationState'],
      summary: str(r.summary),
      notes: str(r.notes),
      status: str(r.status) as Status,
      priority: str(r.priority) as Level,
      priorityOverride: opt(r.priority_override) as Level | null,
      labels: JSON.parse(str(r.labels) || '[]'),
      assignee: str(r.assignee),
      category: str(r.category),
      remarks: str(r.remarks),
      plannedStart: opt(r.planned_start),
      plannedEnd: opt(r.planned_end),
      actualStart: opt(r.actual_start),
      actualEnd: opt(r.actual_end),
      pinned: Number(r.pinned) === 1,
      nextAction: str(r.next_action),
      nextActionDate: opt(r.next_action_date),
      situation: {
        handledBy: str(r.handled_by),
        doingNow: str(r.doing_now),
        nextStep: str(r.next_step),
        nextDate: opt(r.next_date),
        asOf: opt(r.as_of),
      },
      difficulties,
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
    };
  }

  listTasks(): Task[] {
    return (
      this.db.prepare('SELECT * FROM tasks ORDER BY created_at').all() as Row[]
    ).map((r) => this.toTask(r));
  }

  getTask(id: string): Task {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | Row
      | undefined;
    if (!r) throw new Error(`Task ${id} not found`);
    return this.toTask(r);
  }

  private nextCustomerId(projectId: string): string {
    const ids = (
      this.db
        .prepare('SELECT customer_id FROM tasks WHERE project_id = ?')
        .all(projectId) as Row[]
    ).map((r) => str(r.customer_id));
    const numeric = ids.filter((x) => /^\d+$/.test(x));
    const max = Math.max(0, ...numeric.map(Number));
    // New numbers look like the project's: zero-padded only if its numbers are.
    const padded = numeric.filter((x) => x.length > 1 && x.startsWith('0'));
    const width = numeric.length
      ? padded.length
        ? Math.max(...padded.map((x) => x.length))
        : 1
      : 3;
    return String(max + 1).padStart(width, '0');
  }

  private clean(input: TaskInput): TaskInput {
    const title = input.titleOriginal.trim();
    if (!title) throw new Error('A task needs a title.');
    const labels = [
      ...new Set(input.labels.map((l) => l.trim()).filter(Boolean)),
    ];
    return { ...input, titleOriginal: title, labels };
  }

  /** Dates the owner sets must be in order: an end is never before its start. */
  private checkDates(
    t: Pick<
      TaskInput,
      'plannedStart' | 'plannedEnd' | 'actualStart' | 'actualEnd'
    >,
  ) {
    if (t.plannedStart && t.plannedEnd && t.plannedEnd < t.plannedStart)
      throw new Error('The planned end is before the planned start.');
    if (t.actualStart && t.actualEnd && t.actualEnd < t.actualStart)
      throw new Error('The actual end is before the actual start.');
  }

  /** A number may belong to one task of the project only. */
  private checkNumber(projectId: string, customerId: string, self?: string) {
    const n = customerId.trim();
    if (!n) return;
    const other = this.db
      .prepare(
        'SELECT customer_id FROM tasks WHERE project_id = ? AND customer_id = ? AND id IS NOT ?',
      )
      .get(projectId, n, self ?? null) as Row | undefined;
    if (other)
      throw new Error(
        `No. ${n} is already used by another task in this project. Choose another number, or leave it empty for the next one.`,
      );
  }

  createTask(projectId: string, raw: TaskInput): Task {
    const project = this.getProject(projectId);
    const input = this.clean(raw);
    this.checkDates(input);
    this.checkNumber(projectId, input.customerId);
    const id = randomUUID();
    const now = this.now();
    const language =
      input.language ??
      detectLanguage(input.titleOriginal, project.originalLanguages);
    const translationState = translationStateFor(
      {
        language,
        titleTranslation: input.titleTranslation,
        translationState: 'Translated',
      },
      project.workingLanguage,
    );
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO tasks (id, project_id, customer_id, source, language, title_original, title_translation,
             description_original, description_translation, translation_state, summary, notes, status, priority,
             labels, assignee, category, remarks, planned_start, planned_end, actual_start, actual_end,
             next_action, next_action_date, created_at, updated_at)
           VALUES (?, ?, ?, 'hand', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          projectId,
          input.customerId.trim() || this.nextCustomerId(projectId),
          language,
          input.titleOriginal,
          input.titleTranslation.trim(),
          input.descriptionOriginal,
          input.descriptionTranslation,
          translationState,
          input.summary.trim(),
          input.notes,
          input.status,
          input.priority,
          JSON.stringify(input.labels),
          input.assignee.trim(),
          input.category.trim(),
          input.remarks,
          input.plannedStart,
          input.plannedEnd,
          input.actualStart,
          input.actualEnd,
          input.nextAction.trim(),
          input.nextActionDate,
          now,
          now,
        );
      this.log(id, 'Created', 'Added by hand.');
    });
    return this.getTask(id);
  }

  /** Changes task fields and records which ones changed in the history. */
  updateTask(id: string, patch: Partial<TaskInput>): Task {
    const before = this.getTask(id);
    const project = this.getProject(before.projectId);
    // The ID and the customer's own text of a task from a file change only with the file.
    if (before.source === 'file') {
      // The title may be edited; a later change from the file is then shown as a conflict to choose.
      for (const k of ['customerId', 'descriptionOriginal'] as const)
        if (patch[k] !== undefined && patch[k] !== before[k])
          throw new Error(
            'The No. and description come from the customer’s file. They change when the file does.',
          );
    }
    const merged = this.clean({ ...before, ...patch });
    // A task added by hand that becomes Done gets today as its actual end, unless one is set.
    // Tasks from a file are left alone, since their dates go to the customer's file.
    if (
      before.source !== 'file' &&
      patch.status === 'Done' &&
      before.status !== 'Done' &&
      !merged.actualEnd &&
      // The form sends every field; only a date the owner typed now counts as theirs.
      (patch.actualEnd ?? null) === (before.actualEnd ?? null)
    ) {
      merged.actualEnd = this.today();
      if (merged.actualStart && merged.actualStart > merged.actualEnd)
        merged.actualStart = merged.actualEnd;
    }
    // Only what the owner changes is checked, so a file with odd dates still imports.
    if (
      (
        ['plannedStart', 'plannedEnd', 'actualStart', 'actualEnd'] as const
      ).some((k) => k in patch && patch[k] !== before[k])
    )
      this.checkDates(merged);
    if (
      patch.customerId !== undefined &&
      patch.customerId.trim() !== before.customerId
    )
      this.checkNumber(before.projectId, patch.customerId, id);
    // The owner's choice wins; otherwise a new title, or going back to Detect, detects again.
    const languageSet = patch.languageSet ?? before.languageSet;
    const language =
      (languageSet ? patch.language : undefined) ??
      (patch.languageSet === false ||
      (!languageSet &&
        patch.titleOriginal !== undefined &&
        patch.titleOriginal !== before.titleOriginal)
        ? detectLanguage(merged.titleOriginal, project.originalLanguages)
        : before.language);
    const changed = (Object.keys(FIELD_LABELS) as (keyof TaskInput)[]).filter(
      (k) =>
        k in patch &&
        JSON.stringify(before[k as keyof Task]) !== JSON.stringify(merged[k]),
    );
    if (
      !changed.length &&
      language === before.language &&
      languageSet === before.languageSet
    )
      return before;
    const translationState = translationStateFor(
      {
        language,
        titleTranslation: merged.titleTranslation,
        translationState: before.translationState,
      },
      project.workingLanguage,
    );
    this.tx(() => {
      this.db
        .prepare(
          `UPDATE tasks SET customer_id = ?, language = ?, language_set = ?, title_original = ?, title_translation = ?,
             description_original = ?, description_translation = ?, translation_state = ?, summary = ?, notes = ?,
             status = ?, priority = ?, labels = ?, assignee = ?, category = ?, remarks = ?, planned_start = ?,
             planned_end = ?, actual_start = ?, actual_end = ?, next_action = ?, next_action_date = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          merged.customerId.trim() || before.customerId,
          language,
          languageSet ? 1 : 0,
          merged.titleOriginal,
          merged.titleTranslation.trim(),
          merged.descriptionOriginal,
          merged.descriptionTranslation,
          translationState,
          merged.summary.trim(),
          merged.notes,
          merged.status,
          merged.priority,
          JSON.stringify(merged.labels),
          merged.assignee.trim(),
          merged.category.trim(),
          merged.remarks,
          merged.plannedStart,
          merged.plannedEnd,
          merged.actualStart,
          merged.actualEnd,
          merged.nextAction.trim(),
          merged.nextActionDate,
          this.now(),
          id,
        );
      if (language !== before.language)
        this.log(
          id,
          'Edit',
          `Language ${LANGUAGES[before.language]} → ${LANGUAGES[language]}${languageSet ? ', chosen by you' : ''}.`,
        );
      if (changed.includes('status') && changed.length === 1) {
        this.log(id, 'Edit', `Status ${before.status} → ${merged.status}.`);
      } else if (changed.includes('priority') && changed.length === 1) {
        this.log(
          id,
          'Edit',
          `Priority ${LEVEL_NAME[before.priority]} → ${LEVEL_NAME[merged.priority]}.`,
        );
      } else if (changed.length) {
        this.log(
          id,
          'Edit',
          `Changed ${changed.map((k) => FIELD_LABELS[k]).join(', ')}.`,
        );
      }
    });
    return this.getTask(id);
  }

  /** Replaces the task's links; each must be a web address or a file path. */
  setLinks(id: string, links: TaskLink[]): Task {
    const clean = links
      .map((l) => ({ name: l.name.trim(), target: l.target.trim() }))
      .filter((l) => l.target);
    for (const l of clean)
      if (!linkKind(l.target))
        throw new Error(
          `${l.target} is not a web address or a file path. Use one such as https://… or \\\\server\\share\\spec.xlsx.`,
        );
    const before = this.getTask(id);
    this.tx(() => {
      this.db
        .prepare('UPDATE tasks SET links = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(clean), this.now(), id);
      const added = clean.filter(
        (l) => !before.links.some((b) => b.target === l.target),
      );
      const gone = before.links.filter(
        (b) => !clean.some((l) => l.target === b.target),
      );
      if (added.length || gone.length)
        this.log(
          id,
          'Edit',
          [
            added.length &&
              `Added link ${added.map((l) => l.name || l.target).join(', ')}.`,
            gone.length &&
              `Removed link ${gone.map((l) => l.name || l.target).join(', ')}.`,
          ]
            .filter(Boolean)
            .join(' '),
        );
    });
    return this.getTask(id);
  }

  /** Sets or clears the owner's override. Equal to the task's own level means no override. */
  setPriorityOverride(id: string, level: Level | null): Task {
    const t = this.getTask(id);
    const next = level === t.priority ? null : level;
    if (next === t.priorityOverride) return t;
    this.tx(() => {
      this.db
        .prepare(
          'UPDATE tasks SET priority_override = ?, updated_at = ? WHERE id = ?',
        )
        .run(next, this.now(), id);
      this.log(
        id,
        'Priority override',
        next
          ? `Set to ${LEVEL_NAME[next]} for you. The task's own level is ${LEVEL_NAME[t.priority]}.`
          : 'Removed.',
      );
    });
    return this.getTask(id);
  }

  setPinned(id: string, pinned: boolean): Task {
    this.db
      .prepare('UPDATE tasks SET pinned = ?, updated_at = ? WHERE id = ?')
      .run(pinned ? 1 : 0, this.now(), id);
    return this.getTask(id);
  }

  /**
   * Applies one change to several tasks in one transaction (the Tasks table's
   * bulk actions). Each task records the change in its own history.
   * Priority is not among them: it changes one task at a time (spec 03).
   */
  bulkUpdate(ids: string[], change: BulkChange): Task[] {
    const addLabel = change.addLabel?.trim();
    const removeLabel = change.removeLabel?.trim();
    return this.tx(() =>
      ids.map((id) => {
        let t = this.getTask(id);
        const labels = t.labels.filter(
          (l) => !removeLabel || l.toLowerCase() !== removeLabel.toLowerCase(),
        );
        if (
          addLabel &&
          !labels.some((l) => l.toLowerCase() === addLabel.toLowerCase())
        )
          labels.push(addLabel);
        const patch: Partial<TaskInput> = {};
        if (JSON.stringify(labels) !== JSON.stringify(t.labels))
          patch.labels = labels;
        if (change.status && change.status !== t.status)
          patch.status = change.status;
        if (Object.keys(patch).length) t = this.updateTask(id, patch);
        if (change.pinned !== undefined && change.pinned !== t.pinned)
          t = this.setPinned(id, change.pinned);
        return t;
      }),
    );
  }

  /**
   * Adds a situation update. Parts left out carry over from the current
   * situation, and As of becomes today.
   */
  addSituationUpdate(id: string, input: SituationInput): Task {
    const t = this.getTask(id);
    const s = { ...EMPTY_SITUATION, ...t.situation };
    const next = {
      handledBy: input.handledBy?.trim() ?? s.handledBy,
      doingNow: input.doingNow?.trim() ?? s.doingNow,
      // Waiting on is no longer asked; the column stays for old data.
      waitingOn: 'Nobody',
      nextStep: input.nextStep?.trim() ?? s.nextStep,
      nextDate: input.nextDate === undefined ? s.nextDate : input.nextDate,
      asOf: this.today(),
    };
    this.tx(() => {
      this.db
        .prepare(
          `UPDATE tasks SET handled_by = ?, doing_now = ?, waiting_on = ?, next_step = ?, next_date = ?, as_of = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          next.handledBy,
          next.doingNow,
          next.waitingOn,
          next.nextStep,
          next.nextDate,
          next.asOf,
          this.now(),
          id,
        );
      this.db
        .prepare(
          `INSERT INTO situation_updates (id, task_id, at, handled_by, doing_now, waiting_on, next_step, next_date, as_of)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          id,
          this.now(),
          next.handledBy,
          next.doingNow,
          next.waitingOn,
          next.nextStep,
          next.nextDate,
          next.asOf,
        );
      const parts = [
        next.doingNow && `Doing now: ${next.doingNow}.`,
        next.nextStep &&
          `Next: ${next.nextStep}${next.nextDate ? ` by ${next.nextDate.replaceAll('-', '/')}` : ''}.`,
      ].filter(Boolean);
      if (input.newDifficulty?.text.trim()) {
        const position = t.difficulties.length;
        this.db
          .prepare(
            'INSERT INTO difficulties (id, task_id, text, raised_on, resolver, open, position) VALUES (?, ?, ?, ?, ?, 1, ?)',
          )
          .run(
            randomUUID(),
            id,
            input.newDifficulty.text.trim(),
            this.today(),
            input.newDifficulty.resolver.trim(),
            position,
          );
        parts.push(`New difficulty: ${input.newDifficulty.text.trim()}.`);
      }
      this.log(
        id,
        'Situation update',
        parts.join(' ') || 'Confirmed the situation.',
      );
    });
    return this.getTask(id);
  }

  setDifficultyOpen(taskId: string, difficultyId: string, open: boolean): Task {
    const t = this.getTask(taskId);
    const d = t.difficulties.find((x) => x.id === difficultyId);
    if (!d || d.open === open) return t;
    this.tx(() => {
      this.db
        .prepare('UPDATE difficulties SET open = ? WHERE id = ?')
        .run(open ? 1 : 0, difficultyId);
      this.db
        .prepare('UPDATE tasks SET updated_at = ? WHERE id = ?')
        .run(this.now(), taskId);
      this.log(
        taskId,
        'Difficulty',
        `${open ? 'Reopened' : 'Resolved'}: ${d.text}.`,
      );
    });
    return this.getTask(taskId);
  }

  /**
   * Fixes a mistake in the current situation. Unlike an update, it changes the
   * newest update in place: As of stays, and no new update is added.
   */
  correctSituation(
    id: string,
    input: Omit<SituationInput, 'newDifficulty'>,
  ): Task {
    const t = this.getTask(id);
    const s = t.situation;
    if (!s.asOf)
      throw new Error('This task has no situation yet. Use Update situation.');
    const next = {
      handledBy: input.handledBy?.trim() ?? s.handledBy,
      doingNow: input.doingNow?.trim() ?? s.doingNow,
      // Waiting on is no longer asked; the column stays for old data.
      waitingOn: 'Nobody',
      nextStep: input.nextStep?.trim() ?? s.nextStep,
      nextDate: input.nextDate === undefined ? s.nextDate : input.nextDate,
    };
    const names: [Exclude<keyof typeof next, 'waitingOn'>, string][] = [
      ['handledBy', 'Handled by'],
      ['doingNow', 'Doing now'],
      ['nextStep', 'Next step'],
      ['nextDate', 'Expected date'],
    ];
    const changed = names.filter(([k]) => (next[k] ?? null) !== (s[k] ?? null));
    if (!changed.length) return t;
    this.tx(() => {
      this.db
        .prepare(
          'UPDATE tasks SET handled_by = ?, doing_now = ?, waiting_on = ?, next_step = ?, next_date = ?, updated_at = ? WHERE id = ?',
        )
        .run(
          next.handledBy,
          next.doingNow,
          next.waitingOn,
          next.nextStep,
          next.nextDate,
          this.now(),
          id,
        );
      const newest = this.db
        .prepare(
          'SELECT id FROM situation_updates WHERE task_id = ? ORDER BY at DESC LIMIT 1',
        )
        .get(id) as Row | undefined;
      if (newest)
        this.db
          .prepare(
            'UPDATE situation_updates SET handled_by = ?, doing_now = ?, waiting_on = ?, next_step = ?, next_date = ? WHERE id = ?',
          )
          .run(
            next.handledBy,
            next.doingNow,
            next.waitingOn,
            next.nextStep,
            next.nextDate,
            str(newest.id),
          );
      this.log(
        id,
        'Situation update',
        `Corrected ${changed.map(([, n]) => n.toLowerCase()).join(', ')}.`,
      );
    });
    return this.getTask(id);
  }

  /** Fixes the wording of a difficulty, or who can resolve it. */
  editDifficulty(
    taskId: string,
    difficultyId: string,
    input: { text: string; resolver: string },
  ): Task {
    const t = this.getTask(taskId);
    const d = t.difficulties.find((x) => x.id === difficultyId);
    if (!d) throw new Error('This difficulty was not found.');
    const text = input.text.trim();
    const resolver = input.resolver.trim();
    if (!text)
      throw new Error('A difficulty needs some text. To remove it, delete it.');
    if (text === d.text && resolver === d.resolver) return t;
    this.tx(() => {
      this.db
        .prepare('UPDATE difficulties SET text = ?, resolver = ? WHERE id = ?')
        .run(text, resolver, difficultyId);
      this.db
        .prepare('UPDATE tasks SET updated_at = ? WHERE id = ?')
        .run(this.now(), taskId);
      this.log(
        taskId,
        'Difficulty',
        text === d.text
          ? `Changed who can resolve: ${text}.`
          : `Corrected: ${d.text} → ${text}.`,
      );
    });
    return this.getTask(taskId);
  }

  /** Removes a difficulty written by mistake, with its translations. */
  deleteDifficulty(taskId: string, difficultyId: string): Task {
    const t = this.getTask(taskId);
    const d = t.difficulties.find((x) => x.id === difficultyId);
    if (!d) return t;
    this.tx(() => {
      this.db
        .prepare('DELETE FROM difficulties WHERE id = ?')
        .run(difficultyId);
      this.db
        .prepare(
          'DELETE FROM owner_translations WHERE task_id = ? AND field = ?',
        )
        .run(taskId, `difficulty:${difficultyId}`);
      this.db
        .prepare('UPDATE tasks SET updated_at = ? WHERE id = ?')
        .run(this.now(), taskId);
      this.log(taskId, 'Difficulty', `Deleted: ${d.text}.`);
    });
    return this.getTask(taskId);
  }

  deleteTask(id: string): void {
    const t = this.getTask(id);
    this.tx(() => {
      // A task from a file is still in the file; remember it so a review leaves it out unless asked.
      if (t.sourceFileId && t.fileState === 'in_file')
        this.db
          .prepare(
            'INSERT OR REPLACE INTO deleted_rows (source_id, customer_id, title, at) VALUES (?, ?, ?, ?)',
          )
          .run(t.sourceFileId, t.customerId, t.titleOriginal, this.now());
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    });
  }

  // ------------------------------------------------------------ history

  /** Adds a history entry. The app never edits entries afterwards. */
  log(taskId: string, kind: string, text: string): void {
    this.db
      .prepare(
        'INSERT INTO activity (id, task_id, at, kind, text) VALUES (?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), taskId, this.now(), kind, text);
  }

  addNote(taskId: string, text: string): void {
    if (!text.trim()) throw new Error('The entry is empty.');
    this.log(taskId, 'Note', text.trim());
  }

  listActivity(taskId: string): ActivityEntry[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM activity WHERE task_id = ? ORDER BY at DESC, rowid DESC',
        )
        .all(taskId) as Row[]
    ).map((r) => ({
      id: str(r.id),
      taskId: str(r.task_id),
      at: str(r.at),
      kind: str(r.kind),
      text: str(r.text),
    }));
  }

  // ------------------------------------------------------------ glossary

  listGlossary(projectId?: string): GlossaryTerm[] {
    const rows = (
      projectId
        ? this.db
            .prepare(
              'SELECT * FROM glossary_terms WHERE project_id = ? ORDER BY term',
            )
            .all(projectId)
        : this.db.prepare('SELECT * FROM glossary_terms ORDER BY term').all()
    ) as Row[];
    return rows.map((r) => ({
      id: str(r.id),
      projectId: str(r.project_id),
      term: str(r.term),
      translation: str(r.translation),
      language: str(r.language) as GlossaryTerm['language'],
      note: str(r.note),
    }));
  }

  saveGlossaryTerm(
    input: Omit<GlossaryTerm, 'id'> & { id?: string },
  ): GlossaryTerm {
    const term = input.term.trim();
    const translation = input.translation.trim();
    if (!term || !translation)
      throw new Error('A glossary entry needs the term and its translation.');
    const project = this.getProject(input.projectId);
    const same = this.listGlossary(input.projectId).find(
      (g) => g.id !== input.id && personKey(g.term) === personKey(term),
    );
    if (same)
      throw new Error(
        `${same.term} is already in the glossary as “${same.translation}”. Change that entry instead, so the term has one translation.`,
      );
    const language =
      input.language ?? detectLanguage(term, project.originalLanguages);
    const id = input.id ?? randomUUID();
    if (input.id) {
      this.db
        .prepare(
          'UPDATE glossary_terms SET term = ?, translation = ?, language = ?, note = ? WHERE id = ?',
        )
        .run(term, translation, language, input.note.trim(), id);
    } else {
      this.db
        .prepare(
          'INSERT INTO glossary_terms (id, project_id, term, translation, language, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          input.projectId,
          term,
          translation,
          language,
          input.note.trim(),
          this.now(),
        );
    }
    return this.listGlossary(input.projectId).find((g) => g.id === id)!;
  }

  deleteGlossaryTerm(id: string): void {
    this.db.prepare('DELETE FROM glossary_terms WHERE id = ?').run(id);
  }

  // ------------------------------------------------------------ owner translations

  /** The owner's texts translated into a file language, for reports and briefs. */
  listOwnerTranslations(projectId: string): OwnerTranslation[] {
    return (
      this.db
        .prepare(
          `SELECT o.* FROM owner_translations o JOIN tasks t ON t.id = o.task_id WHERE t.project_id = ?`,
        )
        .all(projectId) as Row[]
    ).map((r) => ({
      taskId: str(r.task_id),
      field: str(r.field),
      language: str(r.language) as OwnerTranslation['language'],
      source: str(r.source),
      text: str(r.text),
    }));
  }

  saveOwnerTranslations(list: OwnerTranslation[]): number {
    const put = this.db.prepare(
      `INSERT INTO owner_translations (task_id, field, language, source, text, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, field, language) DO UPDATE SET source = excluded.source, text = excluded.text, at = excluded.at`,
    );
    this.tx(() => {
      for (const x of list) {
        const text = x.text.trim();
        if (!text) continue;
        this.getTask(x.taskId);
        put.run(x.taskId, x.field, x.language, x.source, text, this.now());
      }
    });
    const tasks = new Set(list.map((x) => x.taskId));
    for (const id of tasks)
      this.log(id, 'AI', `Your notes translated for reports and briefs.`);
    return list.length;
  }

  // ------------------------------------------------------------ people

  listPeople(projectId?: string): Person[] {
    const rows = (
      projectId
        ? this.db
            .prepare('SELECT * FROM people WHERE project_id = ? ORDER BY name')
            .all(projectId)
        : this.db.prepare('SELECT * FROM people ORDER BY name').all()
    ) as Row[];
    return rows.map((r) => ({
      id: str(r.id),
      projectId: str(r.project_id),
      name: str(r.name),
      displayName: str(r.display_name),
      side: str(r.side) === 'ours' ? 'ours' : 'customer',
      spellings: JSON.parse(str(r.spellings) || '[]'),
    }));
  }

  /** Adds or changes a person. A name or spelling may belong to one person only. */
  savePerson(input: Omit<Person, 'id'> & { id?: string }): Person {
    const name = input.name.trim();
    if (!name)
      throw new Error('A person needs the name as written in the files.');
    this.getProject(input.projectId);
    const spellings = [
      ...new Set(input.spellings.map((x) => x.trim()).filter(Boolean)),
    ].filter((x) => personKey(x) !== personKey(name));
    const mine = [name, ...spellings].map(personKey);
    const clash = this.listPeople(input.projectId).find(
      (p) =>
        p.id !== input.id &&
        [p.name, ...p.spellings].some((n) => mine.includes(personKey(n))),
    );
    if (clash)
      throw new Error(
        `${clash.displayName || clash.name} already has that name or spelling.`,
      );
    const id = input.id ?? randomUUID();
    const values = [
      name,
      input.displayName.trim(),
      input.side === 'ours' ? 'ours' : 'customer',
      JSON.stringify(spellings),
    ];
    if (input.id)
      this.db
        .prepare(
          'UPDATE people SET name = ?, display_name = ?, side = ?, spellings = ? WHERE id = ?',
        )
        .run(...values, id);
    else
      this.db
        .prepare(
          'INSERT INTO people (id, project_id, name, display_name, side, spellings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, input.projectId, ...values, this.now());
    return this.listPeople(input.projectId).find((p) => p.id === id)!;
  }

  deletePerson(id: string): void {
    this.db.prepare('DELETE FROM people WHERE id = ?').run(id);
  }

  // ------------------------------------------------------------ AI batches

  /** Fills in what the owner accepted from an AI batch, and records it in each task's history. */
  applyAiResults(results: AiResult[]): Task[] {
    return this.tx(() =>
      results.map((r) => {
        const t = this.getTask(r.taskId);
        const parts: string[] = [];
        const title = r.title?.trim() ? r.title.trim() : t.titleTranslation;
        const description = r.description?.trim()
          ? r.description.trim()
          : t.descriptionTranslation;
        const summary = r.summary?.trim() ? r.summary.trim() : t.summary;
        if (
          title !== t.titleTranslation ||
          description !== t.descriptionTranslation
        )
          parts.push('translation');
        if (summary !== t.summary) parts.push('summary');
        if (!parts.length) return t;
        const project = this.getProject(t.projectId);
        const state =
          t.language === project.workingLanguage
            ? 'Not needed'
            : title
              ? 'Translated'
              : t.translationState;
        this.db
          .prepare(
            'UPDATE tasks SET title_translation = ?, description_translation = ?, summary = ?, translation_state = ?, updated_at = ? WHERE id = ?',
          )
          .run(title, description, summary, state, this.now(), t.id);
        this.log(
          t.id,
          'AI batch',
          `Filled in the ${parts.join(' and ')} from a Gemini batch.`,
        );
        return this.getTask(t.id);
      }),
    );
  }

  /** What the newest import of the project's files changed, as recorded when it was applied. */
  lastImport(projectId: string): ImportSummary | null {
    const r = this.db
      .prepare(
        `SELECT v.read_at, v.summary FROM file_versions v JOIN source_files s ON s.id = v.source_id
         WHERE s.project_id = ? AND v.summary IS NOT NULL ORDER BY v.read_at DESC, v.rowid DESC LIMIT 1`,
      )
      .get(projectId) as Row | undefined;
    if (!r) return null;
    const c = JSON.parse(str(r.summary)) as Omit<ImportSummary, 'at'>;
    return {
      at: str(r.read_at),
      added: c.added,
      changed: c.changed,
      removed: c.removed,
    };
  }

  // ------------------------------------------------------------ publishing

  setPublishOptions(
    projectId: string,
    o: { folder?: string | null; notes?: boolean; onClose?: boolean },
  ): Project {
    const p = this.getProject(projectId);
    this.db
      .prepare(
        'UPDATE projects SET publish_folder = ?, publish_notes = ?, publish_on_close = ? WHERE id = ?',
      )
      .run(
        o.folder === undefined ? p.publishFolder : o.folder,
        (o.notes ?? p.publishNotes) ? 1 : 0,
        (o.onClose ?? p.publishOnClose) ? 1 : 0,
        projectId,
      );
    return this.getProject(projectId);
  }

  lastPublish(
    projectId: string,
  ): { at: string; folder: string; files: Record<string, string> } | null {
    const r = this.db
      .prepare(
        'SELECT * FROM publish_records WHERE project_id = ? ORDER BY at DESC LIMIT 1',
      )
      .get(projectId) as Row | undefined;
    return r
      ? {
          at: str(r.at),
          folder: str(r.folder),
          files: JSON.parse(str(r.files)),
        }
      : null;
  }

  recordPublish(
    projectId: string,
    folder: string,
    files: Record<string, string>,
  ): string {
    const at = this.now();
    this.db
      .prepare(
        'INSERT INTO publish_records (id, project_id, at, folder, files) VALUES (?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), projectId, at, folder, JSON.stringify(files));
    return at;
  }

  /** Every project's newest publish, for the index page in a shared parent folder. */
  latestPublishes(): {
    projectId: string;
    name: string;
    folder: string;
    at: string;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT r.project_id, p.name, r.folder, MAX(r.at) AS at FROM publish_records r JOIN projects p ON p.id = r.project_id GROUP BY r.project_id`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      projectId: str(r.project_id),
      name: str(r.name),
      folder: str(r.folder),
      at: str(r.at),
    }));
  }

  /** Tasks changed since a time, counting a task once. */
  changedSince(projectId: string, at: string | null): number {
    const r = (
      at
        ? this.db
            .prepare(
              'SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND updated_at > ?',
            )
            .get(projectId, at)
        : this.db
            .prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?')
            .get(projectId)
    ) as { n: number };
    return Number(r.n);
  }

  /** The newest situation updates of a task. */
  listSituationUpdates(taskId: string, limit = 3) {
    return (
      this.db
        .prepare(
          'SELECT * FROM situation_updates WHERE task_id = ? ORDER BY at DESC LIMIT ?',
        )
        .all(taskId, limit) as Row[]
    ).map((r) => ({
      at: str(r.at),
      handledBy: str(r.handled_by),
      doingNow: str(r.doing_now),
      nextStep: str(r.next_step),
      nextDate: opt(r.next_date),
    }));
  }
}
