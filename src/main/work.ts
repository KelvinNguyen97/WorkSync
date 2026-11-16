import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import type { MyPriority } from '../shared/myTasks';
import {
  colorOf,
  tagOf,
  WORK_STATUS_NAME,
  type Member,
  type ProjectTask,
  type ProjectTaskInput,
  type WorkEvent,
  type WorkStatus,
} from '../shared/work';
import { installId } from './exchanges';

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function setting(db: DatabaseSync, key: string): unknown {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | Row
    | undefined;
  if (!r) return undefined;
  try {
    return JSON.parse(str(r.value));
  } catch {
    return undefined;
  }
}

function putSetting(db: DatabaseSync, key: string, value: unknown): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(value));
}

/**
 * Who you are on this PC: a member id made once (the same id is used when a
 * workspace is joined, so tasks assigned to you stay yours).
 */
export function myMemberId(db: DatabaseSync): string {
  let id = str(setting(db, 'memberId'));
  if (!id) {
    id = installId(db);
    putSetting(db, 'memberId', id);
  }
  return id;
}

export function setMyMemberId(db: DatabaseSync, id: string): void {
  putSetting(db, 'memberId', id);
}

export const windowsAccount = (): string => {
  try {
    const u = os.userInfo().username;
    const domain = process.env.USERDOMAIN;
    return domain ? `${domain}\\${u}` : u;
  } catch {
    return '';
  }
};

export function myName(db: DatabaseSync): string {
  const n = str(setting(db, 'displayName')).trim();
  if (n) return n;
  try {
    return os.userInfo().username || 'Me';
  } catch {
    return 'Me';
  }
}

/** You, as a member, for local projects. */
export function meAsMember(db: DatabaseSync): Member {
  const id = myMemberId(db);
  return {
    id,
    name: myName(db),
    tag: tagOf(id),
    account: windowsAccount(),
    pc: os.hostname(),
    color: colorOf(id),
    me: true,
  };
}

/** Project tasks (doc 10) and the history of tasks and discussions. */
export class Work {
  constructor(
    private db: DatabaseSync,
    /** The members a project's tasks can be assigned to. */
    private members: (projectId: string) => Member[] = () => [meAsMember(db)],
    private now: () => string = () => new Date().toISOString(),
  ) {}

  me(): string {
    return myMemberId(this.db);
  }

  membersOf(projectId: string): Member[] {
    return this.members(projectId);
  }

  private toTask(r: Row): ProjectTask {
    return {
      id: str(r.id),
      projectId: str(r.project_id),
      title: str(r.title),
      note: str(r.note),
      ticketId:
        r.ticket_id == null || r.ticket_id === '' ? null : str(r.ticket_id),
      discussionId:
        r.discussion_id == null || r.discussion_id === ''
          ? null
          : str(r.discussion_id),
      assignee: str(r.assignee),
      dueDate: r.due_date == null || r.due_date === '' ? null : str(r.due_date),
      priority: (str(r.priority) || 'N') as MyPriority,
      status: (str(r.status) || 'todo') as WorkStatus,
      reminders: Number(r.reminders) === 1,
      lastReminderKey:
        r.last_reminder_key == null ? null : str(r.last_reminder_key),
      madeBy: str(r.made_by),
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
      doneBy: str(r.done_by),
      doneAt: r.done_at == null ? null : str(r.done_at),
    };
  }

  listTasks(projectId?: string): ProjectTask[] {
    const rows = projectId
      ? this.db
          .prepare(
            'SELECT * FROM project_tasks WHERE project_id = ? ORDER BY created_at',
          )
          .all(projectId)
      : this.db
          .prepare('SELECT * FROM project_tasks ORDER BY created_at')
          .all();
    return (rows as Row[]).map((r) => this.toTask(r));
  }

  /** Open project tasks assigned to you, in every project. */
  assignedToMe(): ProjectTask[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM project_tasks WHERE assignee = ? AND status <> 'done' ORDER BY due_date IS NULL, due_date, created_at",
        )
        .all(this.me()) as Row[]
    ).map((r) => this.toTask(r));
  }

  getTask(id: string): ProjectTask {
    const r = this.db
      .prepare('SELECT * FROM project_tasks WHERE id = ?')
      .get(id) as Row | undefined;
    if (!r) throw new Error('This task no longer exists.');
    return this.toTask(r);
  }

  private label(memberId: string, projectId: string): string {
    if (!memberId) return 'Unassigned';
    const m = this.members(projectId).find((x) => x.id === memberId);
    return m ? `${m.name} ·${m.tag}` : 'someone who is not a member';
  }

  private clean(
    projectId: string,
    input: Partial<ProjectTaskInput>,
    before?: ProjectTask,
  ): ProjectTaskInput {
    const v: ProjectTaskInput = {
      title: (input.title ?? before?.title ?? '').trim(),
      note: (input.note ?? before?.note ?? '').trim(),
      ticketId:
        input.ticketId === undefined
          ? (before?.ticketId ?? null)
          : input.ticketId || null,
      discussionId:
        input.discussionId === undefined
          ? (before?.discussionId ?? null)
          : input.discussionId || null,
      assignee: (input.assignee ?? before?.assignee ?? '').trim(),
      dueDate:
        input.dueDate === undefined
          ? (before?.dueDate ?? null)
          : input.dueDate || null,
      priority: input.priority ?? before?.priority ?? 'N',
      status: input.status ?? before?.status ?? 'todo',
      reminders: input.reminders ?? before?.reminders ?? true,
    };
    if (!v.title) throw new Error('A task needs a title.');
    if (!['todo', 'doing', 'done'].includes(v.status))
      throw new Error('The status must be To do, Doing or Done.');
    if (!['U', 'N', 'L'].includes(v.priority))
      throw new Error('The priority must be Urgent, Normal or Low.');
    if (v.dueDate && !ISO_DAY.test(v.dueDate))
      throw new Error('The due date is not a date.');
    if (
      v.assignee &&
      v.assignee !== before?.assignee &&
      !this.members(projectId).some((m) => m.id === v.assignee)
    )
      throw new Error(
        'A task can only be assigned to a member of the workspace.',
      );
    if (v.ticketId) {
      const t = this.db
        .prepare('SELECT project_id FROM tasks WHERE id = ?')
        .get(v.ticketId) as Row | undefined;
      if (!t || str(t.project_id) !== projectId)
        throw new Error('That ticket is not in this project.');
    }
    if (v.discussionId) {
      const t = this.db
        .prepare('SELECT project_id FROM discussions WHERE id = ?')
        .get(v.discussionId) as Row | undefined;
      if (!t || str(t.project_id) !== projectId)
        throw new Error('That ticket is not in this project.');
    }
    return v;
  }

  /** Adds a task, or changes one when id is given. */
  saveTask(
    projectId: string,
    input: Partial<ProjectTaskInput>,
    id?: string,
  ): ProjectTask {
    const now = this.now();
    const me = this.me();
    const exists = this.db
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get(projectId);
    if (!exists) throw new Error('That project no longer exists.');
    if (id) {
      const before = this.getTask(id);
      const v = this.clean(projectId, input, before);
      const done = v.status === 'done' && before.status !== 'done';
      const undone = v.status !== 'done' && before.status === 'done';
      const resetKey =
        v.status !== before.status || v.priority !== before.priority;
      this.db
        .prepare(
          `UPDATE project_tasks SET title = ?, note = ?, ticket_id = ?, discussion_id = ?, assignee = ?, due_date = ?,
             priority = ?, status = ?, reminders = ?,
             last_reminder_key = CASE WHEN ? THEN NULL ELSE last_reminder_key END,
             done_by = CASE WHEN ? THEN ? WHEN ? THEN '' ELSE done_by END,
             done_at = CASE WHEN ? THEN ? WHEN ? THEN NULL ELSE done_at END,
             updated_at = ? WHERE id = ?`,
        )
        .run(
          v.title,
          v.note,
          v.ticketId,
          v.discussionId,
          v.assignee,
          v.dueDate,
          v.priority,
          v.status,
          v.reminders ? 1 : 0,
          resetKey ? 1 : 0,
          done ? 1 : 0,
          me,
          undone ? 1 : 0,
          done ? 1 : 0,
          now,
          undone ? 1 : 0,
          now,
          id,
        );
      const say: string[] = [];
      if (v.status !== before.status)
        say.push(
          `Status: ${WORK_STATUS_NAME[before.status]} → ${WORK_STATUS_NAME[v.status]}.`,
        );
      if (v.assignee !== before.assignee)
        say.push(
          `Assigned to ${this.label(v.assignee, projectId)} (was ${this.label(before.assignee, projectId)}).`,
        );
      if (v.dueDate !== before.dueDate)
        say.push(`Due date: ${v.dueDate ?? 'none'}.`);
      if (v.title !== before.title) say.push(`Title changed.`);
      if (
        v.ticketId !== before.ticketId ||
        v.discussionId !== before.discussionId
      )
        say.push(
          v.ticketId || v.discussionId
            ? 'Linked to a ticket.'
            : 'No longer linked to a ticket.',
        );
      if (say.length) this.addEvent(projectId, id, say.join(' '));
      return this.getTask(id);
    }
    const v = this.clean(projectId, input);
    const newId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO project_tasks (id, uid, project_id, ticket_id, discussion_id, title, note, assignee, due_date, priority, status,
           reminders, made_by, done_by, done_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId,
        newId,
        projectId,
        v.ticketId,
        v.discussionId,
        v.title,
        v.note,
        v.assignee,
        v.dueDate,
        v.priority,
        v.status,
        v.reminders ? 1 : 0,
        me,
        v.status === 'done' ? me : '',
        v.status === 'done' ? now : null,
        now,
        now,
      );
    this.addEvent(
      projectId,
      newId,
      v.assignee
        ? `Made and assigned to ${this.label(v.assignee, projectId)}.`
        : 'Made.',
    );
    return this.getTask(newId);
  }

  deleteTask(id: string): ProjectTask {
    const t = this.getTask(id);
    this.db.prepare('DELETE FROM project_tasks WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM work_history WHERE item_id = ?').run(id);
    return t;
  }

  /** Puts back a task deleted a moment ago. */
  restoreTask(t: ProjectTask): ProjectTask {
    const v = this.clean(t.projectId, t, t);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO project_tasks (id, uid, project_id, ticket_id, discussion_id, title, note, assignee, due_date, priority, status,
           reminders, last_reminder_key, made_by, done_by, done_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id,
        t.id,
        t.projectId,
        v.ticketId,
        v.discussionId,
        v.title,
        v.note,
        v.assignee,
        v.dueDate,
        v.priority,
        v.status,
        v.reminders ? 1 : 0,
        t.lastReminderKey,
        t.madeBy,
        t.doneBy,
        t.doneAt,
        t.createdAt,
        this.now(),
      );
    return this.getTask(t.id);
  }

  /** Moves a personal My tasks item into a project as a project task. */
  moveToProject(
    projectId: string,
    my: {
      title: string;
      description: string;
      dueDate: string | null;
      priority: MyPriority;
      status: string;
    },
  ): ProjectTask {
    return this.saveTask(projectId, {
      title: my.title,
      note: my.description,
      dueDate: my.dueDate,
      priority: my.priority,
      status: my.status === 'ongoing' ? 'doing' : 'todo',
      assignee: this.me(),
    });
  }

  setReminderKey(id: string, key: string): void {
    this.db
      .prepare('UPDATE project_tasks SET last_reminder_key = ? WHERE id = ?')
      .run(key, id);
  }

  // ------------------------------------------------------------ history

  addEvent(projectId: string, itemId: string, text: string, by = this.me()) {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO work_history (id, uid, project_id, item_id, at, by, text) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, id, projectId, itemId, this.now(), by, text);
  }

  history(itemId: string): WorkEvent[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM work_history WHERE item_id = ? ORDER BY at DESC',
        )
        .all(itemId) as Row[]
    ).map((r) => ({
      id: str(r.id),
      at: str(r.at),
      by: str(r.by),
      text: str(r.text),
    }));
  }
}
