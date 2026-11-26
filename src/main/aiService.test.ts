import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './db';
import { Store } from './store';
import { Work, meAsMember } from './work';
import { Discussions } from './discussions';
import { AiService } from './aiService';
import { aiPlan, type PlanDeps } from './aiPlans';
import { AiCancelled, AiError, type ProviderSettings } from './aiProvider';
import { EMPTY_TASK_INPUT, type Task } from '../shared/model';
import type { AiProgress, AiStatus } from '../shared/ai';

let db: DatabaseSync;
let store: Store;
let work: Work;
let dis: Discussions;
let clock = '2026-11-26T09:00:00.000Z';
let projectId = '';
let settings: ProviderSettings & { aiRequestSize: number };
let answers: ((prompt: string) => string | Promise<string>)[];
let asked: string[];
let progress: (AiProgress | null)[];
let statuses: AiStatus[];

const deps = (): PlanDeps => ({
  store,
  discussions: dis,
  members: () => [meAsMember(db)],
  fileLanguage: () => null,
});

const service = (
  extra: Partial<ConstructorParameters<typeof AiService>[0]> = {},
) =>
  new AiService({
    db: () => db,
    settings: () => settings,
    plan: (job, max, from) => aiPlan(deps(), job, max, from),
    log: (taskId, text) => store.log(taskId, 'AI', text),
    progress: (p) => progress.push(p),
    statusChanged: (s) => statuses.push(s),
    now: () => clock,
    ask: async (_s, prompt, signal) => {
      asked.push(prompt);
      if (signal?.aborted) throw new AiCancelled();
      const next = answers.shift();
      if (!next) throw new AiError('No answer prepared.');
      return next(prompt);
    },
    check: async () => 'Claude Code 2.1.330',
    test: async () => 'Claude Code 2.1.330 · answered in 2 s',
    ...extra,
  });

beforeEach(() => {
  clock = '2026-11-26T09:00:00.000Z';
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
  settings = {
    aiProvider: 'claude',
    claudePath: null,
    codexPath: null,
    claudeModel: '',
    codexModel: '',
    localUrl: 'http://localhost:11434',
    localModel: '',
    aiTimeoutSec: 300,
    aiRequestSize: 20_000,
  };
  answers = [];
  asked = [];
  progress = [];
  statuses = [];
});

const ticket = (no: string, title: string, o: Partial<Task> = {}) =>
  store.createTask(projectId, {
    ...EMPTY_TASK_INPUT,
    customerId: no,
    titleOriginal: title,
    language: 'ja',
    ...o,
  } as never);

const block = (no: string, title: string, summary: string) =>
  `=== TICKET ${no} ===\nTITLE: ${title}\nSUMMARY: ${summary}\n=== END ===`;

describe('one-click jobs', () => {
  it('translates and summarizes, keeps your own summary, and undoes', async () => {
    const a = ticket('012', 'バッチが途中で止まる');
    const b = ticket('013', 'ラベルが切れる', { summary: 'Mine' });
    answers.push(() =>
      [
        block('012', 'Batch stops halfway', 'The nightly batch stops.'),
        block('013', 'Label is cut off', 'Address cut after line 2.'),
      ].join('\n'),
    );
    const ai = service();
    await ai.check();
    const r = await ai.run({
      kind: 'translate',
      projectId,
      taskIds: [a.id, b.id],
    });
    expect(r).toMatchObject({ applied: 2, missing: 0, failure: null });
    expect(r.taskIds.sort()).toEqual([a.id, b.id].sort());
    expect(asked[0]).toContain('=== TICKET 012 (Japanese) ===');
    expect(store.getTask(a.id)).toMatchObject({
      titleTranslation: 'Batch stops halfway',
      summary: 'The nightly batch stops.',
      translationState: 'Translated',
    });
    // Your own summary is never replaced.
    expect(store.getTask(b.id).summary).toBe('Mine');
    expect(
      store
        .listActivity(a.id)
        .some(
          (x) =>
            x.text ===
            'Filled in the translation and summary from Claude Code.',
        ),
    ).toBe(true);
    expect(progress).toEqual([
      { job: 'translate', at: 1, of: 1, items: 2 },
      null,
    ]);

    // An edit made after the job stays when the job is undone.
    clock = '2026-11-26T09:05:00.000Z';
    store.updateTask(b.id, { titleTranslation: 'My own title' });
    const undone = ai.undo(r.undoId!);
    expect(undone.sort()).toEqual([a.id, b.id].sort());
    expect(store.getTask(a.id)).toMatchObject({
      titleTranslation: '',
      summary: '',
      translationState: 'Not translated',
    });
    expect(store.getTask(b.id).titleTranslation).toBe('My own title');
    expect(store.listActivity(a.id)[0].text).toBe(
      'Undid what Claude Code filled in.',
    );
    expect(() => ai.undo(r.undoId!)).toThrow(/no longer/);
  });

  it('asks again once when the answer cannot be read, then stops and falls back', async () => {
    const a = ticket('012', 'バッチが止まる');
    answers.push(
      () => 'Sorry, I cannot help with that.',
      () => block('012', 'Batch stops', 'It stops.'),
    );
    const ai = service();
    await ai.check();
    const ok = await ai.run({ kind: 'translate', projectId, taskIds: [a.id] });
    expect(ok.applied).toBe(1);
    expect(asked).toHaveLength(2);

    const b = ticket('013', 'ラベル');
    answers.push(
      () => 'nonsense',
      () => 'still nonsense',
    );
    const bad = await ai.run({ kind: 'translate', projectId, taskIds: [b.id] });
    expect(bad).toMatchObject({ applied: 0, undoId: null });
    expect(bad.failure).toMatch(/twice answered in a format/);
    expect(ai.getStatus()).toMatchObject({ state: 'failed' });
    expect(store.getTask(b.id).titleTranslation).toBe('');
    // While it is failed, the screens use Copy for AI; a job is refused.
    await expect(
      ai.run({ kind: 'translate', projectId, taskIds: [b.id] }),
    ).rejects.toThrow(/twice answered/);
    // A passing test brings it back.
    await ai.test();
    expect(ai.getStatus()).toMatchObject({
      state: 'ok',
      testedAt: clock,
    });
  });

  it('keeps what earlier requests filled in when the provider fails part-way', async () => {
    settings.aiRequestSize = 2_000;
    const ids = Array.from(
      { length: 6 },
      (_, i) =>
        ticket(`0${10 + i}`, `長いタイトル ${'あ'.repeat(200)} ${i}`).id,
    );
    answers.push((prompt) =>
      [...prompt.matchAll(/=== TICKET (\d+) \(Japanese\) ===/g)]
        .map((m) => block(m[1], `Title ${m[1]}`, 'S'))
        .join('\n'),
    );
    const ai = service();
    const r = await ai.run({ kind: 'translate', projectId, taskIds: ids });
    expect(asked.length).toBeGreaterThan(1);
    expect(r.applied).toBeGreaterThan(0);
    expect(r.failure).toMatch(/No answer prepared/);
    expect(r.undoId).not.toBeNull();
    expect(ai.getStatus().state).toBe('failed');
  });

  it('stops on Cancel', async () => {
    const a = ticket('012', 'バッチ');
    let release: () => void = () => {};
    const ai = service({
      ask: (_s, _p, signal) =>
        new Promise((_, reject) => {
          release = () => reject(new AiCancelled());
          signal?.addEventListener('abort', () => release());
        }),
    });
    const running = ai.run({ kind: 'translate', projectId, taskIds: [a.id] });
    expect(ai.isRunning()).toBe(true);
    await expect(
      ai.run({ kind: 'translate', projectId, taskIds: [a.id] }),
    ).rejects.toThrow(/still working/);
    ai.cancel();
    const r = await running;
    expect(r).toMatchObject({ cancelled: true, applied: 0, failure: null });
    expect(ai.getStatus().state).not.toBe('failed');
  });

  it('translates your notes for reports, and Undo removes the translations', async () => {
    const a = ticket('012', 'バッチ', {
      summary: 'Fix ready, testing on staging.',
    });
    answers.push((prompt) => {
      const key =
        /=== TICKET (\S+) ===/.exec(
          prompt.split('Tickets')[1] ?? prompt,
        )?.[1] ?? '012';
      return `=== TICKET ${key} ===\nSUMMARY: 修正済みで、ステージングで確認中です。\n=== END ===`;
    });
    const ai = service();
    const r = await ai.run({ kind: 'notes', projectId, taskIds: [a.id] });
    expect(r.applied).toBe(1);
    expect(store.listOwnerTranslations(projectId)).toEqual([
      expect.objectContaining({
        taskId: a.id,
        field: 'summary',
        text: '修正済みで、ステージングで確認中です。',
      }),
    ]);
    ai.undo(r.undoId!);
    expect(store.listOwnerTranslations(projectId)).toEqual([]);
  });

  it('summarizes a discussion into its progress ticket, and Undo puts it back', async () => {
    const t = ticket('025', 'バッチが止まる');
    const d = dis.save(projectId, { title: 'Why it stops', no: '' });
    dis.link(d.id, t.id);
    dis.addComment(d.id, { body: 'Memory runs out at 60%.' });
    const key = dis.get(d.id).no || `D-${d.id.slice(0, 6)}`;
    answers.push(
      () =>
        `=== TICKET ${key} ===\nDOING NOW: Testing a streaming fix\nSITUATION: Tanaka\nDIFFICULTIES:\n- Memory runs out on big files\nRESOLVED:\n- none\nNEXT STEP: Release the fix\nNEXT DATE: 2026/12/02\nSTATUS: Done\nACTION ITEMS:\n- none\n=== END ===`,
    );
    const ai = service();
    const r = await ai.run({ kind: 'summary', discussionIds: [d.id] });
    expect(r).toMatchObject({ applied: 1, failure: null });
    const after = store.getTask(t.id);
    expect(after.situation).toMatchObject({
      doingNow: 'Testing a streaming fix',
      handledBy: 'Tanaka',
      nextStep: 'Release the fix',
      nextDate: '2026-12-02',
    });
    // The status is never changed by a one-click summary.
    expect(after.status).toBe(t.status);
    expect(after.difficulties.map((x) => x.text)).toEqual([
      'Memory runs out on big files',
    ]);
    expect(dis.get(d.id).summarizedAt).toBe(clock);

    clock = '2026-11-26T09:10:00.000Z';
    ai.undo(r.undoId!);
    const back = store.getTask(t.id);
    expect(back.situation).toEqual(t.situation);
    expect(back.difficulties).toEqual([]);
    expect(dis.get(d.id).summarizedAt).toBeNull();
  });

  it('says off without a provider, and failed when the check fails', async () => {
    settings.aiProvider = 'none';
    const ai = service({
      check: async () => {
        throw new AiError('Claude Code was not found on this PC.');
      },
    });
    expect((await ai.check()).state).toBe('off');
    await expect(
      ai.run({ kind: 'translate', projectId, taskIds: [] }),
    ).rejects.toThrow(/No AI provider/);
    settings.aiProvider = 'claude';
    expect(await ai.check()).toMatchObject({
      state: 'failed',
      reason: 'Claude Code was not found on this PC.',
    });
    expect(statuses.at(-1)?.state).toBe('failed');
  });

  it('does nothing when nothing needs doing', async () => {
    const ai = service();
    const r = await ai.run({ kind: 'notes', projectId, taskIds: [] });
    expect(r).toMatchObject({ applied: 0, missing: 0, undoId: null });
    expect(asked).toEqual([]);
  });
});
