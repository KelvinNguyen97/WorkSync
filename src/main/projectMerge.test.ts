import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskInput } from '../shared/model';
import { migrate } from './db';
import { Mine } from './mine';
import {
  applyMerge,
  mergeTargets,
  planMerge,
  startMerge,
} from './projectMerge';
import { exportProject, importProject, readExport } from './projectTransfer';
import { Store } from './store';

const input = (o: Partial<TaskInput> = {}): TaskInput => ({
  customerId: '',
  titleOriginal: 'Task',
  titleTranslation: '',
  descriptionOriginal: '',
  descriptionTranslation: '',
  summary: '',
  notes: '',
  status: 'In progress',
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
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-merge-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** One WorkSync: its own database, so its own id. */
const install = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return { db, store: new Store(db), mine: new Mine(db) };
};
const exp = (db: DatabaseSync, projectId: string) =>
  exportProject(
    db,
    projectId,
    { includeNotes: true },
    new Date().toISOString(),
  );
const snap = () => path.join(dir, 'snapshots');

describe('merging a copy back into the project', () => {
  it('takes what only one side changed and asks only where both did', () => {
    // A makes the project and gives a copy to B.
    const a = install();
    const p = a.store.createProject({
      name: 'Portal',
      customer: 'Hoshizora',
      originalLanguages: ['ja'],
      workingLanguage: 'en',
    });
    const t1 = a.store.createTask(
      p.id,
      input({ customerId: '1', titleOriginal: 'Login' }),
    );
    a.store.createTask(p.id, input({ customerId: '2', titleOriginal: 'CSV' }));
    const note = a.mine.saveNote({
      title: 'Checklist',
      body: 'Back up\nMigrate\nTell the warehouse',
      projectId: p.id,
    });
    const b = install();
    const imported = importProject(
      b.db,
      exp(a.db, p.id),
      snap(),
      new Date().toISOString(),
    );
    const bt = (no: string) =>
      b.store.listTasks().find((t) => t.customerId === no)!;

    // Both work on it.
    a.store.updateTask(t1.id, { status: 'In review' });
    a.store.addSituationUpdate(t1.id, { doingNow: 'Checking the fix' });
    a.mine.saveNote(
      { body: 'Back up\nMigrate\nCheck SSL\nTell the warehouse' },
      note.id,
    );
    b.store.updateTask(bt('1').id, { summary: 'Fix on staging' });
    b.store.addSituationUpdate(bt('1').id, { doingNow: 'Waiting for data' });
    b.store.updateTask(bt('2').id, { status: 'On hold' });
    b.store.createTask(
      imported.projectId,
      input({ customerId: '3', titleOriginal: 'SAP export' }),
    );
    const bNote = new Mine(b.db).listNotes()[0];
    b.mine.saveNote(
      { body: 'Back up\nMigrate\nFreeze batches\nTell the warehouse' },
      bNote.id,
    );

    // B sends their copy back; A merges it.
    const fileB = readExport(exp(b.db, imported.projectId));
    expect(mergeTargets(a.db, fileB).map((x) => x.id)).toEqual([p.id]);
    const m = startMerge(a.db, fileB, p.id);
    expect(m.baseAt).not.toBeNull();
    const plan = planMerge(m);
    expect(plan.auto.map((x) => [x.tag, x.where.no, x.fields])).toEqual(
      expect.arrayContaining([
        ['Changes', '1', ['Summary']],
        ['Changes', '2', ['Status']],
        ['New ticket', '3', []],
      ]),
    );
    expect(plan.questions.map((q) => q.kind).sort()).toEqual([
      'note',
      'timeline',
    ]);
    const noteQ = plan.questions.find((q) => q.kind === 'note')!;
    const r = applyMerge(
      a.db,
      m,
      { answers: { [noteQ.id]: 'both' } },
      { snapshotRoot: snap(), now: new Date().toISOString() },
    );
    expect(r.added).toBe(1);
    const at = (no: string) =>
      a.store.listTasks().find((t) => t.customerId === no)!;
    expect(at('1')).toMatchObject({
      status: 'In review',
      summary: 'Fix on staging',
    });
    expect(at('2').status).toBe('On hold');
    expect(at('3').titleOriginal).toBe('SAP export');
    expect(new Mine(a.db).getNote(note.id).body).toBe(
      'Back up\nMigrate\nCheck SSL\nFreeze batches\nTell the warehouse',
    );
    // Both situation updates are in the history; the newest is the situation.
    const hist = a.db
      .prepare(
        'SELECT doing_now FROM situation_updates WHERE task_id = ? ORDER BY at',
      )
      .all(t1.id)
      .map((x) => (x as { doing_now: string }).doing_now);
    expect(hist).toEqual(['Checking the fix', 'Waiting for data']);
    expect(at('1').situation.doingNow).toBe('Waiting for data');

    // A sends the merged project to B: B takes it all without a question.
    const fileA2 = readExport(exp(a.db, p.id));
    const m2 = startMerge(b.db, fileA2, imported.projectId);
    const plan2 = planMerge(m2);
    expect(plan2.questions).toEqual([]);
    applyMerge(
      b.db,
      m2,
      {},
      { snapshotRoot: snap(), now: new Date().toISOString() },
    );
    expect(bt('1')).toMatchObject({
      status: 'In review',
      summary: 'Fix on staging',
    });
    expect(new Mine(b.db).getNote(bNote.id).body).toContain('Check SSL');
    expect(b.store.listTasks()).toHaveLength(3);
  });

  it('refuses a file that is not a copy of the project', () => {
    const a = install();
    const p = a.store.createProject({
      name: 'Portal',
      customer: '',
      originalLanguages: ['ja'],
      workingLanguage: 'en',
    });
    const q = a.store.createProject({
      name: 'Other',
      customer: '',
      originalLanguages: ['ja'],
      workingLanguage: 'en',
    });
    const file = readExport(exp(a.db, p.id));
    expect(() => startMerge(a.db, file, q.id)).toThrow(/not a copy/);
  });
});

describe('tasks and discussions travel with the project', () => {
  it('exports, imports and merges them, with their files and history', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { migrate } = await import('./db');
    const { Store } = await import('./store');
    const { Work, meAsMember } = await import('./work');
    const { Discussions } = await import('./discussions');
    const { exportProject, importProject, readExport } =
      await import('./projectTransfer');
    const { startMerge, planMerge, applyMerge } =
      await import('./projectMerge');
    const { EMPTY_TASK_INPUT } = await import('../shared/model');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-work-'));
    let clock = '2026-11-17T09:00:00.000Z';
    const mk = () => {
      const db = new DatabaseSync(':memory:');
      db.exec('PRAGMA foreign_keys = ON');
      migrate(db);
      const store = new Store(db, () => clock);
      const work = new Work(
        db,
        () => [meAsMember(db)],
        () => clock,
      );
      return {
        db,
        store,
        work,
        dis: new Discussions(db, store, work, () => clock),
      };
    };
    const a = mk();
    const p = a.store.createProject({
      name: 'P',
      customer: '',
      originalLanguages: ['ja'],
      workingLanguage: 'en',
    });
    const t = a.store.createTask(p.id, {
      ...EMPTY_TASK_INPUT,
      customerId: '015',
      titleOriginal: 'Batch',
    });
    const d = a.dis.link(a.dis.save(p.id, { title: 'Why it stops' }).id, t.id);
    const c = a.dis.addComment(d.id, {
      body: 'Look',
      files: [
        {
          name: 'log.txt',
          type: 'text/plain',
          bytes: new Uint8Array([1, 2, 3]),
        },
      ],
    });
    clock = '2026-11-17T09:01:00.000Z';
    a.dis.addComment(d.id, { body: 'Agreed', parentId: c.id });
    const job = a.work.saveTask(p.id, {
      title: 'Collect logs',
      ticketId: t.id,
      discussionId: null,
    });
    a.work.saveTask(p.id, { status: 'doing' }, job.id);
    const file = exportProject(a.db, p.id, { includeNotes: true }, clock);

    // A colleague imports it: everything is there, pointing at the right rows.
    const b = mk();
    const got = importProject(b.db, file, path.join(tmp, 'b'), clock);
    const bd = b.dis.list(got.projectId)[0];
    expect(bd).toMatchObject({
      title: 'Why it stops',
      no: '015',
      commentCount: 2,
    });
    const bc = b.dis.comments(bd.id);
    expect([...b.dis.attachment(bc[0].attachments[0].id).data]).toEqual([
      1, 2, 3,
    ]);
    expect(bc[1].parentId).toBe(bc[0].id);
    const bj = b.work.listTasks(got.projectId)[0];
    expect(bj).toMatchObject({ title: 'Collect logs', status: 'doing' });
    expect(bj.ticketId).toBe(b.store.listTasks()[0].id);
    expect(b.work.history(bj.id).length).toBe(2);

    // They add a comment and finish the task; the owner merges their copy back.
    clock = '2026-11-17T10:00:00.000Z';
    b.dis.addComment(bd.id, { body: 'Fixed on Stg' });
    b.work.saveTask(got.projectId, { status: 'done' }, bj.id);
    b.work.saveTask(got.projectId, { title: 'Their new task' });
    const back = exportProject(
      b.db,
      got.projectId,
      { includeNotes: true },
      clock,
    );
    const x = readExport(back);
    const m = startMerge(a.db, x, p.id);
    const plan = planMerge(m);
    expect(plan.questions).toEqual([]);
    expect(plan.auto.map((i) => i.tag).sort()).toEqual(
      expect.arrayContaining(['Changes', 'Task']),
    );
    applyMerge(a.db, m, {}, { snapshotRoot: path.join(tmp, 'a'), now: clock });
    expect(a.dis.comments(d.id).map((x) => x.body)).toEqual([
      'Look',
      'Agreed',
      'Fixed on Stg',
    ]);
    expect([
      ...a.dis.attachment(a.dis.comments(d.id)[0].attachments[0].id).data,
    ]).toEqual([1, 2, 3]);
    expect(a.work.getTask(job.id).status).toBe('done');
    expect(
      a.work
        .listTasks(p.id)
        .map((x) => x.title)
        .sort(),
    ).toEqual(['Collect logs', 'Their new task']);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
