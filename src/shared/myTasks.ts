/**
 * My tasks: the owner's own to-dos, not tied to any project, with Windows
 * reminders. The reminder rules are the ones from FileManagement.
 */

export type MyStatus = 'todo' | 'ongoing';
export type MyPriority = 'U' | 'N' | 'L';

export const MY_STATUS_NAME: Record<MyStatus, string> = {
  todo: 'Todo',
  ongoing: 'On-going',
};
export const MY_PRIORITY_NAME: Record<MyPriority, string> = {
  U: 'Urgent',
  N: 'Normal',
  L: 'Low',
};

export interface MyTask {
  id: string;
  title: string;
  description: string;
  status: MyStatus;
  priority: MyPriority;
  /** yyyy-mm-dd, or null for no date. */
  dueDate: string | null;
  /** The bell: false means no reminders for this task. */
  reminders: boolean;
  /** The last reminder slot shown, so each is shown once. */
  lastReminderKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MyTaskInput = Pick<
  MyTask,
  'title' | 'description' | 'status' | 'priority' | 'dueDate' | 'reminders'
>;

/** Morning is 05:00 to 12:00 and afternoon 12:00 to 18:00, local time. */
const MORNING = 5;
const AFTERNOON = 12;
const EVENING = 18;

/** Which parts of the day a task reminds in; 'every3h' is every three hours, day and night. */
export function reminderPlan(
  status: MyStatus,
  priority: MyPriority,
): 'every3h' | 'morning+afternoon' | 'morning' | null {
  if (status === 'todo')
    return priority === 'U'
      ? 'every3h'
      : priority === 'N'
        ? 'morning+afternoon'
        : 'morning';
  return priority === 'U'
    ? 'morning+afternoon'
    : priority === 'N'
      ? 'morning'
      : null;
}

/** Plain words for the plan, for the edit panel. */
export function reminderRule(status: MyStatus, priority: MyPriority): string {
  const s = `${MY_STATUS_NAME[status]} and ${MY_PRIORITY_NAME[priority]}`;
  switch (reminderPlan(status, priority)) {
    case 'every3h':
      return `${s}: every 3 hours, until you complete it.`;
    case 'morning+afternoon':
      return `${s}: in the morning and in the afternoon.`;
    case 'morning':
      return `${s}: in the morning.`;
    default:
      return `${s}: no reminders.`;
  }
}

const day = (d: Date) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/**
 * The reminder slot a task is due for at this time, or null. A task reminds
 * once per slot: when its last key equals this one, it has been shown.
 */
export function reminderKey(
  t: Pick<MyTask, 'status' | 'priority' | 'reminders'>,
  now: Date,
): string | null {
  if (!t.reminders) return null;
  const plan = reminderPlan(t.status, t.priority);
  if (!plan) return null;
  const h = now.getHours();
  if (plan === 'every3h')
    return `${day(now)}-3h-${String(Math.floor(h / 3)).padStart(2, '0')}`;
  if (h >= MORNING && h < AFTERNOON) return `${day(now)}-morning`;
  if (plan === 'morning+afternoon' && h >= AFTERNOON && h < EVENING)
    return `${day(now)}-afternoon`;
  return null;
}

/** When the next reminder comes, in words: "15:00", "Afternoon", "Tomorrow" or "—". */
export function nextReminder(
  t: Pick<MyTask, 'status' | 'priority' | 'reminders' | 'lastReminderKey'>,
  now: Date,
): string {
  if (!t.reminders) return '—';
  const plan = reminderPlan(t.status, t.priority);
  if (!plan) return '—';
  const key = reminderKey(t, now);
  if (key && key !== t.lastReminderKey) return 'Now';
  const h = now.getHours();
  if (plan === 'every3h') {
    const next = (Math.floor(h / 3) + 1) * 3;
    return next >= 24 ? 'Tomorrow' : `${String(next).padStart(2, '0')}:00`;
  }
  if (h < MORNING) return 'Morning';
  if (plan === 'morning+afternoon' && h < AFTERNOON) return 'Afternoon';
  return 'Tomorrow';
}

/** Sorted by due date (no date last), then priority, then oldest first. */
export function sortMyTasks(list: MyTask[]): MyTask[] {
  const rank = { U: 0, N: 1, L: 2 } as const;
  return [...list].sort(
    (a, b) =>
      (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
      rank[a.priority] - rank[b.priority] ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

/** The notification for a task, in the app language (tr translates). */
export function reminderText(
  t: Pick<MyTask, 'title' | 'status' | 'priority' | 'dueDate'>,
  today: string,
  tr: (s: string, vars?: Record<string, string>) => string = (s, v) =>
    v ? s.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? '') : s,
): { title: string; body: string } {
  const day = (t.dueDate ?? '').replaceAll('-', '/');
  const due = !t.dueDate
    ? tr('no due date')
    : t.dueDate < today
      ? tr('overdue since {day}', { day })
      : t.dueDate === today
        ? tr('due today')
        : tr('due {day}', { day });
  return {
    title: t.title,
    body: `${tr(MY_PRIORITY_NAME[t.priority])} · ${tr(MY_STATUS_NAME[t.status])} · ${due}`,
  };
}
