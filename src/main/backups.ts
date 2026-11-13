import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { BackupInfo, BackupKind } from '../shared/settings';

/**
 * Backups of the database (spec 06): when the app starts, once a day while it
 * runs, before an upgrade and before a restore. VACUUM INTO writes a complete
 * copy even while the database is in use. The last 14 daily backups are kept.
 */
const DAILY_KEPT = 14;
const OTHER_KEPT = 5;

const KIND: [RegExp, BackupKind][] = [
  [/^worksync-\d{4}-\d{2}-\d{2}\.db$/, 'daily'],
  [/^worksync-start\.db$/, 'start'],
  [/^before-upgrade-.*\.db$/, 'upgrade'],
  [/^before-restore-.*\.db$/, 'restore'],
  [/^before-delete-.*\.db$/, 'delete'],
  [/^worksync-manual-.*\.db$/, 'manual'],
];
const kindOf = (name: string): BackupKind | null =>
  KIND.find(([re]) => re.test(name))?.[1] ?? null;

/** The local date and time, such as 2026-11-04-192639, like the daily backups' local date. */
const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Writes a copy of the database. A file of the same name is replaced only once the copy is complete. */
export function writeBackup(
  db: DatabaseSync,
  folder: string,
  name: string,
): string {
  fs.mkdirSync(folder, { recursive: true });
  const target = path.join(folder, name);
  const temp = `${target}.part`;
  fs.rmSync(temp, { force: true });
  db.exec(`VACUUM INTO '${temp.replaceAll("'", "''")}'`);
  fs.renameSync(temp, target);
  return target;
}

/**
 * The backup the app takes when it starts. The first start of a day writes
 * the day's backup; later starts that day replace the start backup.
 */
export function backupAtStart(
  db: DatabaseSync,
  folder: string,
  today: string,
): string {
  return (
    backupDaily(db, folder, today) ??
    writeBackup(db, folder, 'worksync-start.db')
  );
}

/** Writes the day's backup if there is none yet, and keeps the last 14. */
export function backupDaily(
  db: DatabaseSync,
  folder: string,
  today: string,
): string | null {
  const name = `worksync-${today}.db`;
  if (fs.existsSync(path.join(folder, name))) return null;
  const file = writeBackup(db, folder, name);
  prune(folder);
  return file;
}

export const backupBefore = (
  db: DatabaseSync,
  folder: string,
  what: 'upgrade' | 'restore' | 'delete' | 'manual',
  detail = '',
) => {
  const file = writeBackup(
    db,
    folder,
    what === 'manual'
      ? `worksync-manual-${stamp()}.db`
      : `before-${what}-${detail ? `${detail}-` : ''}${stamp()}.db`,
  );
  prune(folder);
  return file;
};

function prune(folder: string): void {
  const all = fs.readdirSync(folder);
  const drop = [
    ...all
      .filter((f) => kindOf(f) === 'daily')
      .sort()
      .slice(0, -DAILY_KEPT),
    ...(['upgrade', 'restore', 'delete', 'manual'] as const).flatMap((k) =>
      all
        .filter((f) => kindOf(f) === k)
        .sort()
        .slice(0, -OTHER_KEPT),
    ),
  ];
  for (const f of drop) fs.rmSync(path.join(folder, f), { force: true });
}

/** The backups in a folder, newest first. */
export function listBackups(folder: string): BackupInfo[] {
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .map((name) => ({ name, kind: kindOf(name) }))
    .filter((x): x is { name: string; kind: BackupKind } => !!x.kind)
    .map(({ name, kind }) => {
      const file = path.join(folder, name);
      const st = fs.statSync(file);
      return {
        file,
        name,
        kind,
        at: st.mtime.toISOString(),
        size: st.size,
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** Checks that a file is a WorkSync database this version can open, and says what it holds. */
export function inspectBackup(
  file: string,
  schemaVersion: number,
): { projects: number; tasks: number } {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const v = Number(
      (db.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version,
    );
    if (v > schemaVersion)
      throw new Error(
        'This backup was made by a newer version of WorkSync. Use that version to restore it.',
      );
    const count = (t: string) =>
      Number(
        (db!.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number })
          .n,
      );
    return { projects: count('projects'), tasks: count('tasks') };
  } catch (error) {
    if (error instanceof Error && /newer version/.test(error.message))
      throw error;
    throw new Error('This file is not a WorkSync backup, or it is damaged.');
  } finally {
    db?.close();
  }
}

/** Puts a backup in place of the database file. The database must be closed. */
export function replaceDatabase(dbFile: string, backupFile: string): void {
  const temp = `${dbFile}.restoring`;
  fs.copyFileSync(backupFile, temp);
  for (const ext of ['-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true });
  fs.renameSync(temp, dbFile);
}
