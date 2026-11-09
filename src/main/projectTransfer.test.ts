import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileFormat, Grid } from '../shared/importRules';
import type { TaskInput } from '../shared/model';
import { migrate } from './db';
import {
  exportProject,
  importProject,
  readExport,
  uniqueName,
} from './projectTransfer';
import { Sources, type ReadVersion } from './sources';
import { Store } from './store';
import { Mine } from './mine';
import { imageLine, noteImageIds } from '../shared/notes';

const FORMAT: FileFormat = {
  name: 'WBS',
  sheet: 'WBS',
  headerRows: [0],
  columns: { customerId: 0, title: 1, status: 2 },
  statusWords: { 未着手: 'Not started', 対応中: 'In progress' },
  priorityWords: {},
};
const grid: Grid = [
  ['No.', '件名', '状態'],
  ['1', 'ログイン', '対応中'],
  ['2', '出荷CSV', '未着手'],
];
const input = (o: Partial<TaskInput> = {}): TaskInput => ({
  customerId: '',
  titleOriginal: 'Hand task',
  titleTranslation: '',
  descriptionOriginal: '',
  descriptionTranslation: '',
  summary: '',
  notes: '',
  status: 'Not started',
  priority: 'N',
  labels: [],
  assignee: '',
  category: '',
  remarks: '',
  plannedStart: null,
  plannedEnd: null,
  actualStart: null,
  actualEnd: null,
  nextAction: '',
  nextActionDate: null,
  ...o,
});

let dir: string;
const fresh = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  const store = new Store(db);
  return { db, store, sources: new Sources(db, store) };
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-transfer-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A project with a linked file, notes, a situation, a difficulty and its translation. */
function setUp() {
  const a = fresh();
  const p = a.store.createProject({
    name: 'Portal',
    customer: 'Hoshizora',
    originalLanguages: ['ja'],
    workingLanguage: 'en',
  });
  const snap = path.join(dir, 'snap.xlsx');
  fs.writeFileSync(snap, 'snapshot bytes');
  const v: ReadVersion = {
    file: path.join(dir, 'box', 'WBS.xlsx'),
    grid,
    snapshot: snap,
    fingerprint: 'f1',
    size: 10,
    mtimeMs: 1,
    readDay: '2026-11-04',
  };
  a.sources.link(
    {
      projectId: p.id,
      file: v.file,
      pattern: null,
      format: FORMAT,
      mainLanguage: 'ja',
    },
    v,
  );
  const t = a.store.listTasks().find((x) => x.customerId === '1')!;
  a.store.updateTask(t.id, {
    summary: 'Mine',
    notes: 'Private',
    nextAction: 'Call Suzuki',
  });
  const withDiff = a.store.addSituationUpdate(t.id, {
    doingNow: 'Testing',
    newDifficulty: { text: 'No access', resolver: '' },
  });
  const d = withDiff.difficulties[0];
  a.store.saveOwnerTranslations([
    {
      taskId: t.id,
      field: `difficulty:${d.id}`,
      language: 'ja',
      source: 'No access',
      text: 'アクセス不可',
    },
  ]);
  a.store.saveGlossaryTerm({
    projectId: p.id,
    term: 'ログイン',
    translation: 'login',
    language: 'ja',
    note: '',
  });
  a.store.savePerson({
    projectId: p.id,
    name: '田中',
    displayName: 'Tanaka',
    side: 'customer',
    spellings: [],
  });
  a.store.setPublishOptions(p.id, { folder: '/share/Portal', onClose: true });
  a.store.createTask(p.id, input());
  const shot = new Mine(a.db).addNoteImage(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 7]),
  );
  new Mine(a.db).saveNote({
    title: 'Minutes',
    body: `Kick-off\n${imageLine(shot)}`,
    projectId: p.id,
  });
  new Mine(a.db).saveNote({ title: 'Mine alone', body: '' });
  return { a, p, v };
}

describe('giving a project to another WorkSync user', () => {
  it('copies everything into another WorkSync, as a separate project', () => {
    const { a, p } = setUp();
    const file = exportProject(
      a.db,
      p.id,
      { includeNotes: true },
      '2026-11-04T10:00:00Z',
    );
    expect(readExport(file).name).toBe('Portal');

    const b = fresh();
    const r = importProject(
      b.db,
      file,
      path.join(dir, 'snapshots-b'),
      '2026-11-04T11:00:00Z',
    );
    expect(r).toMatchObject({ name: 'Portal', tasks: 3, sources: 1 });
    const q = b.store.getProject(r.projectId);
    expect(q).toMatchObject({
      customer: 'Hoshizora',
      publishFolder: null,
      publishOnClose: false,
    });
    expect(q.id).not.toBe(p.id);
    const t = b.store.listTasks().find((x) => x.customerId === '1')!;
    expect(t).toMatchObject({
      summary: 'Mine',
      notes: 'Private',
      nextAction: 'Call Suzuki',
      source: 'file',
    });
    expect(b.store.listGlossary(q.id)).toHaveLength(1);
    // The project's notes come along, attached to the new project; other notes stay.
    expect(
      new Mine(b.db).listNotes().map((x) => [x.title, x.projectId]),
    ).toEqual([['Minutes', q.id]]);
    // Its image comes too, under a new id.
    const note = new Mine(b.db).listNotes()[0];
    const [img] = noteImageIds(note.body);
    expect(img).toBeTruthy();
    expect(note.body).toBe(`Kick-off\n${imageLine(img)}`);
    expect(new Mine(b.db).getNoteImage(img).data.at(-1)).toBe(7);
    expect(b.store.listPeople(q.id)[0].displayName).toBe('Tanaka');
    expect(b.store.listActivity(t.id).length).toBeGreaterThan(0);
    // The translation of a difficulty follows the difficulty's new id.
    const tr = b.store.listOwnerTranslations(q.id);
    expect(tr).toHaveLength(1);
    expect(t.difficulties[0].text).toBe('No access');
    expect(tr[0].field).toBe(`difficulty:${t.difficulties[0].id}`);
    // The snapshot came along, so the next review compares with the same rows.
    const src = b.sources.list()[0];
    expect(src.projectId).toBe(q.id);
    const snap = b.db
      .prepare('SELECT snapshot FROM file_versions WHERE source_id = ?')
      .get(src.id) as { snapshot: string };
    expect(fs.readFileSync(snap.snapshot, 'utf8')).toBe('snapshot bytes');
    const review = b.sources.review(src.id, {
      file: src.currentFile,
      grid,
      snapshot: snap.snapshot,
      fingerprint: 'f1',
      size: 10,
      mtimeMs: 1,
      readDay: '2026-11-04',
    });
    expect(review.added).toEqual([]);
    expect(review.changed).toEqual([]);
  });

  it('names a copy like Windows does when the name is taken, and keeps the original', () => {
    const { a, p } = setUp();
    const file = exportProject(
      a.db,
      p.id,
      { includeNotes: true },
      '2026-11-04T10:00:00Z',
    );
    const one = importProject(
      a.db,
      file,
      path.join(dir, 's'),
      '2026-11-04T11:00:00Z',
    );
    const two = importProject(
      a.db,
      file,
      path.join(dir, 's'),
      '2026-11-04T11:00:00Z',
    );
    expect([one.name, two.name]).toEqual(['Portal (1)', 'Portal (2)']);
    expect(a.store.listProjects()).toHaveLength(3);
    expect(a.store.listTasks()).toHaveLength(9);
    expect(uniqueName('Portal (1)', ['Portal', 'Portal (1)'])).toBe(
      'Portal (2)',
    );
    expect(uniqueName('New', ['Portal'])).toBe('New');
  });

  it('leaves notes and next actions out when asked', () => {
    const { a, p } = setUp();
    const file = exportProject(
      a.db,
      p.id,
      { includeNotes: false },
      '2026-11-04T10:00:00Z',
    );
    const b = fresh();
    importProject(b.db, file, path.join(dir, 'sb'), '2026-11-04T11:00:00Z');
    const t = b.store.listTasks().find((x) => x.customerId === '1')!;
    expect(t).toMatchObject({ notes: '', nextAction: '', summary: 'Mine' });
    expect(new Mine(b.db).listNotes()).toHaveLength(0);
  });

  it('refuses a file that is not a WorkSync project', () => {
    const b = fresh();
    expect(() =>
      importProject(
        b.db,
        new TextEncoder().encode('not a zip'),
        dir,
        '2026-11-04T11:00:00Z',
      ),
    ).toThrow(/not a WorkSync project/);
    expect(b.store.listProjects()).toHaveLength(0);
  });
});
