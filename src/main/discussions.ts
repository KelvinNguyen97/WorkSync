import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  canEdit,
  MAX_ATTACHMENT_BYTES,
  type AttachmentInfo,
  type Comment,
  type Discussion,
  type DiscussionInput,
  type SummaryAnswer,
  type SummaryItem,
} from '../shared/discussions';
import { EMPTY_TASK_INPUT, type Status, type Task } from '../shared/model';
import type { Store } from './store';
import type { Work } from './work';

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const list = (v: unknown): string[] => {
  try {
    const x = JSON.parse(str(v) || '[]');
    return Array.isArray(x) ? x.map(String) : [];
  } catch {
    return [];
  }
};

/** Discussion tickets (doc 09) with their comments and files. */
export class Discussions {
  constructor(
    private db: DatabaseSync,
    private store: Store,
    private work: Work,
    private now: () => string = () => new Date().toISOString(),
  ) {}

  private toDiscussion(r: Row): Discussion {
    const id = str(r.id);
    const linked = r.linked_task_id == null ? null : str(r.linked_task_id);
    let no = str(r.customer_id);
    if (linked) {
      const t = this.db
        .prepare('SELECT customer_id FROM tasks WHERE id = ?')
        .get(linked) as Row | undefined;
      if (t) no = str(t.customer_id);
    }
    const upto = r.summarized_upto == null ? null : str(r.summarized_upto);
    const c = this.db
      .prepare(
        `SELECT COUNT(*) AS n,
           SUM(CASE WHEN ? IS NULL OR created_at > ? OR (edited_at IS NOT NULL AND edited_at > ?) THEN 1 ELSE 0 END) AS fresh
         FROM comments WHERE discussion_id = ? AND deleted = 0`,
      )
      .get(upto, upto, upto, id) as Row;
    return {
      id,
      projectId: str(r.project_id),
      no,
      linkedTaskId: linked,
      title: str(r.title),
      description: str(r.description),
      state: str(r.state) === 'resolved' ? 'resolved' : 'open',
      labels: list(r.labels),
      watchers: list(r.watchers),
      madeBy: str(r.made_by),
      summarizedAt: r.summarized_at == null ? null : str(r.summarized_at),
      summarizedUpto: upto,
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
      commentCount: Number(c.n ?? 0),
      newSinceSummary: Number(c.fresh ?? 0),
    };
  }

  list(projectId?: string): Discussion[] {
    const rows = projectId
      ? this.db
          .prepare(
            'SELECT * FROM discussions WHERE project_id = ? ORDER BY created_at DESC',
          )
          .all(projectId)
      : this.db
          .prepare('SELECT * FROM discussions ORDER BY created_at DESC')
          .all();
    return (rows as Row[]).map((r) => this.toDiscussion(r));
  }

  get(id: string): Discussion {
    const r = this.db
      .prepare('SELECT * FROM discussions WHERE id = ?')
      .get(id) as Row | undefined;
    if (!r) throw new Error('This discussion no longer exists.');
    return this.toDiscussion(r);
  }

  /** The discussion linked to a progress ticket, if any. */
  forTicket(taskId: string): Discussion | null {
    const r = this.db
      .prepare('SELECT * FROM discussions WHERE linked_task_id = ?')
      .get(taskId) as Row | undefined;
    return r ? this.toDiscussion(r) : null;
  }

  /** The progress ticket with this No. in the project, if any. */
  progressWithNo(projectId: string, no: string): Task | null {
    const n = no.trim();
    if (!n) return null;
    const r = this.db
      .prepare('SELECT id FROM tasks WHERE project_id = ? AND customer_id = ?')
      .get(projectId, n) as Row | undefined;
    return r ? this.store.getTask(str(r.id)) : null;
  }

  save(
    projectId: string,
    input: Partial<DiscussionInput>,
    id?: string,
  ): Discussion {
    const now = this.now();
    const before = id ? this.get(id) : null;
    const v = {
      no: (input.no ?? before?.no ?? '').trim(),
      title: (input.title ?? before?.title ?? '').trim(),
      description: input.description ?? before?.description ?? '',
      state: input.state ?? before?.state ?? 'open',
      labels: [
        ...new Set(
          (input.labels ?? before?.labels ?? [])
            .map((l) => l.trim())
            .filter(Boolean),
        ),
      ],
      watchers: [...new Set(input.watchers ?? before?.watchers ?? [])],
    };
    if (!v.title) throw new Error('A ticket needs a title.');
    if (!['open', 'resolved'].includes(v.state))
      throw new Error('The state must be Open or Resolved.');
    if (v.no) {
      const twin = this.db
        .prepare(
          'SELECT id FROM discussions WHERE project_id = ? AND customer_id = ? AND id IS NOT ? AND linked_task_id IS NULL',
        )
        .get(projectId, v.no, id ?? null) as Row | undefined;
      const linkedTwin = this.db
        .prepare(
          `SELECT d.id FROM discussions d JOIN tasks t ON t.id = d.linked_task_id
           WHERE d.project_id = ? AND t.customer_id = ? AND d.id IS NOT ?`,
        )
        .get(projectId, v.no, id ?? null) as Row | undefined;
      if (twin || linkedTwin)
        throw new Error(
          `Another discussion in this project already has the number ${v.no}.`,
        );
    }
    if (before) {
      // A linked discussion's No. is the progress ticket's.
      const no = before.linkedTaskId ? before.no : v.no;
      if (before.linkedTaskId && v.no !== before.no)
        throw new Error(
          'A linked discussion has its progress ticket’s number. Unlink it first to change the number.',
        );
      this.db
        .prepare(
          'UPDATE discussions SET customer_id = ?, title = ?, description = ?, state = ?, labels = ?, watchers = ?, updated_at = ? WHERE id = ?',
        )
        .run(
          no,
          v.title,
          v.description,
          v.state,
          JSON.stringify(v.labels),
          JSON.stringify(v.watchers),
          now,
          id!,
        );
      if (v.state !== before.state)
        this.work.addEvent(
          projectId,
          id!,
          v.state === 'resolved' ? 'Marked as resolved.' : 'Opened again.',
        );
      return this.get(id!);
    }
    const newId = randomUUID();
    const me = this.work.me();
    this.db
      .prepare(
        `INSERT INTO discussions (id, uid, project_id, customer_id, title, description, state, labels, watchers, made_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId,
        newId,
        projectId,
        v.no,
        v.title,
        v.description,
        v.state,
        JSON.stringify(v.labels),
        JSON.stringify([...new Set([me, ...v.watchers])]),
        me,
        now,
        now,
      );
    this.work.addEvent(projectId, newId, 'Made.');
    return this.get(newId);
  }

  /** Links a discussion to a progress ticket: it takes the ticket's No. (doc 09, 4.3). */
  link(id: string, taskId: string): Discussion {
    const d = this.get(id);
    const t = this.store.getTask(taskId);
    if (t.projectId !== d.projectId)
      throw new Error('That ticket is not in this project.');
    const other = this.forTicket(taskId);
    if (other && other.id !== id)
      throw new Error(
        `Progress ticket ${t.customerId} is already linked to the discussion “${other.title}”. Unlink that one first.`,
      );
    this.db
      .prepare(
        'UPDATE discussions SET linked_task_id = ?, customer_id = ?, updated_at = ? WHERE id = ?',
      )
      .run(taskId, t.customerId, this.now(), id);
    this.work.addEvent(
      d.projectId,
      id,
      `Linked to progress ticket ${t.customerId}.`,
    );
    this.store.log(
      taskId,
      'Discussion',
      `Linked to the discussion “${d.title}”.`,
    );
    return this.get(id);
  }

  /** Unlinking keeps both tickets; the discussion's No. is cleared so it does not link again. */
  unlink(id: string): Discussion {
    const d = this.get(id);
    if (!d.linkedTaskId) return d;
    this.db
      .prepare(
        "UPDATE discussions SET linked_task_id = NULL, customer_id = '', updated_at = ? WHERE id = ?",
      )
      .run(this.now(), id);
    this.work.addEvent(
      d.projectId,
      id,
      `Unlinked from progress ticket ${d.no}.`,
    );
    try {
      this.store.log(
        d.linkedTaskId,
        'Discussion',
        `Unlinked from the discussion “${d.title}”.`,
      );
    } catch {
      // The progress ticket is gone.
    }
    return this.get(id);
  }

  /** Before a progress ticket is deleted: its discussion stays, unlinked, without a No. */
  ticketDeleted(taskId: string): void {
    this.db
      .prepare(
        "UPDATE discussions SET linked_task_id = NULL, customer_id = '' WHERE linked_task_id = ?",
      )
      .run(taskId);
  }

  /** Makes a progress ticket from a discussion, with its No. (or the next free one), and links them. */
  makeProgress(id: string): { discussion: Discussion; task: Task } {
    const d = this.get(id);
    if (d.linkedTaskId)
      throw new Error('This discussion already has a progress ticket.');
    const taken = d.no ? this.progressWithNo(d.projectId, d.no) : null;
    const task = this.store.createTask(d.projectId, {
      ...EMPTY_TASK_INPUT,
      customerId: taken ? '' : d.no,
      titleOriginal: d.title,
      summary: '',
    });
    return { discussion: this.link(id, task.id), task };
  }

  delete(id: string): Discussion {
    const d = this.get(id);
    this.db
      .prepare(
        'UPDATE project_tasks SET discussion_id = NULL WHERE discussion_id = ?',
      )
      .run(id);
    this.db.prepare('DELETE FROM discussions WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM work_history WHERE item_id = ?').run(id);
    if (d.linkedTaskId)
      try {
        this.store.log(
          d.linkedTaskId,
          'Discussion',
          `The discussion “${d.title}” was deleted.`,
        );
      } catch {
        // gone
      }
    return d;
  }

  // ------------------------------------------------------------ comments

  private attachmentsOf(discussionId: string): AttachmentInfo[] {
    return (
      this.db
        .prepare(
          'SELECT id, comment_id, name, type, size FROM attachments WHERE discussion_id = ? ORDER BY created_at',
        )
        .all(discussionId) as Row[]
    ).map((r) => ({
      id: str(r.id),
      commentId: r.comment_id == null ? null : str(r.comment_id),
      name: str(r.name),
      type: str(r.type),
      size: Number(r.size),
    }));
  }

  comments(discussionId: string): Comment[] {
    const files = this.attachmentsOf(discussionId);
    return (
      this.db
        .prepare(
          'SELECT * FROM comments WHERE discussion_id = ? ORDER BY created_at, id',
        )
        .all(discussionId) as Row[]
    ).map((r) => ({
      id: str(r.id),
      discussionId,
      parentId:
        r.parent_id == null || r.parent_id === '' ? null : str(r.parent_id),
      author: str(r.author),
      body: str(r.body),
      decision: Number(r.decision) === 1,
      deleted: Number(r.deleted) === 1,
      createdAt: str(r.created_at),
      editedAt: r.edited_at == null ? null : str(r.edited_at),
      attachments: files.filter((f) => f.commentId === str(r.id)),
    }));
  }

  private comment(id: string): Comment & { projectId: string } {
    const r = this.db
      .prepare(
        'SELECT c.*, d.project_id FROM comments c JOIN discussions d ON d.id = c.discussion_id WHERE c.id = ?',
      )
      .get(id) as Row | undefined;
    if (!r) throw new Error('This comment no longer exists.');
    const c = this.comments(str(r.discussion_id)).find((x) => x.id === id)!;
    return { ...c, projectId: str(r.project_id) };
  }

  addComment(
    discussionId: string,
    input: {
      body: string;
      parentId?: string | null;
      files?: { name: string; type: string; bytes: Uint8Array }[];
    },
  ): Comment {
    const d = this.get(discussionId);
    const body = input.body.trim();
    const files = input.files ?? [];
    if (!body && !files.length)
      throw new Error('Write a comment or add a file.');
    for (const f of files)
      if (f.bytes.byteLength > MAX_ATTACHMENT_BYTES)
        throw new Error(`${f.name} is larger than 25 MB.`);
    let parent: string | null = input.parentId ?? null;
    if (parent) {
      const p = this.comment(parent);
      // One level of replies: a reply to a reply goes under the first comment.
      parent = p.parentId ?? p.id;
    }
    const id = randomUUID();
    const now = this.now();
    const me = this.work.me();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'INSERT INTO comments (id, uid, discussion_id, parent_id, author, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, id, discussionId, parent, me, body, now);
      for (const f of files) {
        const bytes = Buffer.from(f.bytes);
        this.db
          .prepare(
            'INSERT INTO attachments (id, discussion_id, comment_id, name, type, size, hash, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            randomUUID(),
            discussionId,
            id,
            f.name.replace(/[\\/]/g, '_').slice(0, 200) || 'file',
            f.type || '',
            bytes.byteLength,
            createHash('sha256').update(bytes).digest('hex'),
            bytes,
            now,
          );
      }
      if (!d.watchers.includes(me))
        this.db
          .prepare('UPDATE discussions SET watchers = ? WHERE id = ?')
          .run(JSON.stringify([...d.watchers, me]), discussionId);
      this.db
        .prepare('UPDATE discussions SET updated_at = ? WHERE id = ?')
        .run(now, discussionId);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.comment(id);
  }

  editComment(id: string, body: string): Comment {
    const c = this.comment(id);
    if (c.author !== this.work.me())
      throw new Error('Only the person who wrote a comment can edit it.');
    if (!canEdit(c, Date.parse(this.now())))
      throw new Error(
        'A comment can be edited for 15 minutes. After that it can only be deleted.',
      );
    if (!body.trim() && !c.attachments.length)
      throw new Error('Write a comment or add a file.');
    this.db
      .prepare('UPDATE comments SET body = ?, edited_at = ? WHERE id = ?')
      .run(body.trim(), this.now(), id);
    return this.comment(id);
  }

  deleteComment(id: string): Comment {
    const c = this.comment(id);
    if (c.author !== this.work.me())
      throw new Error('Only the person who wrote a comment can delete it.');
    this.db
      .prepare(
        "UPDATE comments SET deleted = 1, body = '', decision = 0, edited_at = ? WHERE id = ?",
      )
      .run(this.now(), id);
    this.db.prepare('DELETE FROM attachments WHERE comment_id = ?').run(id);
    return this.comment(id);
  }

  setDecision(id: string, decision: boolean): Comment {
    const c = this.comment(id);
    if (c.deleted) throw new Error('This comment was deleted.');
    this.db
      .prepare('UPDATE comments SET decision = ? WHERE id = ?')
      .run(decision ? 1 : 0, id);
    this.work.addEvent(
      c.projectId,
      c.discussionId,
      decision
        ? 'Marked a comment as a decision.'
        : 'A comment is no longer a decision.',
    );
    return this.comment(id);
  }

  attachment(id: string): { name: string; type: string; data: Uint8Array } {
    const r = this.db
      .prepare('SELECT name, type, data FROM attachments WHERE id = ?')
      .get(id) as Row | undefined;
    if (!r) throw new Error('This file is no longer there.');
    return {
      name: str(r.name),
      type: str(r.type),
      data: new Uint8Array(r.data as Uint8Array),
    };
  }

  // ------------------------------------------------------------ Summarize

  /** The request items for these discussions (linked ones only). */
  summaryItems(
    ids: string[],
    names: (memberId: string) => string,
  ): SummaryItem[] {
    const out: SummaryItem[] = [];
    for (const id of ids) {
      const d = this.get(id);
      if (!d.linkedTaskId) continue;
      const t = this.store.getTask(d.linkedTaskId);
      const all = this.comments(id).filter((c) => !c.deleted);
      const numbered = all.map((c, i) => ({ c, n: i + 1 }));
      const since = d.summarizedUpto;
      const fresh = numbered.filter(
        ({ c }) =>
          !since || c.createdAt > since || (!!c.editedAt && c.editedAt > since),
      );
      const last = since
        ? [
            t.situation.doingNow && `Doing now: ${t.situation.doingNow}`,
            t.situation.nextStep && `Next step: ${t.situation.nextStep}`,
          ]
            .filter(Boolean)
            .join('. ')
        : '';
      const imageNote = (c: Comment) =>
        c.attachments
          .map(
            (a) =>
              ` [${a.type.startsWith('image/') ? 'image' : 'file'}: ${a.name}]`,
          )
          .join('');
      out.push({
        key: d.no || `D-${d.id.slice(0, 6)}`,
        progress: {
          title: t.titleTranslation || t.titleOriginal,
          status: t.status,
          doingNow: t.situation.doingNow,
          nextStep: t.situation.nextStep,
          nextDate: t.situation.nextDate,
          difficulties: t.difficulties.filter((x) => x.open).map((x) => x.text),
        },
        discussion: {
          title: d.title,
          description: d.description,
          lastSummary: last,
          comments: fresh.map(({ c, n }) => ({
            n,
            author: names(c.author),
            at: c.createdAt,
            body: c.body + imageNote(c),
            decision: c.decision,
            reply: !!c.parentId,
          })),
          leftOut: 0,
        },
      });
    }
    return out;
  }

  /**
   * Applies a reviewed summary to the linked progress ticket. Only the parts
   * given are changed; the AI never changes dates, priority or customer fields.
   */
  applySummary(
    id: string,
    a: Partial<SummaryAnswer> & {
      /** Difficulties (by text) to mark resolved. */
      resolved?: string[];
      status?: Status | null;
    },
  ): Task {
    const d = this.get(id);
    if (!d.linkedTaskId)
      throw new Error('Link this discussion to a progress ticket first.');
    const taskId = d.linkedTaskId;
    let t = this.store.getTask(taskId);
    const comments = this.comments(id).filter((c) => !c.deleted);
    const from = d.summarizedUpto
      ? comments.findIndex((c) => c.createdAt > d.summarizedUpto!) + 1
      : 1;
    const upto = comments.length;
    if (
      a.doingNow !== undefined ||
      a.nextStep !== undefined ||
      a.nextDate !== undefined ||
      a.situation !== undefined
    )
      t = this.store.addSituationUpdate(taskId, {
        ...(a.situation ? { handledBy: a.situation } : {}),
        ...(a.doingNow !== undefined ? { doingNow: a.doingNow } : {}),
        ...(a.nextStep !== undefined ? { nextStep: a.nextStep } : {}),
        ...(a.nextDate !== undefined ? { nextDate: a.nextDate } : {}),
      });
    for (const text of a.difficulties ?? [])
      if (text.trim())
        t = this.store.addSituationUpdate(taskId, {
          newDifficulty: { text: text.trim(), resolver: '' },
        });
    for (const text of a.resolved ?? []) {
      const hit = t.difficulties.find(
        (x) =>
          x.open && x.text.trim().toLowerCase() === text.trim().toLowerCase(),
      );
      if (hit) t = this.store.setDifficultyOpen(taskId, hit.id, false);
    }
    if (a.status && a.status !== t.status)
      t = this.store.updateTask(taskId, { status: a.status });
    const newest = comments.reduce(
      (m, c) =>
        c.editedAt && c.editedAt > m
          ? c.editedAt
          : c.createdAt > m
            ? c.createdAt
            : m,
      '',
    );
    this.db
      .prepare(
        'UPDATE discussions SET summarized_at = ?, summarized_upto = ? WHERE id = ?',
      )
      .run(this.now(), newest || this.now(), id);
    const range = upto
      ? from && from < upto
        ? `comments ${from}–${upto}`
        : `comment ${upto}`
      : 'no comments';
    this.store.log(
      taskId,
      'Situation update',
      `Updated from discussion ${d.no}, ${range}.`,
    );
    this.work.addEvent(
      d.projectId,
      id,
      `Summarized into progress ticket ${d.no}, up to comment ${upto}.`,
    );
    return this.store.getTask(taskId);
  }
}
