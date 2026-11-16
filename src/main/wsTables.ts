import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_VIEWS } from '../shared/model';

/**
 * What a shared project shares, table by table (doc 08, 3.6). Rows are
 * matched by their id, which is the same on every PC. Fields listed as
 * private stay on each PC: your notes on a ticket, your next action, your
 * own priority, pins, reminders, the customer-file link and settings.
 */
export interface SharedTable {
  name: string;
  /** Selects the rows of a project; :p is the project id. */
  rows: string;
  /** Fields never sent; they keep this PC's values. */
  private: string[];
  /** Values for NOT NULL private fields when a row first arrives. */
  defaults?: Record<string, unknown>;
  /** The column that points at the parent row, and the parent table. */
  parent?: { column: string; table: string };
}

const inTasks = 'SELECT id FROM tasks WHERE project_id = :p';
const inDiscussions = 'SELECT id FROM discussions WHERE project_id = :p';

/** In the order rows are written: parents first. */
export const SHARED_TABLES: SharedTable[] = [
  {
    name: 'projects',
    rows: 'SELECT * FROM projects WHERE id = :p',
    private: [
      'views',
      'publish_folder',
      'publish_notes',
      'publish_on_close',
      'board',
      'table_settings',
    ],
    defaults: { views: JSON.stringify(DEFAULT_VIEWS) },
  },
  {
    name: 'tasks',
    rows: 'SELECT * FROM tasks WHERE project_id = :p',
    private: [
      'notes',
      'next_action',
      'next_action_date',
      'pinned',
      'priority_override',
      'board_column',
      'source_file_id',
      'written',
    ],
    parent: { column: 'project_id', table: 'projects' },
  },
  {
    name: 'situation_updates',
    rows: `SELECT * FROM situation_updates WHERE task_id IN (${inTasks})`,
    private: [],
    parent: { column: 'task_id', table: 'tasks' },
  },
  {
    name: 'difficulties',
    rows: `SELECT * FROM difficulties WHERE task_id IN (${inTasks})`,
    private: [],
    parent: { column: 'task_id', table: 'tasks' },
  },
  {
    name: 'activity',
    rows: `SELECT * FROM activity WHERE task_id IN (${inTasks})`,
    private: [],
    parent: { column: 'task_id', table: 'tasks' },
  },
  {
    name: 'glossary_terms',
    rows: 'SELECT * FROM glossary_terms WHERE project_id = :p',
    private: [],
    parent: { column: 'project_id', table: 'projects' },
  },
  {
    name: 'people',
    rows: 'SELECT * FROM people WHERE project_id = :p',
    private: [],
    parent: { column: 'project_id', table: 'projects' },
  },
  {
    name: 'releases',
    rows: 'SELECT * FROM releases WHERE project_id = :p',
    private: [],
    parent: { column: 'project_id', table: 'projects' },
  },
  {
    name: 'release_modules',
    rows: 'SELECT * FROM release_modules WHERE release_id IN (SELECT id FROM releases WHERE project_id = :p)',
    private: [],
    parent: { column: 'release_id', table: 'releases' },
  },
  {
    name: 'discussions',
    rows: 'SELECT * FROM discussions WHERE project_id = :p',
    private: [],
    parent: { column: 'project_id', table: 'projects' },
  },
  {
    name: 'comments',
    rows: `SELECT * FROM comments WHERE discussion_id IN (${inDiscussions})`,
    private: [],
    parent: { column: 'discussion_id', table: 'discussions' },
  },
  {
    name: 'attachments',
    rows: `SELECT * FROM attachments WHERE discussion_id IN (${inDiscussions})`,
    private: [],
    parent: { column: 'discussion_id', table: 'discussions' },
  },
  {
    name: 'project_tasks',
    rows: 'SELECT * FROM project_tasks WHERE project_id = :p',
    private: ['reminders', 'last_reminder_key'],
    parent: { column: 'project_id', table: 'projects' },
  },
  {
    name: 'work_history',
    rows: 'SELECT * FROM work_history WHERE project_id = :p',
    private: [],
    parent: { column: 'project_id', table: 'projects' },
  },
];

export const TABLE = Object.fromEntries(SHARED_TABLES.map((t) => [t.name, t]));

type Row = Record<string, unknown>;

/** A value as it goes into a change file: bytes become base64. */
export function toWire(v: unknown): unknown {
  if (v instanceof Uint8Array) return { $b: Buffer.from(v).toString('base64') };
  if (typeof v === 'bigint') return Number(v);
  return v;
}

export function fromWire(v: unknown): unknown {
  if (v && typeof v === 'object' && '$b' in (v as Row))
    return Buffer.from(String((v as Row).$b), 'base64');
  return v;
}

const columnsCache = new WeakMap<DatabaseSync, Map<string, Set<string>>>();
export function columns(db: DatabaseSync, table: string): Set<string> {
  let m = columnsCache.get(db);
  if (!m) {
    m = new Map();
    columnsCache.set(db, m);
  }
  let c = m.get(table);
  if (!c) {
    c = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) =>
        String(r.name),
      ),
    );
    m.set(table, c);
  }
  return c;
}

/** The shared fields of the project's rows, by table and id, as wire values. */
export function sharedRows(
  db: DatabaseSync,
  projectId: string,
): Map<string, Map<string, Row>> {
  const out = new Map<string, Map<string, Row>>();
  for (const t of SHARED_TABLES) {
    const m = new Map<string, Row>();
    for (const r of db.prepare(t.rows).all({ p: projectId }) as Row[]) {
      const row: Row = {};
      for (const [k, v] of Object.entries(r))
        if (!t.private.includes(k)) row[k] = toWire(v);
      m.set(String(r.id), row);
    }
    out.set(t.name, m);
  }
  return out;
}
