import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './db';
import { Store } from './store';
import { Work, myMemberId, setMyMemberId } from './work';
import { Discussions } from './discussions';
import { Workspaces } from './workspace';
import { EMPTY_TASK_INPUT } from '../shared/model';

let folder: string;
let wall = Date.parse('2026-11-16T09:00:00Z');

interface Pc {
  db: DatabaseSync;
  store: Store;
  work: Work;
  dis: Discussions;
  ws: Workspaces;
  name: string;
}

function pc(
  name: string,
  account = `CORP\\${name.toLowerCase()}`,
  file = ':memory:',
): Pc {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  const now = () => new Date(wall).toISOString();
  const store = new Store(db, now);
  let ws: Workspaces;
  const work = new Work(db, (p) => ws.membersForProject(p) ?? [], now);
  const dis = new Discussions(db, store, work, now);
  ws = new Workspaces(db, {
    protector: { seal: (s) => `p:${s}`, open: (s) => s.slice(2) },
    now: () => new Date(wall),
    account: () => account,
    pcName: () => `PC-${name}`,
    myName: () => name,
    myMemberId: () => myMemberId(db),
    setMyMemberId: (id) => setMyMemberId(db, id),
    limit: 4000,
  });
  return { db, store, work, dis, ws, name };
}

async function join(a: Pc, b: Pc, wsId: string, as?: string) {
  const info = await b.ws.requestJoin(folder);
  expect(info.state).toBe('pending');
  const reqs = await a.ws.requests();
  const r = reqs.find((x) => x.name === b.name)!;
  // Both screens show the same code.
  expect(r.code).toBe(info.code);
  await a.ws.approve(wsId, r.pcId, as);
  await b.ws.syncWorkspace(wsId);
  expect((await b.ws.info(wsId))!.state).toBe('member');
}

const round = async (...pcs: Pc[]) => {
  for (const p of pcs) {
    wall += 1000;
    await p.ws.syncAll();
  }
};

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
  wall = Date.parse('2026-11-16T09:00:00Z');
});
afterEach(() => fs.rmSync(folder, { recursive: true, force: true }));

describe('shared workspaces', () => {
  it('creates, lets a PC in with a code, and shares a project both ways', async () => {
    const a = pc('Tanaka');
    const b = pc('Yamada');
    const w = await a.ws.create(folder, 'Team');
    const project = a.store.createProject({
      name: 'Portal',
      customer: '',
      originalLanguages: ['ja'],
      workingLanguage: 'en',
    });
    const t = a.store.createTask(project.id, {
      ...EMPTY_TASK_INPUT,
      customerId: '015',
      titleOriginal: 'Batch stops',
      notes: 'my private note',
    });
    a.store.updateTask(t.id, { nextAction: 'call them' } as never);
    await a.ws.share(w.id, project.id);
    // Nothing in the folder is readable in clear.
    const files = fs.readdirSync(
      path.join(folder, 'projects', project.id, 'log'),
      { recursive: true },
    ) as string[];
    const all = files
      .map((f) => path.join(folder, 'projects', project.id, 'log', f))
      .filter((f) => fs.statSync(f).isFile());
    for (const f of all)
      expect(fs.readFileSync(f, 'utf8')).not.toContain('Batch stops');

    await join(a, b, w.id);
    await round(b);
    const got = b.store.listTasks();
    expect(got.map((x) => [x.customerId, x.titleOriginal])).toEqual([
      ['015', 'Batch stops'],
    ]);
    // Private fields stay on their PC.
    expect(got[0].notes).toBe('');
    expect(got[0].nextAction).toBe('');
    expect(b.store.getProject(project.id).name).toBe('Portal');

    // B changes the status; A sees it.
    b.store.updateTask(t.id, { status: 'In progress' });
    await round(b, a);
    expect(a.store.getTask(t.id).status).toBe('In progress');
    expect(a.store.getTask(t.id).notes).toBe('my private note');

    // Tasks can be assigned to the other member, who is told.
    const members = a.work.membersOf(project.id);
    expect(members.map((m) => m.name).sort()).toEqual(['Tanaka', 'Yamada']);
    const yamada = members.find((m) => m.name === 'Yamada')!;
    a.work.saveTask(project.id, {
      title: 'Test on Stg',
      assignee: yamada.id,
      ticketId: t.id,
    });
    await round(a, b);
    expect(b.work.assignedToMe().map((x) => x.title)).toEqual(['Test on Stg']);
    expect(
      b.ws
        .notices()
        .some(
          (n) =>
            n.kind === 'assigned' &&
            /gave you a task: Test on Stg/.test(n.text),
        ),
    ).toBe(true);
  });

  it('the later change wins, both stay in history, deletions are not brought back', async () => {
    const a = pc('Tanaka');
    const b = pc('Yamada');
    const w = await a.ws.create(folder, 'Team');
    const p = a.store.createProject({
      name: 'P',
      customer: '',
      originalLanguages: ['ja'],
      workingLanguage: 'en',
    });
    const t = a.store.createTask(p.id, {
      ...EMPTY_TASK_INPUT,
      titleOriginal: 'One',
    });
    const u = a.store.createTask(p.id, {
      ...EMPTY_TASK_INPUT,
      titleOriginal: 'Two',
    });
    await a.ws.share(w.id, p.id);
    await join(a, b, w.id);
    await round(b);
    // Both change the status; B's change is later.
    a.store.updateTask(t.id, { status: 'On hold' });
    wall += 5000;
    b.store.updateTask(t.id, { status: 'Done' });
    await round(a, b, a);
    expect(a.store.getTask(t.id).status).toBe('Done');
    expect(b.store.getTask(t.id).status).toBe('Done');
    expect(
      a.store
        .listActivity(t.id)
        .map((x) => x.text)
        .filter((x) => /Status/.test(x)).length,
    ).toBe(2);
    // A deletes a ticket; it stays deleted on B even though B had it.
    a.store.deleteTask(u.id);
    await round(a, b, a);
    expect(b.store.listTasks().map((x) => x.titleOriginal)).toEqual(['One']);
    expect(a.store.listTasks().map((x) => x.titleOriginal)).toEqual(['One']);
  });

  it('keeps changes made offline and sends them when the folder is back', async () => {
    const a = pc('Tanaka');
    const b = pc('Yamada');
    const w = await a.ws.create(folder, 'Team');
    const p = a.store.createProject({
      name: 'P',
      customer: '',
      originalLanguages: ['ja'],
      workingLanguage: 'en',
    });
    await a.ws.share(w.id, p.id);
    await join(a, b, w.id);
    await round(b);
    b.ws.setOffline(w.id, true);
    const d = b.dis.save(p.id, { title: 'Offline talk' });
    b.dis.addComment(d.id, {
      body: 'Written on the train',
      files: [
        { name: 'a.png', type: 'image/png', bytes: new Uint8Array([9, 8]) },
      ],
    });
    await round(b);
    expect((await b.ws.info(w.id))!.waiting).toBe(4);
    b.ws.setOffline(w.id, false);
    await round(b, a);
    const got = a.dis.list(p.id);
    expect(got.map((x) => x.title)).toEqual(['Offline talk']);
    const c = a.dis.comments(got[0].id);
    expect(c[0].body).toBe('Written on the train');
    expect([...a.dis.attachment(c[0].attachments[0].id).data]).toEqual([9, 8]);
  });

  it('marks a number clash instead of renumbering', async () => {
    const a = pc('Tanaka');
    const b = pc('Yamada');
    const w = await a.ws.create(folder, 'Team');
    const p = a.store.createProject({
      name: 'P',
      customer: '',
      originalLanguages: ['ja'],
      workingLanguage: 'en',
    });
    await a.ws.share(w.id, p.id);
    await join(a, b, w.id);
    await round(b);
    a.store.createTask(p.id, {
      ...EMPTY_TASK_INPUT,
      customerId: '025',
      titleOriginal: 'Mine',
    });
    b.store.createTask(p.id, {
      ...EMPTY_TASK_INPUT,
      customerId: '025',
      titleOriginal: 'Theirs',
    });
    await round(a, b, a);
    expect(
      a.store.listTasks().filter((x) => x.customerId === '025'),
    ).toHaveLength(2);
    expect(a.ws.notices().some((n) => n.kind === 'clash')).toBe(true);
  });

  it('refuses a removed PC after a second member saw the removal, with a new key', async () => {
    const a = pc('Tanaka');
    const b = pc('Yamada');
    const c = pc('Suzuki');
    const w = await a.ws.create(folder, 'Team');
    const p = a.store.createProject({
      name: 'P',
      customer: '',
      originalLanguages: ['ja'],
      workingLanguage: 'en',
    });
    const t = a.store.createTask(p.id, {
      ...EMPTY_TASK_INPUT,
      titleOriginal: 'One',
    });
    await a.ws.share(w.id, p.id);
    await join(a, b, w.id);
    await join(a, c, w.id);
    await round(b, c);
    const suzuki = (await a.ws.members(w.id)).find((m) => m.name === 'Suzuki')!;
    await a.ws.remove(w.id, { memberId: suzuki.memberId });
    // Not yet: only the remover has seen it.
    expect(
      (await a.ws.members(w.id)).find((m) => m.name === 'Suzuki')!.pcs[0]
        .removed,
    ).toBe('pending');
    await round(b, a);
    expect(
      (await a.ws.members(w.id)).find((m) => m.name === 'Suzuki')!.pcs[0]
        .removed,
    ).toBe('yes');
    // Suzuki's later changes are refused.
    c.store.updateTask(t.id, { status: 'Cancelled' });
    await round(c, a, b);
    expect(a.store.getTask(t.id).status).toBe('Not started');
    expect(b.store.getTask(t.id).status).toBe('Not started');
    // Suzuki keeps a local copy and is out.
    expect(c.store.listProjects()).toHaveLength(1);
    expect(await c.ws.info(w.id)).toBeNull();
    // A and B still sync with the new key.
    b.store.updateTask(t.id, { status: 'Done' });
    await round(b, a);
    expect(a.store.getTask(t.id).status).toBe('Done');
  });

  it('lets a reinstalled PC in as the same member, and a recovery file lets a PC in alone', async () => {
    const a = pc('Tanaka');
    const w = await a.ws.create(folder, 'Team');
    const p = a.store.createProject({
      name: 'P',
      customer: '',
      originalLanguages: ['ja'],
      workingLanguage: 'en',
    });
    await a.ws.share(w.id, p.id);
    const tanakaId = myMemberId(a.db);
    const file = await a.ws.recoveryFile(w.id, 'correct horse');
    // A second PC of the same person.
    const a2 = pc('Tanaka');
    await a2.ws.requestJoin(folder);
    const r = (await a.ws.requests())[0];
    expect(r.looksLike.map((x) => x.memberId)).toEqual([tanakaId]);
    await a.ws.approve(w.id, r.pcId, tanakaId);
    await a2.ws.syncWorkspace(w.id);
    expect(myMemberId(a2.db)).toBe(tanakaId);
    const ms = await a.ws.members(w.id);
    expect(
      ms
        .filter((m) => !m.memberId.startsWith('recovery'))
        .map((m) => m.pcs.length),
    ).toEqual([2]);
    // Nobody else around: the recovery file lets a new PC in.
    const n = pc('Hoang');
    await expect(n.ws.joinWithRecovery(folder, file, 'wrong')).rejects.toThrow(
      /password/,
    );
    const info = await n.ws.joinWithRecovery(folder, file, 'correct horse');
    expect(info.state).toBe('member');
    await round(n);
    expect(n.store.listProjects().map((x) => x.name)).toEqual(['P']);
  });

  it('has nothing to send after receiving, and keeps files out of the comparison copy', async () => {
    const a = pc('Tanaka');
    const b = pc('Yamada');
    const w = await a.ws.create(folder, 'Team');
    const p = a.store.createProject({
      name: 'P',
      customer: '',
      originalLanguages: ['ja'],
      workingLanguage: 'en',
    });
    a.store.createTask(p.id, { ...EMPTY_TASK_INPUT, titleOriginal: 'One' });
    const d = a.dis.save(p.id, { title: 'D' });
    a.dis.addComment(d.id, {
      body: 'x',
      files: [
        { name: 'a.bin', type: '', bytes: new Uint8Array(50_000).fill(7) },
      ],
    });
    await a.ws.share(w.id, p.id);
    await join(a, b, w.id);
    await round(b, a, b);
    // What came in is not sent back.
    expect(b.ws.stage(p.id)).toBe(0);
    expect(a.ws.stage(p.id)).toBe(0);
    expect(
      fs.readdirSync(path.join(folder, 'projects', p.id, 'log')).length,
    ).toBe(1);
    const c = b.dis.comments(b.dis.list(p.id)[0].id)[0];
    expect(b.dis.attachment(c.attachments[0].id).data.length).toBe(50_000);
    for (const x of [a, b]) {
      const n = (
        x.db.prepare('SELECT SUM(LENGTH(data)) AS n FROM ws_rows').get() as {
          n: number;
        }
      ).n;
      expect(n).toBeLessThan(20_000);
    }
  });

  it('a removal wins over an edit made at the same time, and Undo brings the row back for all', async () => {
    const a = pc('Tanaka');
    const b = pc('Yamada');
    const w = await a.ws.create(folder, 'Team');
    const p = a.store.createProject({
      name: 'P',
      customer: '',
      originalLanguages: ['ja'],
      workingLanguage: 'en',
    });
    const t = a.store.createTask(p.id, {
      ...EMPTY_TASK_INPUT,
      titleOriginal: 'One',
    });
    const k = a.work.saveTask(p.id, { title: 'Job' });
    await a.ws.share(w.id, p.id);
    await join(a, b, w.id);
    await round(b);
    // A deletes the ticket; B, not knowing, edits it a moment later.
    a.store.deleteTask(t.id);
    await round(a);
    b.store.updateTask(t.id, { status: 'On hold' });
    await round(b, a, b, a);
    expect(a.store.listTasks()).toHaveLength(0);
    expect(b.store.listTasks()).toHaveLength(0);
    // A deletes a task and takes it back (Undo): B has it again.
    const gone = a.work.deleteTask(k.id);
    await round(a, b);
    expect(b.work.listTasks(p.id)).toHaveLength(0);
    a.work.restoreTask(gone);
    await round(a, b);
    expect(b.work.listTasks(p.id).map((x) => x.title)).toEqual(['Job']);
  });

  it('gets its own sent changes back after the database is put back to an older state', async () => {
    const a = pc('Tanaka');
    const w = await a.ws.create(folder, 'Team');
    const p = a.store.createProject({
      name: 'P',
      customer: '',
      originalLanguages: ['ja'],
      workingLanguage: 'en',
    });
    const t = a.store.createTask(p.id, {
      ...EMPTY_TASK_INPUT,
      titleOriginal: 'One',
    });
    await a.ws.share(w.id, p.id);
    const backup = path.join(
      folder,
      '..',
      `${path.basename(folder)}-backup.db`,
    );
    a.db.exec(`VACUUM INTO '${backup}'`);
    a.store.updateTask(t.id, { status: 'Done' });
    await round(a);
    // A backup from before the change is restored.
    const r = pc('Tanaka', undefined, backup);
    expect(r.store.getTask(t.id).status).toBe('Not started');
    await round(r);
    expect(r.store.getTask(t.id).status).toBe('Done');
    // And the next change goes out under a new number.
    r.store.updateTask(t.id, { status: 'Cancelled' });
    await round(r);
    r.db.close();
    fs.rmSync(backup, { force: true });
    const mine = fs.readdirSync(path.join(folder, 'projects', p.id, 'log'))[0];
    expect(
      fs.readdirSync(path.join(folder, 'projects', p.id, 'log', mine)).sort(),
    ).toEqual(['000001.wsc', '000002.wsc', '000003.wsc', 'head.wsh']);
  });

  it('knows the members and keeps working while the folder cannot be reached', async () => {
    const a = pc('Tanaka');
    const b = pc('Yamada');
    const w = await a.ws.create(folder, 'Team');
    const p = a.store.createProject({
      name: 'P',
      customer: '',
      originalLanguages: ['ja'],
      workingLanguage: 'en',
    });
    await a.ws.share(w.id, p.id);
    await join(a, b, w.id);
    await round(b);
    // WorkSync starts again with the shared drive gone.
    const away = `${folder}-away`;
    fs.renameSync(folder, away);
    const again = new Workspaces(b.db, {
      protector: { seal: (s) => `p:${s}`, open: (s) => s.slice(2) },
      now: () => new Date(wall),
      account: () => 'CORP\\yamada',
      pcName: () => 'PC-Yamada',
      myName: () => 'Yamada',
      myMemberId: () => myMemberId(b.db),
      setMyMemberId: (id) => setMyMemberId(b.db, id),
    });
    await again.syncAll();
    const info = (await again.info(w.id))!;
    expect(info.online).toBe(false);
    expect(info.problem).toMatch(/cannot be reached/);
    expect(
      again
        .membersForProject(p.id)!
        .map((m) => m.name)
        .sort(),
    ).toEqual(['Tanaka', 'Yamada']);
    b.store.createTask(p.id, {
      ...EMPTY_TASK_INPUT,
      titleOriginal: 'Made offline',
    });
    await again.syncAll();
    expect((await again.info(w.id))!.waiting).toBeGreaterThan(0);
    fs.renameSync(away, folder);
    wall += 1000;
    await again.syncAll();
    await round(a);
    expect(a.store.listTasks().map((x) => x.titleOriginal)).toEqual([
      'Made offline',
    ]);
  });

  it('ignores files nobody in the workspace signed', async () => {
    const a = pc('Tanaka');
    const w = await a.ws.create(folder, 'Team');
    const p = a.store.createProject({
      name: 'P',
      customer: '',
      originalLanguages: ['ja'],
      workingLanguage: 'en',
    });
    await a.ws.share(w.id, p.id);
    const fake = path.join(folder, 'projects', p.id, 'log', 'ffffffffffffffff');
    fs.mkdirSync(fake, { recursive: true });
    fs.writeFileSync(path.join(fake, 'head.wsh'), '{"v":1}');
    await round(a);
    expect((await a.ws.info(w.id))!.problems).toContain(
      `projects/${p.id}/log/ffffffffffffffff`,
    );
  });
});
