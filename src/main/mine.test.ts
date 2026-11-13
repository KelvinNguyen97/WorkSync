import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './db';
import { Mine } from './mine';
import { imageLine } from '../shared/notes';

let mine: Mine;
beforeEach(() => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  mine = new Mine(db, () => '2026-11-06T01:00:00.000Z');
});

describe('My tasks', () => {
  it('adds, changes, completes and puts back a task', () => {
    const a = mine.saveMyTask({
      title: '  Renew the pass ',
      dueDate: '2026-11-06',
    });
    expect(a).toMatchObject({
      title: 'Renew the pass',
      status: 'todo',
      priority: 'N',
      reminders: true,
    });
    mine.setReminderKey(a.id, '20261106-morning');
    // A new priority starts the reminders afresh; a new title doesn't.
    expect(
      mine.saveMyTask({ title: 'Renew the commuter pass' }, a.id)
        .lastReminderKey,
    ).toBe('20261106-morning');
    const b = mine.saveMyTask({ priority: 'U' }, a.id);
    expect(b).toMatchObject({
      priority: 'U',
      lastReminderKey: null,
      title: 'Renew the commuter pass',
    });
    const gone = mine.deleteMyTask(a.id);
    expect(mine.listMyTasks()).toHaveLength(0);
    expect(mine.restoreMyTask(gone)).toMatchObject({
      id: a.id,
      title: 'Renew the commuter pass',
    });
  });
  it('refuses a task without a title or with a wrong value', () => {
    expect(() => mine.saveMyTask({ title: ' ' })).toThrow(/needs a title/);
    expect(() => mine.saveMyTask({ title: 'x', dueDate: '6 Nov' })).toThrow(
      /not a date/,
    );
    expect(() =>
      mine.saveMyTask({ title: 'x', priority: 'H' as never }),
    ).toThrow(/Urgent, Normal or Low/);
  });
});

describe('Notes', () => {
  it('keeps a project note when the project is deleted, as a note on its own', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    const m = new Mine(db, () => '2026-11-06T01:00:00.000Z');
    db.prepare(
      "INSERT INTO projects (id, name, customer, original_languages, working_language, views, due_soon_days, created_at) VALUES ('p', 'Portal', '', '[\"ja\"]', 'en', '{}', 7, '2026-11-01')",
    ).run();
    const n = m.saveNote({
      title: 'Minutes',
      body: 'See https://example.com/spec.',
      projectId: 'p',
      tags: ['#meeting', 'Meeting', 'q4'],
    });
    expect(n).toMatchObject({ projectId: 'p', tags: ['meeting', 'q4'] });
    db.prepare("DELETE FROM projects WHERE id = 'p'").run();
    expect(m.getNote(n.id).projectId).toBeNull();
    expect(() => m.saveNote({ projectId: 'gone' }, n.id)).toThrow(
      /no longer exists/,
    );
  });
  it('changes only what is given, and puts a deleted note back', () => {
    const n = mine.saveNote({ title: 'A', body: 'one' });
    const u = mine.saveNote({ body: 'two' }, n.id);
    expect(u).toMatchObject({ title: 'A', body: 'two', favorite: false });
    const gone = mine.deleteNote(n.id);
    expect(mine.listNotes()).toHaveLength(0);
    expect(mine.restoreNote(gone).body).toBe('two');
  });
});

describe('Images in notes', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2]);
  it('keeps an image and gives it back', () => {
    const id = mine.addNoteImage(png);
    expect(mine.getNoteImage(id)).toEqual({ mime: 'image/png', data: png });
  });
  it('refuses what is not an image, or too large', () => {
    expect(() => mine.addNoteImage(new TextEncoder().encode('hi'))).toThrow(
      /Only PNG/,
    );
    const big = new Uint8Array(20 * 1024 * 1024 + 1);
    big.set(png);
    expect(() => mine.addNoteImage(big)).toThrow(/too large/);
  });
  it('drops images no note uses, once they are a day old', () => {
    let now = '2026-11-06T01:00:00.000Z';
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const m = new Mine(db, () => now);
    const used = m.addNoteImage(png);
    const loose = m.addNoteImage(png);
    m.saveNote({ title: 'Shot', body: `See\n${imageLine(used)}` });
    expect(m.dropUnusedNoteImages()).toBe(0);
    now = '2026-11-08T01:00:00.000Z';
    expect(m.dropUnusedNoteImages()).toBe(1);
    expect(m.getNoteImage(used).mime).toBe('image/png');
    expect(() => m.getNoteImage(loose)).toThrow(/no longer there/);
  });
});

describe('Catalog', () => {
  const there = new Set(['D:\\Work\\WBS.xlsx', 'D:\\Minutes']);
  const exists = (p: string) => there.has(p);
  it('adds a path once, names it after the file, and marks one that is gone', () => {
    const a = mine.saveEntry(
      { path: 'D:\\Work\\WBS.xlsx', kind: 'file', tags: ['#customer'] },
      exists,
    );
    expect(a).toMatchObject({
      name: 'WBS.xlsx',
      tags: ['customer'],
      missing: false,
    });
    expect(() =>
      mine.saveEntry({ path: 'd:/work/wbs.xlsx/', kind: 'file' }, exists),
    ).toThrow(/already in the Catalog/);
    const b = mine.saveEntry(
      { path: 'D:\\Old\\estimate.xlsx', kind: 'file' },
      exists,
    );
    expect(b.missing).toBe(true);
    const c = mine.saveEntry(
      { name: 'Estimate v3', note: 'Moved?' },
      exists,
      b.id,
    );
    expect(c).toMatchObject({
      name: 'Estimate v3',
      path: 'D:\\Old\\estimate.xlsx',
      note: 'Moved?',
    });
  });
  it('removes an entry with Undo, and remembers when it was opened', () => {
    const a = mine.saveEntry({ path: 'D:\\Minutes', kind: 'folder' }, exists);
    mine.markOpened(a.id);
    expect(mine.getEntry(a.id, exists).lastOpened).toBe(
      '2026-11-06T01:00:00.000Z',
    );
    const gone = mine.deleteEntry(a.id, exists);
    expect(mine.listCatalog(exists)).toHaveLength(0);
    expect(mine.restoreEntry(gone, exists).kind).toBe('folder');
  });
});
