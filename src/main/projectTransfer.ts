import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { SCHEMA_VERSION } from './db';
import { imageLine, imageType, noteImageIds } from '../shared/notes';

/**
 * Handing a project to another WorkSync user (a copy, not a sync): one
 * .worksync file holds the project with everything WorkSync keeps for it, and
 * the last version read of each linked file, so reviews keep working. The
 * copy is independent: each person edits their own, with no conflicts.
 */

type Row = Record<string, unknown>;
const FORMAT = 'worksync-project';
/** Large enough for a project with its snapshots, small enough to refuse a wrong file early. */
const MAX_BYTES = 300 * 1024 * 1024;

/** What a project owns, by table, and how each table points at the others. */
const TABLES: {
  name: string;
  where: string;
  /** Foreign key columns → the table whose new ids they take. */
  refs?: Record<string, string>;
}[] = [
  { name: 'projects', where: 'id = :p' },
  {
    name: 'source_files',
    where: 'project_id = :p',
    refs: { project_id: 'projects' },
  },
  {
    name: 'file_versions',
    // Only the newest version of each file: what the next review compares with.
    where:
      'id IN (SELECT v.id FROM file_versions v JOIN source_files s ON s.id = v.source_id WHERE s.project_id = :p AND v.read_at = (SELECT MAX(read_at) FROM file_versions w WHERE w.source_id = v.source_id))',
    refs: { source_id: 'source_files' },
  },
  {
    name: 'tasks',
    where: 'project_id = :p',
    refs: { project_id: 'projects', source_file_id: 'source_files' },
  },
  {
    name: 'situation_updates',
    where: 'task_id IN (SELECT id FROM tasks WHERE project_id = :p)',
    refs: { task_id: 'tasks' },
  },
  {
    name: 'difficulties',
    where: 'task_id IN (SELECT id FROM tasks WHERE project_id = :p)',
    refs: { task_id: 'tasks' },
  },
  {
    name: 'activity',
    where: 'task_id IN (SELECT id FROM tasks WHERE project_id = :p)',
    refs: { task_id: 'tasks' },
  },
  {
    name: 'glossary_terms',
    where: 'project_id = :p',
    refs: { project_id: 'projects' },
  },
  {
    name: 'people',
    where: 'project_id = :p',
    refs: { project_id: 'projects' },
  },
  {
    name: 'owner_translations',
    where: 'task_id IN (SELECT id FROM tasks WHERE project_id = :p)',
    refs: { task_id: 'tasks' },
  },
  {
    name: 'notes',
    where: 'project_id = :p',
    refs: { project_id: 'projects' },
  },
  {
    name: 'deleted_rows',
    where: 'source_id IN (SELECT id FROM source_files WHERE project_id = :p)',
    refs: { source_id: 'source_files' },
  },
];

export interface ExportOptions {
  /** False leaves out the owner's notes and next actions. */
  includeNotes: boolean;
}

/** Builds the .worksync file for a project. */
export function exportProject(
  db: DatabaseSync,
  projectId: string,
  o: ExportOptions,
  exportedAt: string,
): Uint8Array {
  const tables: Record<string, Row[]> = {};
  for (const t of TABLES)
    tables[t.name] = db
      .prepare(`SELECT * FROM ${t.name} WHERE ${t.where}`)
      .all({ p: projectId }) as Row[];
  const project = tables.projects[0];
  if (!project) throw new Error('The project was not found.');
  // The copy never publishes over the owner's page.
  project.publish_folder = null;
  project.publish_on_close = 0;
  // A project's notes are the owner's own, like task notes.
  if (!o.includeNotes) tables.notes = [];
  if (!o.includeNotes)
    for (const t of tables.tasks) {
      t.notes = '';
      t.next_action = '';
      t.next_action_date = null;
    }
  const files: Record<string, Uint8Array> = {};
  // Images pasted into the project's notes go along with them.
  const image = db.prepare('SELECT data FROM note_images WHERE id = ?');
  for (const n of tables.notes)
    for (const id of noteImageIds(String(n.body ?? ''))) {
      const r = image.get(id) as Row | undefined;
      if (r) files[`note-images/${id}`] = new Uint8Array(r.data as Uint8Array);
    }
  for (const v of tables.file_versions) {
    const snap = String(v.snapshot ?? '');
    if (snap && fs.existsSync(snap))
      files[`snapshots/${String(v.id)}`] = fs.readFileSync(snap);
  }
  files['manifest.json'] = strToU8(
    JSON.stringify({
      format: FORMAT,
      version: 1,
      schema: SCHEMA_VERSION,
      exportedAt,
      name: String(project.name),
    }),
  );
  files['data.json'] = strToU8(JSON.stringify({ tables }));
  return zipSync(files, { level: 6 });
}

/** A project name that no project has yet: Portal, Portal (1), Portal (2)… */
export function uniqueName(name: string, taken: string[]): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  if (!used.has(name.trim().toLowerCase())) return name;
  const root = name.replace(/\s*\(\d+\)$/, '');
  for (let n = 1; ; n++) {
    const candidate = `${root} (${n})`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

export interface ImportResult {
  projectId: string;
  name: string;
  tasks: number;
  sources: number;
}

/** What a .worksync file says it holds, read without importing it. */
export function readExport(data: Uint8Array): {
  name: string;
  exportedAt: string;
  tables: Record<string, Row[]>;
  files: Record<string, Uint8Array>;
} {
  if (data.length > MAX_BYTES)
    throw new Error('This file is too large to be a WorkSync project.');
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data);
  } catch {
    throw new Error('This file is not a WorkSync project, or it is damaged.');
  }
  let manifest: {
    format?: string;
    schema?: number;
    name?: string;
    exportedAt?: string;
  };
  let body: { tables?: Record<string, Row[]> };
  try {
    manifest = JSON.parse(strFromU8(files['manifest.json']));
    body = JSON.parse(strFromU8(files['data.json']));
  } catch {
    throw new Error('This file is not a WorkSync project, or it is damaged.');
  }
  if (manifest.format !== FORMAT || !body.tables?.projects?.length)
    throw new Error('This file is not a WorkSync project, or it is damaged.');
  if ((manifest.schema ?? 0) > SCHEMA_VERSION)
    throw new Error(
      'This project was exported by a newer version of WorkSync. Update WorkSync to import it.',
    );
  return {
    name: String(manifest.name ?? body.tables.projects[0].name ?? 'Project'),
    exportedAt: String(manifest.exportedAt ?? ''),
    tables: body.tables,
    files,
  };
}

/**
 * Adds the project from a .worksync file as a new project, with new ids for
 * everything, so importing the same file twice gives two separate projects.
 * Only columns this version knows are written; missing ones take their
 * defaults.
 */
export function importProject(
  db: DatabaseSync,
  data: Uint8Array,
  snapshotRoot: string,
  now: string,
): ImportResult {
  const x = readExport(data);
  const columns = (table: string) =>
    new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((c) =>
        String(c.name),
      ),
    );
  const newIds: Record<string, Map<string, string>> = {};
  const idOf = (table: string, old: unknown) => {
    const m = (newIds[table] ??= new Map());
    const k = String(old);
    if (!m.has(k)) m.set(k, randomUUID());
    return m.get(k)!;
  };
  const names = (db.prepare('SELECT name FROM projects').all() as Row[]).map(
    (r) => String(r.name),
  );
  const name = uniqueName(String(x.tables.projects[0].name ?? x.name), names);
  const written: string[] = [];
  db.exec('BEGIN');
  try {
    for (const t of TABLES) {
      const rows = x.tables[t.name] ?? [];
      const known = columns(t.name);
      for (const raw of rows) {
        const r: Row = { ...raw };
        // Each row gets a new id, and its links to other rows follow.
        if ('id' in r) r.id = idOf(t.name, r.id);
        for (const [col, target] of Object.entries(t.refs ?? {}))
          if (r[col] != null) r[col] = idOf(target, r[col]);
        if (t.name === 'projects') {
          r.name = name;
          r.created_at = now;
          r.publish_folder = null;
          r.publish_on_close = 0;
        }
        if (
          t.name === 'owner_translations' &&
          String(r.field).startsWith('difficulty:')
        )
          r.field = `difficulty:${idOf('difficulties', String(r.field).slice(11))}`;
        if (t.name === 'source_files') {
          // Checked again on this PC: the file may be somewhere else here.
          r.state = 'ok';
          r.state_detail = '';
        }
        if (t.name === 'notes') {
          // Each image gets a new id too, so importing twice never clashes.
          let body = String(r.body ?? '');
          for (const oldId of noteImageIds(body)) {
            const bytes = x.files[`note-images/${oldId}`];
            const mime = bytes && imageType(bytes);
            if (!bytes || !mime) continue;
            const id = idOf('note_images', oldId);
            db.prepare(
              'INSERT OR IGNORE INTO note_images (id, mime, data, created_at) VALUES (?, ?, ?, ?)',
            ).run(id, mime, bytes, now);
            body = body.split(imageLine(oldId)).join(imageLine(id));
          }
          r.body = body;
        }
        if (t.name === 'file_versions') {
          const old = String(raw.id);
          const bytes = x.files[`snapshots/${old}`];
          const folder = path.join(snapshotRoot, String(r.source_id));
          fs.mkdirSync(folder, { recursive: true });
          const ext = path.extname(String(raw.file_name ?? '')) || '.xlsx';
          const file = path.join(folder, `${r.id}${ext}`);
          if (bytes) {
            fs.writeFileSync(file, bytes);
            written.push(file);
          }
          r.snapshot = file;
        }
        const cols = Object.keys(r).filter((c) => known.has(c));
        if (!cols.length) continue;
        db.prepare(
          `INSERT INTO ${t.name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        ).run(
          ...cols.map((c) => {
            const v = r[c];
            return v === undefined
              ? null
              : (v as string | number | null | bigint | Uint8Array);
          }),
        );
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    for (const f of written) fs.rmSync(f, { force: true });
    throw error;
  }
  const projectId = idOf('projects', x.tables.projects[0].id);
  return {
    projectId,
    name,
    tasks: (x.tables.tasks ?? []).length,
    sources: (x.tables.source_files ?? []).length,
  };
}
