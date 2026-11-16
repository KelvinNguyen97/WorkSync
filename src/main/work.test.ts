import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './db';
import { Store } from './store';
import { Work, meAsMember } from './work';
import { Discussions } from './discussions';
import { EMPTY_TASK_INPUT } from '../shared/model';

let db: DatabaseSync;
let store: Store;
let work: Work;
let dis: Discussions;
let clock = '2026-11-16T09:00:00.000Z';
let projectId = '';

beforeEach(() => {
  clock = '2026-11-16T09:00:00.000Z';
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  store = new Store(db, () => clock);
  work = new Work(
    db,
    () => [meAsMember(db)],
    () => clock,
  );
  dis = new Discussions(db, store, work, () => clock);
  projectId = store.createProject({
    name: 'P',
    customer: '',
    originalLanguages: ['ja'],
    workingLanguage: 'en',
  }).id;
});

const ticket = (no: string, title = 'Batch stops') =>
  store.createTask(projectId, {
    ...EMPTY_TASK_INPUT,
    customerId: no,
    titleOriginal: title,
  });

describe('project tasks', () => {
  it('makes, moves on and completes a task, keeping who did it', () => {
    const t = ticket('025');
    const me = work.me();
    const x = work.saveTask(projectId, {
      title: 'Test on Stg',
      assignee: me,
      ticketId: t.id,
    });
    expect(x).toMatchObject({ status: 'todo', madeBy: me, ticketId: t.id });
    expect(work.assignedToMe().map((y) => y.id)).toEqual([x.id]);
    clock = '2026-11-16T10:00:00.000Z';
    const d = work.saveTask(projectId, { status: 'done' }, x.id);
    expect(d).toMatchObject({ status: 'done', doneBy: me, doneAt: clock });
    expect(work.assignedToMe()).toEqual([]);
    expect(work.history(x.id).map((h) => h.text)).toEqual([
      'Status: To do → Done.',
      expect.stringMatching(/^Made and assigned to /),
    ]);
  });
  it('assigns only to members, and a deleted ticket leaves the task without one', () => {
    expect(() =>
      work.saveTask(projectId, { title: 'x', assignee: 'stranger' }),
    ).toThrow(/member of the workspace/);
    const t = ticket('026');
    const x = work.saveTask(projectId, { title: 'y', ticketId: t.id });
    store.deleteTask(t.id);
    expect(work.getTask(x.id).ticketId).toBeNull();
  });
  it('moves a My tasks item into a project', () => {
    const x = work.moveToProject(projectId, {
      title: 'Renew',
      description: 'note',
      dueDate: '2026-11-20',
      priority: 'U',
      status: 'ongoing',
    });
    expect(x).toMatchObject({
      title: 'Renew',
      note: 'note',
      priority: 'U',
      status: 'doing',
      assignee: work.me(),
    });
  });
});

describe('discussions', () => {
  it('links by No., follows the progress ticket and unlinks without a number', () => {
    const t = ticket('025');
    const d = dis.save(projectId, { title: 'Why it stops', no: '' });
    expect(dis.progressWithNo(projectId, '025')?.id).toBe(t.id);
    const l = dis.link(d.id, t.id);
    expect(l).toMatchObject({ no: '025', linkedTaskId: t.id });
    store.updateTask(t.id, { customerId: '125' });
    expect(dis.get(d.id).no).toBe('125');
    const other = dis.save(projectId, { title: 'Another' });
    expect(() => dis.link(other.id, t.id)).toThrow(/already linked/);
    expect(dis.unlink(d.id)).toMatchObject({ no: '', linkedTaskId: null });
  });
  it('makes a progress ticket from a discussion with its number', () => {
    const d = dis.save(projectId, { title: 'Receipt layout', no: '031' });
    const r = dis.makeProgress(d.id);
    expect(r.task.customerId).toBe('031');
    expect(r.discussion.linkedTaskId).toBe(r.task.id);
  });
  it('keeps comments, replies one level deep, edits for 15 minutes and deletes visibly', () => {
    const d = dis.save(projectId, { title: 'T' });
    const a = dis.addComment(d.id, { body: 'First' });
    const b = dis.addComment(d.id, { body: 'Reply', parentId: a.id });
    const c = dis.addComment(d.id, { body: 'Reply to reply', parentId: b.id });
    expect(c.parentId).toBe(a.id);
    expect(dis.editComment(a.id, 'First!').body).toBe('First!');
    clock = '2026-11-16T09:20:00.000Z';
    expect(() => dis.editComment(a.id, 'late')).toThrow(/15 minutes/);
    expect(dis.deleteComment(b.id)).toMatchObject({ deleted: true, body: '' });
    expect(dis.get(d.id).commentCount).toBe(2);
  });
  it('stores files with a comment, at most 25 MB each', () => {
    const d = dis.save(projectId, { title: 'T' });
    const c = dis.addComment(d.id, {
      body: '',
      files: [
        {
          name: 'shot.png',
          type: 'image/png',
          bytes: new Uint8Array([1, 2, 3]),
        },
      ],
    });
    expect(c.attachments).toMatchObject([{ name: 'shot.png', size: 3 }]);
    expect([...dis.attachment(c.attachments[0].id).data]).toEqual([1, 2, 3]);
    expect(() =>
      dis.addComment(d.id, {
        body: 'big',
        files: [
          {
            name: 'big.bin',
            type: '',
            bytes: new Uint8Array(25 * 1024 * 1024 + 1),
          },
        ],
      }),
    ).toThrow(/25 MB/);
  });
  it('summarizes into the progress ticket and counts only newer comments next time', () => {
    const t = ticket('025');
    const d = dis.link(dis.save(projectId, { title: 'T' }).id, t.id);
    store.addSituationUpdate(t.id, {
      newDifficulty: { text: 'Memory runs out', resolver: '' },
    });
    dis.addComment(d.id, { body: 'Use streaming' });
    clock = '2026-11-16T09:05:00.000Z';
    dis.addComment(d.id, { body: 'Agreed' });
    expect(
      dis.summaryItems([d.id], () => 'Yamada')[0].discussion.comments,
    ).toHaveLength(2);
    clock = '2026-11-16T09:10:00.000Z';
    const after = dis.applySummary(d.id, {
      doingNow: 'Switching to streaming',
      nextStep: 'Test on Stg',
      nextDate: '2026-11-21',
      resolved: ['memory runs out'],
      status: 'In review',
    });
    expect(after.situation).toMatchObject({
      doingNow: 'Switching to streaming',
      nextDate: '2026-11-21',
    });
    expect(after.difficulties[0].open).toBe(false);
    expect(after.status).toBe('In review');
    expect(dis.get(d.id).newSinceSummary).toBe(0);
    clock = '2026-11-16T09:15:00.000Z';
    dis.addComment(d.id, { body: 'Stg is ready' });
    expect(dis.get(d.id).newSinceSummary).toBe(1);
    expect(
      store
        .listActivity(t.id)
        .some((a) => a.text === 'Updated from discussion 025, comments 1–2.'),
    ).toBe(true);
  });
  it('keeps the discussion when its progress ticket is deleted, without a number', () => {
    const t = ticket('025');
    const d = dis.link(dis.save(projectId, { title: 'T' }).id, t.id);
    dis.ticketDeleted(t.id);
    store.deleteTask(t.id);
    expect(dis.get(d.id)).toMatchObject({ linkedTaskId: null, no: '' });
  });
});
