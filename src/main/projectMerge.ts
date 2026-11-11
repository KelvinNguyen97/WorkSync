import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  mergeProject,
  type MergeChoices,
  type MergeInput,
  type MergeResult,
  type Row,
  type Tables,
} from '../shared/merge';
import {
  baseFor,
  projectRows,
  REFS,
  recordExchange,
  toUidSpace,
  WITH_ID,
} from './exchanges';
import { putNoteImages, type ExportFile } from './projectTransfer';

/**
 * Merging a .worksync file into the project it is a copy of: the plan (what
 * comes in by itself, what to ask), then the merged project written back.
 */

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** The project here that the file is a copy of (same uid), if any. */
export function mergeTargets(
  db: DatabaseSync,
  x: ExportFile,
): { id: string; name: string }[] {
  const p = x.tables.projects?.[0];
  if (!p) return [];
  const uid = s(p.uid) || s(p.id);
  return (
    db
      .prepare(
        'SELECT id, name FROM projects WHERE COALESCE(uid, id) = ? ORDER BY name',
      )
      .all(uid) as Row[]
  ).map((r) => ({ id: s(r.id), name: s(r.name) }));
}

export interface MergeSession {
  projectId: string;
  input: MergeInput;
  x: ExportFile;
  /** When the two copies last exchanged a file, if they did. */
  baseAt: string | null;
}

export function startMerge(
  db: DatabaseSync,
  x: ExportFile,
  projectId: string,
): MergeSession {
  if (!mergeTargets(db, x).some((p) => p.id === projectId))
    throw new Error('This file is not a copy of that project.');
  const base = baseFor(db, projectId, x.from.id, x.received, x.exchangeId);
  return {
    projectId,
    x,
    baseAt: base?.at ?? null,
    input: {
      mine: toUidSpace(projectRows(db, projectId)),
      theirs: toUidSpace(x.tables),
      base: base?.tables ?? null,
      theirsHasNotes: x.includeNotes,
    },
  };
}

export const planMerge = (m: MergeSession, c: MergeChoices = {}): MergeResult =>
  mergeProject(m.input, c);

/** Tables in the order they are written: rows a row points at come first. */
const ORDER = [
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
/** Rows a merge adds but never removes. */
const NEVER_REMOVED = new Set(['source_files', 'file_versions', 'activity']);

/**
 * Writes the merged project. Rows keep their ids here; new rows get new ids
 * and keep their uid. Returns how many tasks were added, changed and removed.
 */
export function applyMerge(
  db: DatabaseSync,
  m: MergeSession,
  c: MergeChoices,
  o: { snapshotRoot: string; now: string },
): { added: number; changed: number; removed: number } {
  const result = mergeProject(m.input, c).tables;
  const mineRaw = projectRows(db, m.projectId);
  const mine = m.input.mine;
  // uid -> id here, per table; new rows are given one as they are written.
  const local: Record<string, Map<string, string>> = {};
  for (const t of WITH_ID) {
    local[t] = new Map();
    for (const r of mineRaw[t] ?? [])
      local[t].set(s(r.uid) || s(r.id), s(r.id));
  }
  const idHere = (t: string, uid: string) => {
    let id = local[t].get(uid);
    if (!id) {
      id = randomUUID();
      local[t].set(uid, id);
    }
    return id;
  };
  const columns = (t: string) =>
    new Set(
      (db.prepare(`PRAGMA table_info(${t})`).all() as Row[]).map((c) =>
        s(c.name),
      ),
    );
  const toLocal = (t: string, r: Row): Row => {
    const row: Row = { ...r };
    for (const [col, target] of Object.entries(REFS[t]))
      if (row[col] !== null && row[col] !== undefined && row[col] !== '')
        row[col] = idHere(target, s(row[col]));
    if (t === 'owner_translations' && s(row.field).startsWith('difficulty:'))
      row.field = `difficulty:${idHere('difficulties', s(row.field).slice(11))}`;
    return row;
  };
  const differs = (a: Row, b: Row, cols: Set<string>) =>
    [...cols].some((c) => c !== 'id' && c !== 'uid' && s(a[c]) !== s(b[c]));

  let added = 0;
  let changed = 0;
  let removed = 0;
  const written: string[] = [];
  db.exec('BEGIN');
  try {
    // The project's own fields.
    const pr = result.projects?.[0];
    if (pr) {
      const cols = columns('projects');
      const set = [...cols].filter(
        (c) => c !== 'id' && c !== 'created_at' && c in pr,
      );
      db.prepare(
        `UPDATE projects SET ${set.map((c) => `${c} = ?`).join(', ')}, uid = ? WHERE id = ?`,
      ).run(
        ...set.map((c) => pr[c] as string | number | null),
        s(pr.id),
        m.projectId,
      );
    }
    for (const t of ORDER) {
      const cols = columns(t);
      const before = new Map((mine[t] ?? []).map((r) => [s(r.id), r]));
      const after = result[t] ?? [];
      const keep = new Set(after.map((r) => s(r.id)));
      if (!NEVER_REMOVED.has(t))
        for (const uid of before.keys())
          if (!keep.has(uid)) {
            db.prepare(`DELETE FROM ${t} WHERE id = ?`).run(idHere(t, uid));
            if (t === 'tasks') removed++;
          }
      for (const r of after) {
        const uid = s(r.id);
        const old = before.get(uid);
        if (old && !differs(r, old, cols)) continue;
        const row = toLocal(t, r);
        row.id = idHere(t, uid);
        if (cols.has('uid')) row.uid = uid;
        if (t === 'tasks' && old) row.updated_at = o.now;
        if (t === 'source_files' && !old) {
          // Checked again on this PC: the file may be somewhere else here.
          row.state = 'ok';
          row.state_detail = '';
        }
        if (t === 'file_versions' && !old) {
          const bytes = m.x.files[`snapshots/${s(r._fileId)}`];
          const folder = path.join(o.snapshotRoot, s(row.source_id));
          fs.mkdirSync(folder, { recursive: true });
          const ext = path.extname(s(r.file_name)) || '.xlsx';
          const file = path.join(folder, `${s(row.id)}${ext}`);
          if (bytes) {
            fs.writeFileSync(file, bytes);
            written.push(file);
          }
          row.snapshot = file;
        }
        if (t === 'notes') putNoteImages(db, row.body, m.x.files, o.now);
        const names = [...cols].filter((c) => c in row);
        if (old) {
          const set = names.filter((c) => c !== 'id');
          db.prepare(
            `UPDATE ${t} SET ${set.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
          ).run(...set.map((c) => row[c] as string | number | null), s(row.id));
          if (t === 'tasks') changed++;
        } else {
          db.prepare(
            `INSERT INTO ${t} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
          ).run(...names.map((c) => row[c] as string | number | null));
          if (t === 'tasks') added++;
        }
      }
    }
    // Rows without an id of their own: written again as a whole.
    db.prepare(
      'DELETE FROM owner_translations WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)',
    ).run(m.projectId);
    for (const r of result.owner_translations ?? []) {
      const row = toLocal('owner_translations', r);
      db.prepare(
        'INSERT OR REPLACE INTO owner_translations (task_id, field, language, source, text, at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        s(row.task_id),
        s(row.field),
        s(row.language),
        s(row.source),
        s(row.text),
        s(row.at),
      );
    }
    db.prepare(
      'DELETE FROM deleted_rows WHERE source_id IN (SELECT id FROM source_files WHERE project_id = ?)',
    ).run(m.projectId);
    for (const r of result.deleted_rows ?? []) {
      const row = toLocal('deleted_rows', r);
      db.prepare(
        'INSERT OR IGNORE INTO deleted_rows (source_id, customer_id, title, at) VALUES (?, ?, ?, ?)',
      ).run(s(row.source_id), s(row.customer_id), s(row.title), s(row.at));
    }
    // The file is the new starting point for merging with its sender.
    recordExchange(db, {
      id: m.x.exchangeId || randomUUID(),
      projectId: m.projectId,
      peer: m.x.from.id,
      peerName: m.x.from.name,
      direction: 'got',
      at: o.now,
      tables: m.input.theirs as Tables,
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    for (const f of written) fs.rmSync(f, { force: true });
    throw error;
  }
  return { added, changed, removed };
}
