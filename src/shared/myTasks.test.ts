import { describe, expect, it } from 'vitest';
import {
  nextReminder,
  reminderKey,
  reminderRule,
  sortMyTasks,
  type MyTask,
} from './myTasks';

const at = (h: number, m = 0) => new Date(2026, 10, 6, h, m);
const t = (o: Partial<MyTask> = {}): MyTask => ({
  id: 'a',
  title: 'Expense report',
  description: '',
  status: 'todo',
  priority: 'N',
  dueDate: null,
  reminders: true,
  lastReminderKey: null,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  ...o,
});

describe('My tasks reminders (the FileManagement rules)', () => {
  it('reminds Todo Urgent every 3 hours, day and night', () => {
    expect(reminderKey(t({ priority: 'U' }), at(1))).toBe('20261106-3h-00');
    expect(reminderKey(t({ priority: 'U' }), at(14))).toBe('20261106-3h-04');
    expect(
      nextReminder(
        t({ priority: 'U', lastReminderKey: '20261106-3h-04' }),
        at(14),
      ),
    ).toBe('15:00');
  });
  it('reminds in the morning and the afternoon, by status and priority', () => {
    // Todo Normal and On-going Urgent: morning and afternoon.
    for (const x of [t(), t({ status: 'ongoing', priority: 'U' })]) {
      expect(reminderKey(x, at(4))).toBeNull();
      expect(reminderKey(x, at(5))).toBe('20261106-morning');
      expect(reminderKey(x, at(12))).toBe('20261106-afternoon');
      expect(reminderKey(x, at(18))).toBeNull();
    }
    // Todo Low and On-going Normal: morning only.
    for (const x of [t({ priority: 'L' }), t({ status: 'ongoing' })]) {
      expect(reminderKey(x, at(9))).toBe('20261106-morning');
      expect(reminderKey(x, at(13))).toBeNull();
    }
    // On-going Low: never.
    expect(
      reminderKey(t({ status: 'ongoing', priority: 'L' }), at(9)),
    ).toBeNull();
    expect(reminderRule('ongoing', 'L')).toMatch(/no reminders/);
  });
  it('stays quiet with the bell off, and says when the next one comes', () => {
    expect(reminderKey(t({ reminders: false }), at(9))).toBeNull();
    expect(nextReminder(t({ reminders: false }), at(9))).toBe('—');
    expect(nextReminder(t(), at(9))).toBe('Now');
    expect(
      nextReminder(t({ lastReminderKey: '20261106-morning' }), at(9)),
    ).toBe('Afternoon');
    expect(
      nextReminder(t({ lastReminderKey: '20261106-afternoon' }), at(13)),
    ).toBe('Tomorrow');
    expect(nextReminder(t(), at(3))).toBe('Morning');
  });
  it('sorts by due date, no date last, then priority', () => {
    const list = [
      t({ id: 'none', dueDate: null, priority: 'U' }),
      t({ id: 'late-n', dueDate: '2026-11-09' }),
      t({ id: 'late-u', dueDate: '2026-11-09', priority: 'U' }),
      t({ id: 'soon', dueDate: '2026-11-05', priority: 'L' }),
    ];
    expect(sortMyTasks(list).map((x) => x.id)).toEqual([
      'soon',
      'late-u',
      'late-n',
      'none',
    ]);
  });
});
