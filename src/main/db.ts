import { DatabaseSync } from 'node:sqlite';

/**
 * Schema migrations, in order. The database keeps the number of the last one
 * applied, and the app takes a backup before applying any new ones (spec 06).
 * Never edit a migration that has shipped; add a new one instead.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    customer TEXT NOT NULL DEFAULT '',
    original_languages TEXT NOT NULL,   -- JSON array of language codes
    working_language TEXT NOT NULL,
    views TEXT NOT NULL,                -- JSON object: view key -> shown
    due_soon_days INTEGER NOT NULL DEFAULT 7,
    created_at TEXT NOT NULL
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'hand',
    language TEXT NOT NULL,
    title_original TEXT NOT NULL,
    title_translation TEXT NOT NULL DEFAULT '',
    description_original TEXT NOT NULL DEFAULT '',
    description_translation TEXT NOT NULL DEFAULT '',
    translation_state TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    priority TEXT NOT NULL,
    priority_override TEXT,
    labels TEXT NOT NULL DEFAULT '[]',  -- JSON array
    assignee TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    remarks TEXT NOT NULL DEFAULT '',
    planned_start TEXT, planned_end TEXT, actual_start TEXT, actual_end TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    next_action TEXT NOT NULL DEFAULT '',
    next_action_date TEXT,
    -- the current situation, carried forward from the newest situation update
    handled_by TEXT NOT NULL DEFAULT '',
    doing_now TEXT NOT NULL DEFAULT '',
    waiting_on TEXT NOT NULL DEFAULT 'Nobody',
    next_step TEXT NOT NULL DEFAULT '',
    next_date TEXT,
    as_of TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX tasks_project ON tasks(project_id);
  CREATE TABLE situation_updates (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    handled_by TEXT NOT NULL, doing_now TEXT NOT NULL, waiting_on TEXT NOT NULL,
    next_step TEXT NOT NULL, next_date TEXT, as_of TEXT NOT NULL
  );
  CREATE TABLE difficulties (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    raised_on TEXT NOT NULL,
    resolver TEXT NOT NULL DEFAULT '',
    open INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE activity (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX activity_task ON activity(task_id, at);
  `,
  // 2: linked source files (spec 04)
  `
  CREATE TABLE source_files (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,                 -- the file, or the folder for a name pattern
    pattern TEXT,                       -- such as WBS_*.xlsx; the newest match is read
    current_file TEXT NOT NULL,         -- the file read last
    format TEXT NOT NULL,               -- JSON FileFormat
    main_language TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    last_read_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'ok',   -- ok, changed, missing, unavailable, unreadable
    state_detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE file_versions (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
    read_at TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    file_name TEXT NOT NULL
  );
  ALTER TABLE tasks ADD COLUMN source_file_id TEXT REFERENCES source_files(id) ON DELETE SET NULL;
  ALTER TABLE tasks ADD COLUMN sheet_row INTEGER;
  ALTER TABLE tasks ADD COLUMN file_state TEXT NOT NULL DEFAULT 'hand';
  ALTER TABLE tasks ADD COLUMN status_word TEXT NOT NULL DEFAULT '';
  ALTER TABLE tasks ADD COLUMN priority_word TEXT NOT NULL DEFAULT '';
  ALTER TABLE tasks ADD COLUMN extra TEXT NOT NULL DEFAULT '{}';
  -- the row as last read from the file, so file changes can be told from the owner's edits
  ALTER TABLE tasks ADD COLUMN file_row TEXT;
  CREATE INDEX tasks_source ON tasks(source_file_id);
  `,
  // 3: the project glossary (spec 02)
  `
  CREATE TABLE glossary_terms (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    term TEXT NOT NULL,
    translation TEXT NOT NULL,
    language TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX glossary_project ON glossary_terms(project_id);
  `,
  // 4: what each import changed, for the dashboard
  `
  ALTER TABLE file_versions ADD COLUMN summary TEXT;
  `,
  // 5: publishing to the shared folder (spec 05)
  `
  ALTER TABLE projects ADD COLUMN publish_folder TEXT;
  ALTER TABLE projects ADD COLUMN publish_notes INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE publish_records (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    folder TEXT NOT NULL,
    files TEXT NOT NULL               -- JSON: file name -> SHA-256
  );
  CREATE INDEX publish_project ON publish_records(project_id, at);
  `,
  // 6: what was last written to the owner's copy, per task and field (spec 04)
  `
  ALTER TABLE tasks ADD COLUMN written TEXT NOT NULL DEFAULT '{}';
  `,
  // 7: the Tasks table's columns, sort and filters per project (spec 03)
  `
  ALTER TABLE projects ADD COLUMN table_settings TEXT;
  `,
  // 8: app settings (spec 03), as keys and JSON values
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 9: the people list per project (spec 02)
  `
  CREATE TABLE people (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    side TEXT NOT NULL DEFAULT 'customer',
    spellings TEXT NOT NULL DEFAULT '[]',  -- JSON array
    created_at TEXT NOT NULL
  );
  CREATE INDEX people_project ON people(project_id);
  `,
  // 10: report date format, and the owner's text translated into the file's language (spec 05)
  `
  ALTER TABLE projects ADD COLUMN date_format TEXT NOT NULL DEFAULT 'YYYY/MM/DD';
  CREATE TABLE owner_translations (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    field TEXT NOT NULL,          -- summary, doingNow, nextStep or difficulty:<id>
    language TEXT NOT NULL,
    source TEXT NOT NULL,         -- the text that was translated; a changed text needs a new translation
    text TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (task_id, field, language)
  );
  `,
  // 11: links kept with a task (spec 02, owner fields)
  `
  ALTER TABLE tasks ADD COLUMN links TEXT NOT NULL DEFAULT '[]';
  `,
  // 12: a language the owner chose for a task (spec 02, Languages)
  `
  ALTER TABLE tasks ADD COLUMN language_set INTEGER NOT NULL DEFAULT 0;
  `,
  // 13: publish when the app closes, per project (spec 05)
  `
  ALTER TABLE projects ADD COLUMN publish_on_close INTEGER NOT NULL DEFAULT 0;
  `,
  // 14: the Board's own columns and hidden columns (spec 03, Board)
  `
  ALTER TABLE projects ADD COLUMN board TEXT;
  ALTER TABLE tasks ADD COLUMN board_column TEXT;
  `,
  // 15: whether the views show task numbers, per project
  `
  ALTER TABLE projects ADD COLUMN show_numbers INTEGER NOT NULL DEFAULT 1;
  `,
  // 16: rows of a linked file whose task the owner deleted, so a review does not offer them back unasked
  `
  CREATE TABLE deleted_rows (
    source_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL,
    title TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (source_id, customer_id, title)
  );
  `,
  // 17: My tasks, the owner's own to-dos with reminders, not tied to a project
  `
  CREATE TABLE my_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'N',
    due_date TEXT,
    reminders INTEGER NOT NULL DEFAULT 1,
    last_reminder_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // 18: Notes, on their own or attached to a project; deleting the project keeps them
  `
  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    favorite INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    viewed_at TEXT
  );
  CREATE INDEX notes_project ON notes(project_id);
  `,
  // 19: the Catalog: apps, files and folders the owner opens often
  `
  CREATE TABLE catalog_entries (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    favorite INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL,
    last_opened TEXT
  );
  `,
  // 20: images pasted into notes (placed in the note text by id)
  `
  CREATE TABLE note_images (
    id TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // 21: merging copies of a project. Each row keeps one id across all copies
  // (uid; when empty, the row's own id), and each .worksync file sent or
  // received is kept as the common starting point for the next merge.
  `
  ALTER TABLE projects ADD COLUMN uid TEXT;
  ALTER TABLE tasks ADD COLUMN uid TEXT;
  ALTER TABLE situation_updates ADD COLUMN uid TEXT;
  ALTER TABLE difficulties ADD COLUMN uid TEXT;
  ALTER TABLE activity ADD COLUMN uid TEXT;
  ALTER TABLE glossary_terms ADD COLUMN uid TEXT;
  ALTER TABLE people ADD COLUMN uid TEXT;
  ALTER TABLE notes ADD COLUMN uid TEXT;
  ALTER TABLE source_files ADD COLUMN uid TEXT;
  ALTER TABLE file_versions ADD COLUMN uid TEXT;
  CREATE TABLE merge_exchanges (
    id TEXT NOT NULL,               -- the exchange id written in the file
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    peer TEXT NOT NULL,             -- the other WorkSync ('' for a file sent)
    peer_name TEXT NOT NULL DEFAULT '',
    direction TEXT NOT NULL,        -- sent or got
    at TEXT NOT NULL,
    data TEXT NOT NULL,             -- the project as exchanged, by uid (JSON)
    PRIMARY KEY (id, project_id, direction)
  );
  CREATE INDEX merge_exchanges_project ON merge_exchanges(project_id, at);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

const userVersion = (db: DatabaseSync): number =>
  Number(
    (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version,
  );

/** Applies any migrations the database has not had yet. */
export function migrate(db: DatabaseSync): void {
  const from = userVersion(db);
  if (from > SCHEMA_VERSION) {
    throw new Error(
      `This data was saved by a newer version of WorkSync (database version ${from}). Use that version or newer.`,
    );
  }
  for (let v = from; v < SCHEMA_VERSION; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(
    'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;',
  );
  return db;
}

export { backupDaily } from './backups';
