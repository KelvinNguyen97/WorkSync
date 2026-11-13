import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, backupDaily, migrate } from './db';
import { Store } from './store';
import type { TaskInput } from '../shared/model';

const input = (o: Partial<TaskInput> = {}): TaskInput => ({
  customerId: '',
  titleOriginal: 'ログイン画面のタイムアウト',
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

let store: Store;
let db: DatabaseSync;
let clock = '2026-11-03T09:00:00.000Z';

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  store = new Store(db, () => clock);
});

const project = () =>
  store.createProject({
    name: 'Portal',
    customer: 'Hoshizora',
    originalLanguages: ['ja', 'en'],
    workingLanguage: 'en',
  });

describe('Store', () => {
  it('creates projects with the default views and Focus always on', () => {
    const p = project();
    expect(
      p.views.focus && p.views.board && p.views.dashboard && p.views.files,
    ).toBe(true);
    const q = store.updateProject(p.id, {
      views: { board: false, focus: false },
    });
    expect(q.views.board).toBe(false);
    expect(q.views.focus).toBe(true);
  });

  it('numbers hand-added tasks, detects their language and sets the translation state', () => {
    const p = project();
    const a = store.createTask(p.id, input());
    const b = store.createTask(
      p.id,
      input({ titleOriginal: 'Gateway firmware update plan' }),
    );
    expect([a.customerId, b.customerId]).toEqual(['001', '002']);
    expect(a.language).toBe('ja');
    expect(a.translationState).toBe('Not translated');
    expect(b.language).toBe('en');
    expect(b.translationState).toBe('Not needed');
    expect(
      store.updateTask(a.id, { titleTranslation: 'Login screen times out' })
        .translationState,
    ).toBe('Translated');
  });

  it('rejects a task without a title', () => {
    expect(() =>
      store.createTask(project().id, input({ titleOriginal: '  ' })),
    ).toThrow('needs a title');
  });

  it('records what changed in the history, newest first', () => {
    const t = store.createTask(project().id, input());
    clock = '2026-11-03T10:00:00.000Z';
    store.updateTask(t.id, { status: 'In progress' });
    clock = '2026-11-03T11:00:00.000Z';
    store.updateTask(t.id, { summary: 'x', labels: ['Auth', ' Auth ', ''] });
    const h = store.listActivity(t.id).map((e) => e.text);
    expect(h).toEqual([
      'Changed Summary, Labels.',
      'Status Not started → In progress.',
      'Added by hand.',
    ]);
    expect(store.getTask(t.id).labels).toEqual(['Auth']);
    store.updateTask(t.id, { summary: 'x' });
    expect(store.listActivity(t.id)).toHaveLength(3);
  });

  it('carries the situation forward and keeps difficulties', () => {
    const t = store.createTask(project().id, input());
    store.addSituationUpdate(t.id, {
      handledBy: 'Yamada',
      doingNow: 'Reproducing',
    });
    clock = '2026-11-05T09:00:00.000Z';
    const u = store.addSituationUpdate(t.id, {
      nextStep: 'Send logs',
      newDifficulty: { text: 'No access', resolver: 'Customer IT' },
    });
    expect(u.situation).toMatchObject({
      handledBy: 'Yamada',
      doingNow: 'Reproducing',
      nextStep: 'Send logs',
      asOf: '2026-11-05',
    });
    expect(u.difficulties).toHaveLength(1);
    const r = store.setDifficultyOpen(t.id, u.difficulties[0].id, false);
    expect(r.difficulties[0].open).toBe(false);
  });

  it('fixes a mistake in the situation without making a new update', () => {
    const t = store.createTask(project().id, input());
    expect(() => store.correctSituation(t.id, { doingNow: 'x' })).toThrow(
      /no situation yet/,
    );
    clock = '2026-11-03T09:00:00.000Z';
    store.addSituationUpdate(t.id, {
      doingNow: 'Reproducng',
      nextStep: 'Logs',
    });
    clock = '2026-11-05T09:00:00.000Z';
    const u = store.correctSituation(t.id, { doingNow: 'Reproducing ' });
    expect(u.situation).toMatchObject({
      doingNow: 'Reproducing',
      nextStep: 'Logs',
      asOf: '2026-11-03',
    });
    const ups = store.listSituationUpdates(t.id, 10);
    expect(ups).toHaveLength(1);
    expect(ups[0].doingNow).toBe('Reproducing');
    expect(store.listActivity(t.id)[0].text).toBe('Corrected doing now.');
    // Nothing changed: nothing logged.
    const n = store.listActivity(t.id).length;
    store.correctSituation(t.id, { doingNow: 'Reproducing' });
    expect(store.listActivity(t.id)).toHaveLength(n);
  });

  it('edits and deletes a difficulty, with its translation', () => {
    const t = store.createTask(project().id, input());
    const d = store.addSituationUpdate(t.id, {
      newDifficulty: { text: 'No acess', resolver: '' },
    }).difficulties[0];
    const e = store.editDifficulty(t.id, d.id, {
      text: 'No access',
      resolver: 'Customer IT',
    });
    expect(e.difficulties[0]).toMatchObject({
      id: d.id,
      text: 'No access',
      resolver: 'Customer IT',
      raisedOn: d.raisedOn,
    });
    expect(() =>
      store.editDifficulty(t.id, d.id, { text: ' ', resolver: '' }),
    ).toThrow(/needs some text/);
    store.saveOwnerTranslations([
      {
        taskId: t.id,
        field: `difficulty:${d.id}`,
        language: 'ja',
        source: 'No access',
        text: 'アクセス不可',
      },
    ]);
    const r = store.deleteDifficulty(t.id, d.id);
    expect(r.difficulties).toHaveLength(0);
    expect(store.listOwnerTranslations(t.projectId)).toHaveLength(0);
    expect(store.listActivity(t.id)[0].text).toBe('Deleted: No access.');
  });

  it('treats an override equal to the task level as no override', () => {
    const t = store.createTask(project().id, input({ priority: 'N' }));
    expect(store.setPriorityOverride(t.id, 'U').priorityOverride).toBe('U');
    expect(store.setPriorityOverride(t.id, 'N').priorityOverride).toBeNull();
  });

  it('deletes a task with its history', () => {
    const t = store.createTask(project().id, input());
    store.deleteTask(t.id);
    expect(store.listTasks()).toHaveLength(0);
    expect(store.listActivity(t.id)).toHaveLength(0);
  });
});

describe('Tasks table', () => {
  it('applies one change to several tasks, each with its own history', () => {
    const p = project();
    const a = store.createTask(p.id, input({ labels: ['Auth'] }));
    const b = store.createTask(p.id, input({ labels: ['auth', 'UI'] }));
    const f = store.createTask(p.id, input({ priority: 'L' }));
    const out = store.bulkUpdate([a.id, b.id, f.id], {
      addLabel: 'Release 2',
      removeLabel: 'AUTH',
      status: 'In progress',
      pinned: true,
    });
    expect(out.map((t) => t.labels)).toEqual([
      ['Release 2'],
      ['UI', 'Release 2'],
      ['Release 2'],
    ]);
    expect(out.every((t) => t.status === 'In progress' && t.pinned)).toBe(true);
    // Priority is never changed in bulk.
    expect(out[2]).toMatchObject({ priority: 'L', priorityOverride: null });
    expect(store.listActivity(b.id)[0].text).toMatch(/Changed/);
  });

  it('rolls the whole change back when one task fails', () => {
    const p = project();
    const a = store.createTask(p.id, input());
    expect(() =>
      store.bulkUpdate([a.id, 'missing'], { status: 'Done' }),
    ).toThrow();
    expect(store.getTask(a.id).status).toBe('Not started');
  });

  it('remembers the table settings per project', () => {
    const p = project();
    expect(p.tableSettings).toBeNull();
    const s = {
      columns: ['id', 'title'],
      sort: { key: 'plannedEnd', dir: 'desc' as const },
      filters: { status: 'On hold' },
    };
    expect(store.setTableSettings(p.id, s).tableSettings).toEqual(s);
    expect(store.setTableSettings(p.id, null).tableSettings).toBeNull();
  });
});

describe('glossary and AI batches', () => {
  it('keeps glossary terms per project with their language', () => {
    const p = project();
    const g = store.saveGlossaryTerm({
      projectId: p.id,
      term: '受入テスト',
      translation: 'acceptance test',
      note: '',
      language: 'ja',
    });
    store.saveGlossaryTerm({ ...g, translation: 'user acceptance test' });
    expect(
      store.listGlossary(p.id).map((x) => [x.term, x.translation, x.language]),
    ).toEqual([['受入テスト', 'user acceptance test', 'ja']]);
    expect(() =>
      store.saveGlossaryTerm({
        projectId: p.id,
        term: 'x',
        translation: ' ',
        note: '',
        language: 'ja',
      }),
    ).toThrow('needs the term');
    store.deleteGlossaryTerm(g.id);
    expect(store.listGlossary(p.id)).toHaveLength(0);
  });

  it('fills in accepted translations and summaries, and records it', () => {
    const p = project();
    const t = store.createTask(p.id, input());
    const kept = store.createTask(p.id, input({ summary: 'Mine' }));
    const [a, b] = store.applyAiResults([
      {
        taskId: t.id,
        title: 'Login screen times out',
        description: 'Para 1\n\nPara 2',
        summary: 'Sessions expire too early.',
      },
      { taskId: kept.id, title: 'Second', summary: '' },
    ]);
    expect(a).toMatchObject({
      titleTranslation: 'Login screen times out',
      descriptionTranslation: 'Para 1\n\nPara 2',
      summary: 'Sessions expire too early.',
      translationState: 'Translated',
    });
    expect(b.summary).toBe('Mine');
    expect(store.listActivity(t.id)[0]).toMatchObject({
      kind: 'AI batch',
      text: 'Filled in the translation and summary from a Gemini batch.',
    });
  });
});

describe('backups', () => {
  it('writes one backup a day and keeps the last 14', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worksync-backup-'));
    const file = path.join(dir, 'w.db');
    const disk = new DatabaseSync(file);
    migrate(disk);
    for (let d = 1; d <= 16; d++)
      backupDaily(
        disk,
        path.join(dir, 'b'),
        `2026-10-${String(d).padStart(2, '0')}`,
      );
    expect(backupDaily(disk, path.join(dir, 'b'), '2026-10-16')).toBeNull();
    const kept = fs.readdirSync(path.join(dir, 'b')).sort();
    expect(kept).toHaveLength(14);
    expect(kept[0]).toBe('worksync-2026-10-03.db');
    const copy = new DatabaseSync(path.join(dir, 'b', kept[13]));
    expect(
      (copy.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version,
    ).toBe(SCHEMA_VERSION);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('people', () => {
  it('keeps people per project and refuses a spelling used twice', () => {
    const p = project();
    const a = store.savePerson({
      projectId: p.id,
      name: '田中',
      displayName: 'Tanaka',
      side: 'customer',
      spellings: ['田中太郎', ' 田中 ', ''],
    });
    expect(a.spellings).toEqual(['田中太郎']);
    expect(() =>
      store.savePerson({
        projectId: p.id,
        name: '田中太郎',
        displayName: 'T',
        side: 'ours',
        spellings: [],
      }),
    ).toThrow(/already/);
    store.savePerson({ ...a, displayName: 'Tanaka-san' });
    expect(store.listPeople(p.id)[0].displayName).toBe('Tanaka-san');
    store.deletePerson(a.id);
    expect(store.listPeople()).toHaveLength(0);
  });
});

describe('deleting a project', () => {
  it('removes everything WorkSync keeps for it, and nothing of other projects', () => {
    const p = project();
    const other = store.createProject({
      name: 'Other',
      customer: '',
      originalLanguages: ['ja'],
      workingLanguage: 'en',
    });
    const t = store.createTask(p.id, input());
    store.addSituationUpdate(t.id, { doingNow: 'Testing' });
    store.saveGlossaryTerm({
      projectId: p.id,
      term: '受入',
      translation: 'acceptance',
      language: 'ja',
      note: '',
    });
    store.savePerson({
      projectId: p.id,
      name: '田中',
      displayName: 'Tanaka',
      side: 'customer',
      spellings: [],
    });
    store.saveOwnerTranslations([
      {
        taskId: t.id,
        field: 'doingNow',
        language: 'ja',
        source: 'Testing',
        text: '確認中',
      },
    ]);
    const kept = store.createTask(other.id, input());
    expect(store.deleteProject(p.id)).toEqual({ tasks: 1 });
    expect(store.listProjects().map((x) => x.id)).toEqual([other.id]);
    expect(store.listTasks().map((x) => x.id)).toEqual([kept.id]);
    const count = (sql: string, ...args: string[]) =>
      (db.prepare(sql).get(...args) as { n: number }).n;
    for (const table of [
      'situation_updates',
      'glossary_terms',
      'people',
      'owner_translations',
    ])
      expect(count(`SELECT COUNT(*) AS n FROM ${table}`), table).toBe(0);
    expect(
      count('SELECT COUNT(*) AS n FROM activity WHERE task_id = ?', t.id),
    ).toBe(0);
    expect(() => store.deleteProject(p.id)).toThrow();
  });
});

describe('links on a task', () => {
  it('keeps web addresses and paths, refuses anything else, and records it', () => {
    const t = store.createTask(project().id, input());
    const u = store.setLinks(t.id, [
      { name: 'Spec', target: ' https://example.com/spec ' },
      { name: '', target: '\\\\fs01\\share\\WBS.xlsx' },
      { name: '', target: 'D:\\Docs\\a.pdf' },
      { name: 'blank', target: ' ' },
    ]);
    expect(u.links.map((l) => l.target)).toEqual([
      'https://example.com/spec',
      '\\\\fs01\\share\\WBS.xlsx',
      'D:\\Docs\\a.pdf',
    ]);
    expect(() =>
      store.setLinks(t.id, [{ name: '', target: 'javascript:alert(1)' }]),
    ).toThrow(/not a web address/);
    expect(store.listActivity(t.id)[0].text).toMatch(/Added link Spec/);
  });
});

describe('the language of a task', () => {
  it('keeps the language the owner chose until they go back to detecting it', () => {
    const t = store.createTask(
      project().id,
      input({ titleOriginal: 'Login API' }),
    );
    expect(t.language).toBe('en');
    const j = store.updateTask(t.id, { language: 'ja', languageSet: true });
    expect(j).toMatchObject({
      language: 'ja',
      languageSet: true,
      translationState: 'Not translated',
    });
    // A new title no longer changes it.
    expect(
      store.updateTask(t.id, { titleOriginal: 'Login API v2' }).language,
    ).toBe('ja');
    const back = store.updateTask(t.id, { languageSet: false });
    expect(back).toMatchObject({
      language: 'en',
      languageSet: false,
      translationState: 'Not needed',
    });
    expect(store.listActivity(t.id)[0].text).toMatch(
      /Language Japanese → English/,
    );
  });
});

describe('tasks from a file', () => {
  it('keep the file’s No. and description; the title can be edited', () => {
    const t = store.createTask(project().id, input({ customerId: '12' }));
    db.prepare("UPDATE tasks SET source = 'file' WHERE id = ?").run(t.id);
    expect(() => store.updateTask(t.id, { customerId: '13' })).toThrow(
      /come from the customer/,
    );
    expect(() =>
      store.updateTask(t.id, { descriptionOriginal: 'x' }),
    ).toThrow();
    expect(
      store.updateTask(t.id, { titleOriginal: 'My title' }).titleOriginal,
    ).toBe('My title');
    expect(
      store.updateProject(t.projectId, { showNumbers: false }).showNumbers,
    ).toBe(false);
    // The same values, as the form sends them, are fine.
    expect(
      store.updateTask(t.id, { customerId: '12', summary: 'Mine' }).summary,
    ).toBe('Mine');
  });
});

describe('Board columns', () => {
  it('moves tasks into own columns and back when one is deleted', () => {
    const p = project();
    const t = store.createTask(p.id, input({ status: 'In review' }));
    store.setBoard(p.id, {
      hidden: [],
      columns: [{ id: 'w', name: 'Waiting for test', status: 'In review' }],
    });
    expect(store.setBoardColumn(t.id, 'w').boardColumn).toBe('w');
    expect(store.listActivity(t.id)[0].text).toMatch(/Waiting for test/);
    store.updateTask(t.id, { status: 'Done' });
    expect(() => store.setBoardColumn(t.id, 'w')).toThrow(/In review first/);
    store.setBoard(p.id, { hidden: [], columns: [] });
    expect(store.getTask(t.id).boardColumn).toBeNull();
  });
});

describe('checks from the test report', () => {
  it('refuses a number another task of the project has (B2)', () => {
    const p = project();
    const a = store.createTask(p.id, input({ customerId: '012' }));
    store.createTask(p.id, input({ customerId: '018' }));
    expect(() => store.createTask(p.id, input({ customerId: '012' }))).toThrow(
      /already used/,
    );
    expect(() => store.updateTask(a.id, { customerId: '018' })).toThrow(
      /already used/,
    );
    expect(
      store.updateTask(a.id, { customerId: '012', summary: 'x' }).summary,
    ).toBe('x');
  });

  it('refuses a project without a name or an original language (B3, B8)', () => {
    const p = project();
    expect(() => store.updateProject(p.id, { originalLanguages: [] })).toThrow(
      /at least one/,
    );
    expect(() => store.updateProject(p.id, { name: '   ' })).toThrow(
      /needs a name/,
    );
    expect(() => store.updateProject(p.id, { dueSoonDays: 0 })).toThrow();
  });

  it('refuses an end before its start, only when the owner sets it (B4)', () => {
    const p = project();
    expect(() =>
      store.createTask(
        p.id,
        input({ plannedStart: '2026-11-10', plannedEnd: '2026-11-01' }),
      ),
    ).toThrow(/planned end is before/);
    const t = store.createTask(p.id, input({ actualStart: '2026-11-10' }));
    expect(() => store.updateTask(t.id, { actualEnd: '2026-11-01' })).toThrow(
      /actual end is before/,
    );
  });

  it('refuses a second translation for a glossary term (B5)', () => {
    const p = project();
    store.saveGlossaryTerm({
      projectId: p.id,
      term: '在庫照会',
      translation: 'stock lookup',
      language: 'ja',
      note: '',
    });
    expect(() =>
      store.saveGlossaryTerm({
        projectId: p.id,
        term: ' 在庫照会 ',
        translation: 'stock inquiry',
        language: 'ja',
        note: '',
      }),
    ).toThrow(/already in the glossary/);
  });

  it('numbers new tasks like the project already does (B17)', () => {
    const p = project();
    expect(store.createTask(p.id, input()).customerId).toBe('001');
    const q = store.createProject({
      name: 'Q',
      customer: '',
      originalLanguages: ['ja'],
      workingLanguage: 'en',
    });
    store.createTask(q.id, input({ customerId: '9' }));
    expect(store.createTask(q.id, input()).customerId).toBe('10');
  });

  it('gives a hand task that becomes Done today as its actual end (B9)', () => {
    const t = store.createTask(project().id, input({ status: 'In progress' }));
    expect(store.updateTask(t.id, { status: 'Done' }).actualEnd).toBe(
      clock.slice(0, 10),
    );
  });
});

describe('checks from the second test report', () => {
  it('sets the actual end when the form sets Done with an empty date (N2)', () => {
    const t = store.createTask(project().id, input({ status: 'In progress' }));
    // The edit form sends every field, the empty date too.
    const u = store.updateTask(t.id, {
      ...input({ status: 'Done' }),
      customerId: t.customerId,
    });
    expect(u.actualEnd).toBe(clock.slice(0, 10));
    // A date the owner typed is kept.
    const t2 = store.createTask(t.projectId, input({ status: 'In progress' }));
    expect(
      store.updateTask(t2.id, { status: 'Done', actualEnd: '2026-10-30' })
        .actualEnd,
    ).toBe('2026-10-30');
  });

  it('refuses a Board column named like a status or another column (N1)', () => {
    const p = project();
    expect(() =>
      store.setBoard(p.id, {
        hidden: [],
        columns: [{ id: 'a', name: 'on hold', status: 'In review' }],
      }),
    ).toThrow(/already a column called on hold/);
    expect(() =>
      store.setBoard(p.id, {
        hidden: [],
        columns: [
          { id: 'a', name: 'Waiting', status: 'In review' },
          { id: 'b', name: 'waiting', status: 'Done' },
        ],
      }),
    ).toThrow(/already a column/);
  });
});
