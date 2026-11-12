import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { SCHEMA_VERSION } from './db';
import { imageType, noteImageIds } from '../shared/notes';
import {
  installId,
  ownerName,
  receivedIds,
  recordExchange,
  toUidSpace,
  WITH_ID,
} from './exchanges';

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
    name: 'releases',
    where: 'project_id = :p',
    refs: { project_id: 'projects' },
  },
  {
    name: 'release_modules',
    where: 'release_id IN (SELECT id FROM releases WHERE project_id = :p)',
    refs: { release_id: 'releases' },
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
  // Each row carries the id it has in every copy, so copies can be merged.
  for (const t of WITH_ID)
    for (const r of tables[t] ?? []) r.uid = r.uid || r.id;
  const exchangeId = randomUUID();
  const from = { id: installId(db), name: ownerName() };
  files['manifest.json'] = strToU8(
    JSON.stringify({
      format: FORMAT,
      version: 2,
      schema: SCHEMA_VERSION,
      exportedAt,
      name: String(project.name),
      from,
      exchangeId,
      // The files this copy took in: the receiver can merge from those.
      received: receivedIds(db, projectId),
      includeNotes: o.includeNotes,
    }),
  );
  files['data.json'] = strToU8(JSON.stringify({ tables }));
  const zip = zipSync(files, { level: 6 });
  recordExchange(db, {
    id: exchangeId,
    projectId,
    peer: '',
    peerName: '',
    direction: 'sent',
    at: exportedAt,
    tables: toUidSpace(tables),
  });
  return zip;
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
export interface ExportFile {
  name: string;
  exportedAt: string;
  tables: Record<string, Row[]>;
  files: Record<string, Uint8Array>;
  /** The WorkSync it came from: its id and the owner's name ('' in older files). */
  from: { id: string; name: string };
  /** This file's id, and the files the sender's copy had taken in. */
  exchangeId: string;
  received: string[];
  /** Whether the owner's notes are in it. */
  includeNotes: boolean;
}

export function readExport(data: Uint8Array): ExportFile {
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
    from?: { id?: string; name?: string };
    exchangeId?: string;
    received?: string[];
    includeNotes?: boolean;
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
  const tables = body.tables;
  return {
    name: String(manifest.name ?? tables.projects[0].name ?? 'Project'),
    exportedAt: String(manifest.exportedAt ?? ''),
    tables,
    files,
    from: {
      id: String(manifest.from?.id ?? ''),
      name: String(manifest.from?.name ?? ''),
    },
    exchangeId: String(manifest.exchangeId ?? ''),
    received: Array.isArray(manifest.received)
      ? manifest.received.map(String)
      : [],
    // Older files do not say: notes, or task notes, being there tells.
    includeNotes:
      typeof manifest.includeNotes === 'boolean'
        ? manifest.includeNotes
        : (tables.notes ?? []).length > 0 ||
          (tables.tasks ?? []).some((t) => !!t.notes || !!t.next_action),
  };
}

/**
 * Adds the project from a .worksync file as a new project, with new ids for
 * everything, so importing the same file twice gives two separate projects.
 * Only columns this version knows are written; missing ones take their
 * defaults.
 */
/**
 * Keeps the images a note from a file uses. An image keeps its id in every
 * copy (the same picture), so the note text stays the same and merges.
 */
export function putNoteImages(
  db: DatabaseSync,
  body: unknown,
  files: Record<string, Uint8Array>,
  now: string,
): void {
  for (const id of noteImageIds(String(body ?? ''))) {
    const bytes = files[`note-images/${id}`];
    const mime = bytes && imageType(bytes);
    if (bytes && mime)
      db.prepare(
        'INSERT OR IGNORE INTO note_images (id, mime, data, created_at) VALUES (?, ?, ?, ?)',
      ).run(id, mime, bytes, now);
  }
}

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
        // Each row gets a new id here, and its links to other rows follow;
        // its uid stays, so this copy and the original can be merged later.
        if ('id' in r) {
          if (known.has('uid')) r.uid = raw.uid || raw.id;
          r.id = idOf(t.name, r.id);
        }
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
        if (t.name === 'notes') putNoteImages(db, r.body, x.files, now);
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
  // The file is where this copy starts: the next merge with its sender compares from it.
  recordExchange(db, {
    id: x.exchangeId || randomUUID(),
    projectId,
    peer: x.from.id,
    peerName: x.from.name,
    direction: 'got',
    at: now,
    tables: toUidSpace(x.tables),
  });
  return {
    projectId,
    name,
    tasks: (x.tables.tasks ?? []).length,
    sources: (x.tables.source_files ?? []).length,
  };
}
