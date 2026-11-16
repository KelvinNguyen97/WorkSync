/**
 * Project tasks (doc 10): small to-dos in a project, assigned to one member
 * or nobody, optionally linked to a ticket. A ticket is a progress ticket
 * (the `tasks` table, for historical reasons) or a discussion ticket.
 *
 * Free of Node.js and Electron imports: used by the main process, the
 * screens and tests.
 */
import type { MyPriority } from './myTasks';

export type WorkStatus = 'todo' | 'doing' | 'done';
export const WORK_STATUSES: WorkStatus[] = ['todo', 'doing', 'done'];
export const WORK_STATUS_NAME: Record<WorkStatus, string> = {
  todo: 'To do',
  doing: 'Doing',
  done: 'Done',
};

/** The next status when the tick is pressed: To do → Doing → Done → To do. */
export const nextWorkStatus = (s: WorkStatus): WorkStatus =>
  s === 'todo' ? 'doing' : s === 'doing' ? 'done' : 'todo';

export interface ProjectTask {
  id: string;
  projectId: string;
  title: string;
  note: string;
  /** A progress ticket (task id) this task is for, or null. */
  ticketId: string | null;
  /** A discussion ticket this task is for, or null. */
  discussionId: string | null;
  /** A member id, or '' for Unassigned. */
  assignee: string;
  /** yyyy-mm-dd or null. */
  dueDate: string | null;
  priority: MyPriority;
  status: WorkStatus;
  reminders: boolean;
  lastReminderKey: string | null;
  madeBy: string;
  createdAt: string;
  updatedAt: string;
  doneBy: string;
  doneAt: string | null;
}

export type ProjectTaskInput = Pick<
  ProjectTask,
  | 'title'
  | 'note'
  | 'ticketId'
  | 'discussionId'
  | 'assignee'
  | 'dueDate'
  | 'priority'
  | 'status'
  | 'reminders'
>;

/** An entry in a project task's or discussion's history. */
export interface WorkEvent {
  id: string;
  at: string;
  /** Member id of who did it. */
  by: string;
  /** In English; translated when shown. */
  text: string;
}

/** Someone who can be assigned: in a local project only you. */
export interface Member {
  id: string;
  name: string;
  /** A short tag from the key, to tell same names apart (e.g. 7F3A). */
  tag: string;
  /** CORP\tanaka-y */
  account: string;
  pc: string;
  color: string;
  /** This PC's own member. */
  me: boolean;
}

export const memberLabel = (m: Member | undefined, all: Member[] = []) => {
  if (!m) return '';
  const twin = all.some(
    (x) => x.id !== m.id && x.name.toLowerCase() === m.name.toLowerCase(),
  );
  return `${m.name} ·${m.tag}${twin && m.account ? ` (${m.account})` : ''}`;
};

/** A colour from an id, the same on every PC. */
export function colorOf(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 55%)`;
}

/** A 4-character tag from an id, the same on every PC. */
export function tagOf(id: string): string {
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h.toString(16).toUpperCase().padStart(8, '0').slice(0, 4);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "11/21", "2026/11/21", "2026-11-21", "today", "tomorrow" → yyyy-mm-dd. */
export function readQuickDate(word: string, today: string): string | null {
  const w = word.toLowerCase();
  const base = new Date(`${today}T00:00:00`);
  const plus = (d: number) => {
    const x = new Date(base);
    x.setDate(x.getDate() + d);
    return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  };
  if (w === 'today' || w === '今日') return plus(0);
  if (w === 'tomorrow' || w === '明日') return plus(1);
  let m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(w);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
  m = /^(\d{1,2})\/(\d{1,2})$/.exec(w);
  if (m) {
    const [mo, d] = [Number(m[1]), Number(m[2])];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    let y = base.getFullYear();
    // A date well in the past means next year (11/21 typed in January).
    const candidate = `${y}-${pad(mo)}-${pad(d)}`;
    if (candidate < plus(-60)) y += 1;
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
  return null;
}

export interface QuickAdd {
  title: string;
  assignee: string;
  dueDate: string | null;
  /** The No. typed after #, and the ticket it found. */
  ticketNo: string;
  ticketId: string | null;
  discussionId: string | null;
}

/**
 * Reads one line of quick add: "Test streaming on Stg @Suzuki 11/21 #025".
 * Each part is optional. A name that is not a member, or a number that is
 * not a ticket, stays in the title.
 */
export function parseQuickAdd(
  line: string,
  o: {
    members: Member[];
    tickets: { id: string; no: string }[];
    discussions?: { id: string; no: string }[];
    today: string;
  },
): QuickAdd {
  const out: QuickAdd = {
    title: '',
    assignee: '',
    dueDate: null,
    ticketNo: '',
    ticketId: null,
    discussionId: null,
  };
  const words = line.trim().split(/\s+/).filter(Boolean);
  const rest: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith('@') && w.length > 1 && !out.assignee) {
      const name = w.slice(1).toLowerCase();
      const byTag = o.members.find(
        (m) => `${m.name}·${m.tag}`.toLowerCase() === name,
      );
      const exact = o.members.filter((m) => m.name.toLowerCase() === name);
      const starts = o.members.filter((m) =>
        m.name.toLowerCase().startsWith(name),
      );
      const me =
        ['me', 'you', '自分'].includes(name) && o.members.find((m) => m.me);
      const hit =
        byTag ??
        (exact.length === 1 ? exact[0] : undefined) ??
        (starts.length === 1 ? starts[0] : undefined) ??
        (me || undefined);
      if (hit) {
        out.assignee = hit.id;
        continue;
      }
    }
    if (w.startsWith('#') && w.length > 1 && !out.ticketNo) {
      const no = w.slice(1);
      const t = o.tickets.find((x) => x.no === no);
      const d = o.discussions?.find((x) => x.no === no);
      if (t || d) {
        out.ticketNo = no;
        out.ticketId = t?.id ?? null;
        out.discussionId = t ? null : (d?.id ?? null);
        continue;
      }
    }
    if (!out.dueDate) {
      const d = readQuickDate(w, o.today);
      if (d) {
        out.dueDate = d;
        continue;
      }
    }
    rest.push(w);
  }
  out.title = rest.join(' ');
  return out;
}

/** Whether a task is late on this day. */
export const isLate = (t: ProjectTask, today: string) =>
  t.status !== 'done' && !!t.dueDate && t.dueDate < today;

/** "3 of 5 tasks done", or '' when the ticket has no tasks. */
export function taskProgress(tasks: ProjectTask[]): {
  done: number;
  total: number;
} {
  return {
    done: tasks.filter((t) => t.status === 'done').length,
    total: tasks.length,
  };
}
