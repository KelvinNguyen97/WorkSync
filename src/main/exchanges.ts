import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import type { Row, Tables } from '../shared/merge';

/**
 * What merging copies of a project needs to remember:
 * - which WorkSync this is (an id made once) and the owner's name for files;
 * - every .worksync file sent or received, as the starting point the next
 *   merge with that person compares from;
 * - rows by the id they have in every copy (uid).
 */

/** How each table points at the others, for turning ids into uids and back. */
export const REFS: Record<string, Record<string, string>> = {
  projects: {},
  source_files: { project_id: 'projects' },
  file_versions: { source_id: 'source_files' },
  tasks: { project_id: 'projects', source_file_id: 'source_files' },
  situation_updates: { task_id: 'tasks' },
  difficulties: { task_id: 'tasks' },
  activity: { task_id: 'tasks' },
  glossary_terms: { project_id: 'projects' },
  people: { project_id: 'projects' },
  owner_translations: { task_id: 'tasks' },
  notes: { project_id: 'projects' },
  deleted_rows: { source_id: 'source_files' },
};
/** Tables whose rows have their own id (and so a uid). */
export const WITH_ID = [
  'projects',
  'source_files',
  'file_versions',
  'tasks',
  'situation_updates',
  'difficulties',
  'activity',
  'glossary_terms',
  'people',
  'notes',
];

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

function setting(db: DatabaseSync, key: string): string | null {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | Row
    | undefined;
  if (!r) return null;
  try {
    return String(JSON.parse(s(r.value)));
  } catch {
    return null;
  }
}

/** This WorkSync's own id, made the first time it is needed. */
export function installId(db: DatabaseSync): string {
  let id = setting(db, 'installId');
  if (!id) {
    id = randomUUID();
    db.prepare(
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    ).run('installId', JSON.stringify(id));
  }
  return id;
}

/** The name written in exported files, so the other person knows whose copy it is. */
export function ownerName(): string {
  try {
    return os.userInfo().username || '';
  } catch {
    return '';
  }
}

/**
 * Rows with their uids as ids, and their links turned into uids too. Rows
 * from a file keep their id in the file as `_fileId` (for snapshots).
 */
export function toUidSpace(tables: Tables): Tables {
  const uidOf: Record<string, Map<string, string>> = {};
  for (const t of WITH_ID) {
    const m = new Map<string, string>();
    for (const r of tables[t] ?? []) m.set(s(r.id), s(r.uid) || s(r.id));
    uidOf[t] = m;
  }
  const out: Tables = {};
  for (const [t, refs] of Object.entries(REFS)) {
    out[t] = (tables[t] ?? []).map((r) => {
      const row: Row = { ...r };
      if (WITH_ID.includes(t)) {
        row._fileId = s(r.id);
        row.id = uidOf[t].get(s(r.id)) ?? s(r.id);
      }
      delete row.uid;
      for (const [col, target] of Object.entries(refs))
        if (row[col] !== null && row[col] !== undefined)
          row[col] = uidOf[target].get(s(row[col])) ?? row[col];
      if (t === 'owner_translations' && s(row.field).startsWith('difficulty:'))
        row.field = `difficulty:${uidOf.difficulties.get(s(row.field).slice(11)) ?? s(row.field).slice(11)}`;
      return row;
    });
  }
  return out;
}

/** The rows a project has in the database, by table. */
export function projectRows(db: DatabaseSync, projectId: string): Tables {
  const q = (sql: string) => db.prepare(sql).all({ p: projectId }) as Row[];
  return {
    projects: q('SELECT * FROM projects WHERE id = :p'),
    source_files: q('SELECT * FROM source_files WHERE project_id = :p'),
    file_versions: q(
      'SELECT v.* FROM file_versions v JOIN source_files f ON f.id = v.source_id WHERE f.project_id = :p AND v.read_at = (SELECT MAX(read_at) FROM file_versions w WHERE w.source_id = v.source_id)',
    ),
    tasks: q('SELECT * FROM tasks WHERE project_id = :p'),
    situation_updates: q(
      'SELECT * FROM situation_updates WHERE task_id IN (SELECT id FROM tasks WHERE project_id = :p)',
    ),
    difficulties: q(
      'SELECT * FROM difficulties WHERE task_id IN (SELECT id FROM tasks WHERE project_id = :p)',
    ),
    activity: q(
      'SELECT * FROM activity WHERE task_id IN (SELECT id FROM tasks WHERE project_id = :p)',
    ),
    glossary_terms: q('SELECT * FROM glossary_terms WHERE project_id = :p'),
    people: q('SELECT * FROM people WHERE project_id = :p'),
    owner_translations: q(
      'SELECT * FROM owner_translations WHERE task_id IN (SELECT id FROM tasks WHERE project_id = :p)',
    ),
    notes: q('SELECT * FROM notes WHERE project_id = :p'),
    deleted_rows: q(
      'SELECT * FROM deleted_rows WHERE source_id IN (SELECT id FROM source_files WHERE project_id = :p)',
    ),
  };
}

/** What a file sent or received holds, kept small: no snapshots, no images. */
const stripForBase = (t: Tables): Tables =>
  Object.fromEntries(
    Object.entries(t).map(([k, rows]) => [
      k,
      rows.map((r) => {
        const x = { ...r };
        delete x._fileId;
        return x;
      }),
    ]),
  );

/** Remembers a file sent or received for a project. */
export function recordExchange(
  db: DatabaseSync,
  o: {
    id: string;
    projectId: string;
    peer: string;
    peerName: string;
    direction: 'sent' | 'got';
    at: string;
    tables: Tables;
  },
): void {
  db.prepare(
    'INSERT OR REPLACE INTO merge_exchanges (id, project_id, peer, peer_name, direction, at, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    o.id,
    o.projectId,
    o.peer,
    o.peerName,
    o.direction,
    o.at,
    JSON.stringify(stripForBase(o.tables)),
  );
  // Only the newest few are useful as a starting point.
  const old = db
    .prepare(
      'SELECT id FROM merge_exchanges WHERE project_id = ? AND direction = ? AND peer = ? ORDER BY at DESC LIMIT -1 OFFSET 5',
    )
    .all(o.projectId, o.direction, o.peer) as Row[];
  for (const r of old)
    db.prepare(
      'DELETE FROM merge_exchanges WHERE id = ? AND project_id = ? AND direction = ?',
    ).run(s(r.id), o.projectId, o.direction);
}

/** The ids of the files this project took in, written into exports. */
export function receivedIds(db: DatabaseSync, projectId: string): string[] {
  return (
    db
      .prepare(
        "SELECT id FROM merge_exchanges WHERE project_id = ? AND direction = 'got' ORDER BY at DESC LIMIT 20",
      )
      .all(projectId) as Row[]
  ).map((r) => s(r.id));
}

/**
 * The starting point for merging a file from `peer`: the newest of the last
 * file received from them, and any file sent that they say they took in.
 */
export function baseFor(
  db: DatabaseSync,
  projectId: string,
  peer: string,
  theyReceived: string[],
  fileId = '',
): { tables: Tables; at: string; peerName: string } | null {
  const rows = db
    .prepare(
      'SELECT * FROM merge_exchanges WHERE project_id = ? ORDER BY at DESC',
    )
    .all(projectId) as Row[];
  const r = rows.find(
    (x) =>
      (s(x.direction) === 'got' && peer && s(x.peer) === peer) ||
      (s(x.direction) === 'sent' && theyReceived.includes(s(x.id))) ||
      // A file this copy sent itself, coming back as it was.
      (!!fileId && s(x.id) === fileId),
  );
  if (!r) return null;
  try {
    return {
      tables: JSON.parse(s(r.data)) as Tables,
      at: s(r.at),
      peerName: s(r.peer_name),
    };
  } catch {
    return null;
  }
}
