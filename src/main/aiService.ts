/**
 * The AI provider as the app sees it (doc 11): its status, the one-click
 * jobs, Cancel, and Undo.
 *
 * A job sends the same requests Copy for AI would, one at a time, reads each
 * answer with the same checks, and fills in what came back. An answer in the
 * wrong format is asked for once more; a second one stops the job. When the
 * provider fails, its status turns failed and the screens fall back to Copy
 * for AI until a test passes or WorkSync restarts.
 *
 * Undo puts back the fields and rows the job changed, but only where nobody
 * has changed them since: an edit made after the job is kept.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  AI_PROVIDER_NAME,
  type AiJob,
  type AiProgress,
  type AiRunResult,
  type AiStatus,
} from '../shared/ai';
import {
  AiCancelled,
  AiError,
  ask as askProvider,
  fullTest,
  quickCheck,
  type ProviderSettings,
} from './aiProvider';

type Row = Record<string, unknown>;

/** One request of a job, and how to fill in its answer. */
export interface PlanStep {
  text: string;
  /**
   * Reads and applies the answer. Returns how many items were filled in and
   * how many were missing; readable is false when nothing in the answer
   * could be read at all.
   */
  apply: (answer: string) => {
    applied: number;
    missing: number;
    readable: boolean;
  };
}

export interface Plan {
  steps: PlanStep[];
  /** The tickets and discussions the job may change, for Undo. */
  taskIds: string[];
  discussionIds: string[];
  items: number;
}

export interface AiDeps {
  db: () => DatabaseSync;
  settings: () => ProviderSettings & { aiRequestSize: number };
  plan: (job: AiJob, maxChars: number, from: string) => Plan;
  /** Writes a line in a ticket's history. */
  log: (taskId: string, text: string) => void;
  progress: (p: AiProgress | null) => void;
  statusChanged: (s: AiStatus) => void;
  now?: () => string;
  /** For tests: replaces the real provider. */
  ask?: (
    s: ProviderSettings,
    prompt: string,
    signal?: AbortSignal,
  ) => Promise<string>;
  test?: (s: ProviderSettings) => Promise<string>;
  check?: (s: ProviderSettings) => Promise<string>;
}

/** The tables a job can change, how their rows are found and told apart. */
const TABLES: {
  name: string;
  by: 'task' | 'discussion';
  column: string;
  key: string[];
}[] = [
  { name: 'tasks', by: 'task', column: 'id', key: ['id'] },
  { name: 'situation_updates', by: 'task', column: 'task_id', key: ['id'] },
  { name: 'difficulties', by: 'task', column: 'task_id', key: ['id'] },
  {
    name: 'owner_translations',
    by: 'task',
    column: 'task_id',
    key: ['task_id', 'field', 'language'],
  },
  { name: 'discussions', by: 'discussion', column: 'id', key: ['id'] },
];

type Snapshot = Map<string, Map<string, Row>>;

interface UndoEntry {
  before: Snapshot;
  after: Snapshot;
  taskIds: string[];
  discussionIds: string[];
  who: string;
}

const same = (a: unknown, b: unknown) =>
  a instanceof Uint8Array || b instanceof Uint8Array
    ? Buffer.compare(
        Buffer.from(a as Uint8Array),
        Buffer.from(b as Uint8Array),
      ) === 0
    : a === b;

export class AiService {
  private status: AiStatus;
  private running: AbortController | null = null;
  private undos = new Map<string, UndoEntry>();
  private checkRun = 0;

  constructor(private deps: AiDeps) {
    const s = deps.settings();
    this.status = {
      provider: s.aiProvider,
      state: s.aiProvider === 'none' ? 'off' : 'checking',
      reason: null,
      detail: null,
      testedAt: null,
    };
  }

  private now() {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private set(patch: Partial<AiStatus>) {
    this.status = { ...this.status, ...patch };
    this.deps.statusChanged(this.status);
  }

  getStatus(): AiStatus {
    return this.status;
  }

  /**
   * The check at start and after the settings change: sends nothing to the
   * AI, so it costs nothing. A failed provider stays failed only until then.
   */
  async check(): Promise<AiStatus> {
    const s = this.deps.settings();
    const run = ++this.checkRun;
    if (s.aiProvider === 'none') {
      this.set({ provider: 'none', state: 'off', reason: null, detail: null });
      return this.status;
    }
    this.set({ provider: s.aiProvider, state: 'checking', reason: null });
    try {
      const detail = await (this.deps.check ?? quickCheck)(s);
      if (run === this.checkRun) this.set({ state: 'ok', detail });
    } catch (e) {
      if (run === this.checkRun)
        this.set({ state: 'failed', reason: reasonOf(e), detail: null });
    }
    return this.status;
  }

  /** The Test button: one tiny request, so sign-in and limits are checked too. */
  async test(): Promise<AiStatus> {
    const s = this.deps.settings();
    const run = ++this.checkRun;
    if (s.aiProvider === 'none') return this.check();
    this.set({ provider: s.aiProvider, state: 'checking', reason: null });
    try {
      const detail = await (this.deps.test ?? fullTest)(s);
      if (run === this.checkRun)
        this.set({ state: 'ok', detail, testedAt: this.now() });
    } catch (e) {
      if (run === this.checkRun)
        this.set({ state: 'failed', reason: reasonOf(e), detail: null });
    }
    return this.status;
  }

  cancel(): void {
    this.running?.abort();
  }

  isRunning(): boolean {
    return !!this.running;
  }

  /** Runs a one-click job; throws only when nothing at all could be done. */
  async run(job: AiJob): Promise<AiRunResult> {
    if (this.running)
      throw new Error(
        'The AI is still working on the last job. Wait for it, or cancel it.',
      );
    const s = this.deps.settings();
    if (s.aiProvider === 'none')
      throw new Error(
        'No AI provider is chosen. Choose one in Settings › AI provider.',
      );
    if (this.status.state === 'failed')
      throw new Error(this.status.reason ?? 'The AI provider is not working.');
    const who = providerWords(s.aiProvider);
    const plan = this.deps.plan(job, s.aiRequestSize, who);
    const result: AiRunResult = {
      applied: 0,
      missing: 0,
      undoId: null,
      taskIds: [],
      failure: null,
      cancelled: false,
    };
    if (!plan.steps.length) return result;
    const ctl = new AbortController();
    this.running = ctl;
    const before = this.snapshot(plan.taskIds, plan.discussionIds);
    const ask = this.deps.ask ?? askProvider;
    try {
      for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i];
        this.deps.progress({
          job: job.kind,
          at: i + 1,
          of: plan.steps.length,
          items: plan.items,
        });
        let r = step.apply(await ask(s, step.text, ctl.signal));
        if (!r.readable) r = step.apply(await ask(s, step.text, ctl.signal));
        if (!r.readable)
          throw new AiError(
            s.aiProvider === 'local'
              ? 'The local model twice answered in a format WorkSync could not read. A bigger model may follow the format better.'
              : `${AI_PROVIDER_NAME[s.aiProvider]} twice answered in a format WorkSync could not read.`,
          );
        result.applied += r.applied;
        result.missing += r.missing;
      }
      if (this.status.state !== 'ok') this.set({ state: 'ok', reason: null });
    } catch (e) {
      if (e instanceof AiCancelled || ctl.signal.aborted)
        result.cancelled = true;
      else {
        result.failure = reasonOf(e);
        this.set({ state: 'failed', reason: result.failure, detail: null });
      }
    } finally {
      this.running = null;
      this.deps.progress(null);
    }
    const after = this.snapshot(plan.taskIds, plan.discussionIds);
    const changed = changedTasks(before, after);
    if (changed.size || changedAny(before, after)) {
      const id = randomUUID();
      this.undos.set(id, {
        before,
        after,
        taskIds: plan.taskIds,
        discussionIds: plan.discussionIds,
        who,
      });
      // Only the last few jobs can be undone.
      for (const k of [...this.undos.keys()].slice(0, -10))
        this.undos.delete(k);
      result.undoId = id;
    }
    result.taskIds = [...changed];
    return result;
  }

  /** Puts back what a job changed, except what was edited since. */
  undo(undoId: string): string[] {
    const u = this.undos.get(undoId);
    if (!u) throw new Error('This can no longer be undone.');
    this.undos.delete(undoId);
    const db = this.deps.db();
    const now = this.snapshot(u.taskIds, u.discussionIds);
    const touched = new Set<string>();
    db.exec('BEGIN');
    try {
      for (const t of TABLES) {
        const b = u.before.get(t.name)!;
        const a = u.after.get(t.name)!;
        const n = now.get(t.name)!;
        const where = t.key.map((k) => `${k} = ?`).join(' AND ');
        for (const [key, row] of a) {
          const cur = n.get(key);
          if (!cur) continue;
          const old = b.get(key);
          if (!old) {
            // Added by the job: removed, unless changed since.
            if (Object.keys(row).every((c) => same(row[c], cur[c]))) {
              db.prepare(`DELETE FROM ${t.name} WHERE ${where}`).run(
                ...(t.key.map((k) => row[k]) as never[]),
              );
              touched.add(taskOf(t.name, row));
            }
            continue;
          }
          const cols = Object.keys(row).filter(
            (c) =>
              c !== 'updated_at' &&
              !same(old[c], row[c]) &&
              same(cur[c], row[c]),
          );
          if (!cols.length) continue;
          const extra = 'updated_at' in row ? ', updated_at = ?' : '';
          db.prepare(
            `UPDATE ${t.name} SET ${cols.map((c) => `${c} = ?`).join(', ')}${extra} WHERE ${where}`,
          ).run(
            ...(cols.map((c) => old[c]) as never[]),
            ...((extra ? [this.now()] : []) as never[]),
            ...(t.key.map((k) => row[k]) as never[]),
          );
          touched.add(taskOf(t.name, row));
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    const tasks = [...touched].filter((id) => id && u.taskIds.includes(id));
    for (const id of tasks) this.deps.log(id, `Undid what ${u.who} filled in.`);
    return tasks;
  }

  private snapshot(taskIds: string[], discussionIds: string[]): Snapshot {
    const db = this.deps.db();
    const out: Snapshot = new Map();
    for (const t of TABLES) {
      const ids = t.by === 'task' ? taskIds : discussionIds;
      const m = new Map<string, Row>();
      for (const id of ids)
        for (const r of db
          .prepare(`SELECT * FROM ${t.name} WHERE ${t.column} = ?`)
          .all(id) as Row[])
          m.set(t.key.map((k) => String(r[k])).join('\u0000'), r);
      out.set(t.name, m);
    }
    return out;
  }
}

const taskOf = (table: string, row: Row) =>
  table === 'tasks'
    ? String(row.id)
    : table === 'discussions'
      ? ''
      : String(row.task_id);

function changedTasks(before: Snapshot, after: Snapshot): Set<string> {
  const out = new Set<string>();
  for (const t of TABLES) {
    if (t.by !== 'task') continue;
    const b = before.get(t.name)!;
    for (const [k, row] of after.get(t.name)!) {
      const old = b.get(k);
      if (!old || Object.keys(row).some((c) => !same(old[c], row[c])))
        out.add(taskOf(t.name, row));
    }
  }
  return out;
}

function changedAny(before: Snapshot, after: Snapshot): boolean {
  for (const t of TABLES) {
    const b = before.get(t.name)!;
    for (const [k, row] of after.get(t.name)!) {
      const old = b.get(k);
      if (!old || Object.keys(row).some((c) => !same(old[c], row[c])))
        return true;
    }
  }
  return false;
}

function reasonOf(e: unknown): string {
  if (e instanceof AiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/** How a provider is named in history lines: "from Claude Code". */
export const providerWords = (p: ProviderSettings['aiProvider']) =>
  p === 'local' ? 'a local model' : AI_PROVIDER_NAME[p];
