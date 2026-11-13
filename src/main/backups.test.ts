import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, migrate } from './db';
import {
  backupAtStart,
  backupBefore,
  inspectBackup,
  listBackups,
  replaceDatabase,
} from './backups';
import { Store } from './store';
import { sharedFolderWarning } from '../shared/settings';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ws-bk-'));

const open = (file: string) => {
  const db = new DatabaseSync(file);
  migrate(db);
  return db;
};

describe('backups', () => {
  it('writes the day’s backup at the first start, then a start backup', () => {
    const dir = temp();
    const db = open(path.join(dir, 'w.db'));
    const folder = path.join(dir, 'b');
    backupAtStart(db, folder, '2026-11-03');
    backupAtStart(db, folder, '2026-11-03');
    backupAtStart(db, folder, '2026-11-03');
    expect(
      listBackups(folder)
        .map((b) => b.kind)
        .sort(),
    ).toEqual(['daily', 'start']);
    db.close();
  });

  it('keeps five of each other kind', () => {
    const dir = temp();
    const db = open(path.join(dir, 'w.db'));
    const folder = path.join(dir, 'b');
    for (let i = 0; i < 7; i++) {
      backupBefore(db, folder, 'upgrade', `v${i}`);
    }
    expect(listBackups(folder)).toHaveLength(5);
    db.close();
  });

  it('restores a backup and refuses other files', () => {
    const dir = temp();
    const file = path.join(dir, 'w.db');
    let db = open(file);
    const store = new Store(db);
    store.createProject({
      name: 'Portal',
      customer: '',
      originalLanguages: ['ja'],
      workingLanguage: 'en',
    });
    const backup = backupBefore(db, path.join(dir, 'b'), 'manual');
    store.createProject({
      name: 'Later',
      customer: '',
      originalLanguages: ['ja'],
      workingLanguage: 'en',
    });
    expect(inspectBackup(backup, SCHEMA_VERSION)).toEqual({
      projects: 1,
      tasks: 0,
    });
    db.close();
    replaceDatabase(file, backup);
    db = open(file);
    expect(new Store(db).listProjects().map((p) => p.name)).toEqual(['Portal']);
    db.close();

    const junk = path.join(dir, 'junk.db');
    fs.writeFileSync(junk, 'not a database');
    expect(() => inspectBackup(junk, SCHEMA_VERSION)).toThrow(
      /not a WorkSync backup/,
    );
    expect(() => inspectBackup(backup, 1)).toThrow(/newer version/);
  });
});

describe('settings', () => {
  it('keeps app settings and uses them for new projects', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const store = new Store(db);
    expect(store.getSettings().dueSoonDays).toBe(7);
    store.updateSettings({ dueSoonDays: 10, backupFolder: 'E:\\Backups' });
    expect(store.getSettings()).toMatchObject({
      dueSoonDays: 10,
      backupFolder: 'E:\\Backups',
      workingLanguage: 'en',
    });
    expect(
      store.createProject({
        name: 'P',
        customer: '',
        originalLanguages: ['ja'],
        workingLanguage: 'en',
      }).dueSoonDays,
    ).toBe(10);
    expect(() => store.updateSettings({ dueSoonDays: 0 })).toThrow();
  });

  it('warns about shared and synced folders', () => {
    expect(sharedFolderWarning('\\\\fs01\\share\\backup')).toMatch(/network/);
    expect(sharedFolderWarning('C:\\Users\\me\\Box\\x')).toMatch(/Box/);
    expect(sharedFolderWarning('C:\\Users\\me\\OneDrive - Contoso\\x')).toMatch(
      /synced by OneDrive\./,
    );
    expect(sharedFolderWarning('D:\\Backups\\WorkSync')).toBeNull();
  });
});
