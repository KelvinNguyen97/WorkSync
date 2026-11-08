import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { daysBetween, shortDate } from '../shared/model';
import {
  MY_PRIORITY_NAME,
  MY_STATUS_NAME,
  nextReminder,
  reminderRule,
  sortMyTasks,
  type MyPriority,
  type MyStatus,
  type MyTask,
  type MyTaskInput,
} from '../shared/myTasks';
import { useApp } from './appState';
import { Icon } from './Icon';
import { tr } from './i18n';

/** The fixed area above a page, where its title goes. */
export type HeaderSlot = HTMLElement | null;

type Filter = 'all' | 'todo' | 'ongoing' | 'today' | 'overdue';

/** The current time, refreshed every minute so "Next reminder" stays right. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60 * 1000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

const dueText = (d: string | null, today: string) => {
  if (!d) return { text: tr('No date'), tone: '' };
  const n = daysBetween(today, d);
  if (n < 0)
    return {
      text: tr(n === -1 ? 'Overdue by {n} day' : 'Overdue by {n} days', {
        n: -n,
      }),
      tone: 'over',
    };
  if (n === 0) return { text: tr('Today'), tone: 'today' };
  if (n === 1) return { text: tr('Tomorrow'), tone: '' };
  return { text: shortDate(d), tone: '' };
};

/**
 * My tasks: the owner's own to-dos, not tied to a project. Completing one
 * deletes it, with Undo. Reminders come from the main process.
 */
export function MyTasksView({
  tasks,
  setTasks,
  query,
  head,
  focusId,
}: {
  tasks: MyTask[];
  setTasks: (f: (list: MyTask[]) => MyTask[]) => void;
  query: string;
  head: HeaderSlot;
  /** A task to select, such as one whose reminder was clicked. */
  focusId: string | null;
}) {
  const { attempt, toast, today, settings } = useApp();
  const now = useNow();
  const [filter, setFilter] = useState<Filter>('all');
  const [sel, setSel] = useState<string | null>(null);
  const addRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState({
    title: '',
    dueDate: '',
    priority: 'N' as MyPriority,
  });

  useEffect(() => {
    if (focusId) setSel(focusId);
  }, [focusId]);

  const counts = useMemo(
    () => ({
      all: tasks.length,
      todo: tasks.filter((t) => t.status === 'todo').length,
      ongoing: tasks.filter((t) => t.status === 'ongoing').length,
      today: tasks.filter((t) => t.dueDate === today).length,
      overdue: tasks.filter((t) => t.dueDate && t.dueDate < today).length,
    }),
    [tasks, today],
  );
  const q = query.trim().toLowerCase();
  const shown = sortMyTasks(tasks).filter(
    (t) =>
      (filter === 'all' ||
        (filter === 'todo' && t.status === 'todo') ||
        (filter === 'ongoing' && t.status === 'ongoing') ||
        (filter === 'today' && t.dueDate === today) ||
        (filter === 'overdue' && !!t.dueDate && t.dueDate < today)) &&
      (!q || `${t.title} ${t.description}`.toLowerCase().includes(q)),
  );
  const selected = tasks.find((t) => t.id === sel) ?? null;

  const put = (t: MyTask) =>
    setTasks((list) =>
      list.some((x) => x.id === t.id)
        ? list.map((x) => (x.id === t.id ? t : x))
        : [...list, t],
    );

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.title.trim()) {
      addRef.current?.focus();
      return;
    }
    const t = await attempt(() =>
      window.worksync.saveMyTask({
        title: draft.title,
        dueDate: draft.dueDate || null,
        priority: draft.priority,
        status: 'todo',
        reminders: true,
        description: '',
      }),
    );
    if (!t) return;
    put(t);
    setDraft({ title: '', dueDate: '', priority: draft.priority });
    addRef.current?.focus();
  };

  const complete = async (t: MyTask, word: 'Completed' | 'Deleted') => {
    const gone = await attempt(() => window.worksync.completeMyTask(t.id));
    if (!gone) return;
    setTasks((list) => list.filter((x) => x.id !== t.id));
    if (sel === t.id) setSel(null);
    toast(
      tr(word === 'Completed' ? 'Completed “{title}”.' : 'Deleted “{title}”.', {
        title: t.title,
      }),
      {
        label: tr('Undo'),
        run: () =>
          void attempt(() => window.worksync.restoreMyTask(gone)).then(
            (back) => back && put(back),
          ),
      },
    );
  };

  const toggleBell = async (t: MyTask) => {
    const u = await attempt(() =>
      window.worksync.saveMyTask({ reminders: !t.reminders }, t.id),
    );
    if (u) put(u);
  };

  const chips: [Filter, string][] = [
    ['all', 'All'],
    ['todo', 'Todo'],
    ['ongoing', 'On-going'],
    ['today', 'Due today'],
    ['overdue', 'Overdue'],
  ];

  return (
    <div className="mine-page">
      {head &&
        createPortal(
          <div className="vh">
            <div>
              <h1>{tr('My tasks')}</h1>
              <div className="sub">
                {tr('Your own to-dos, not tied to a project.')}{' '}
                {settings.reminders
                  ? settings.keepInTray
                    ? tr(
                        'Reminders appear while WorkSync runs, also from the tray.',
                      )
                    : tr('Reminders appear while WorkSync is open.')
                  : tr('Reminders are off in Settings.')}
              </div>
            </div>
          </div>,
          head,
        )}
      <form className="mt-add" onSubmit={(e) => void add(e)}>
        <input
          ref={addRef}
          className="inp grow"
          aria-label={tr('New task')}
          placeholder={tr('Add a task, then press Enter')}
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
        <input
          className="inp"
          type="date"
          aria-label={tr('Due date')}
          value={draft.dueDate}
          onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
        />
        <select
          className="inp"
          aria-label={tr('Priority')}
          value={draft.priority}
          onChange={(e) =>
            setDraft({ ...draft, priority: e.target.value as MyPriority })
          }
        >
          <option value="U">{tr('Urgent')}</option>
          <option value="N">{tr('Normal')}</option>
          <option value="L">{tr('Low')}</option>
        </select>
        <button className="btn primary" type="submit">
          <Icon name="plus" />
          {tr('Add task')}
        </button>
      </form>
      <div className="mt-chips" role="group" aria-label={tr('Show')}>
        {chips.map(([k, l]) => (
          <button
            key={k}
            className="qchip"
            aria-pressed={filter === k}
            onClick={() => setFilter(k)}
          >
            {tr(l)} <b>{counts[k]}</b>
          </button>
        ))}
        <span className="grow" />
        <span className="muted mt-sort">
          {tr('Sorted by due date, then priority')}
        </span>
      </div>
      <div className="mt-body">
        <div className="mt-list" role="list" aria-label={tr('My tasks')}>
          <div className="mt-row mt-headrow" aria-hidden="true">
            <span />
            <span>{tr('Task')}</span>
            <span className="c-status">{tr('Status')}</span>
            <span className="c-pri">{tr('Priority')}</span>
            <span className="c-due">{tr('Due')}</span>
            <span className="c-next">{tr('Reminder')}</span>
            <span />
          </div>
          {shown.map((t) => {
            const due = dueText(t.dueDate, today);
            return (
              <div
                key={t.id}
                role="listitem"
                className={`mt-row ${t.id === sel ? 'sel' : ''}`}
                onClick={() => setSel(t.id)}
              >
                <button
                  className="mt-done"
                  aria-label={`Complete ${t.title}`}
                  title={tr('Complete (removes the task)')}
                  onClick={(e) => {
                    e.stopPropagation();
                    void complete(t, 'Completed');
                  }}
                >
                  <Icon name="check" />
                </button>
                <button
                  className="mt-title"
                  onClick={() => setSel(t.id)}
                  aria-label={`Edit ${t.title}`}
                >
                  <b>{t.title}</b>
                  {t.description && <small>{t.description}</small>}
                  <small className="mt-mini">
                    {tr(MY_STATUS_NAME[t.status])} ·{' '}
                    {tr(MY_PRIORITY_NAME[t.priority])}
                  </small>
                </button>
                <span className="c-status">
                  <span className={`mt-status ${t.status}`}>
                    {tr(MY_STATUS_NAME[t.status])}
                  </span>
                </span>
                <span className="c-pri">
                  <span className={`mt-pri ${t.priority}`}>
                    {tr(MY_PRIORITY_NAME[t.priority])}
                  </span>
                </span>
                <span className={`c-due mt-due ${due.tone}`}>{due.text}</span>
                <span className="c-next mono mt-next">
                  {settings.reminders ? tr(nextReminder(t, now)) : '—'}
                </span>
                <span className="mt-acts">
                  <button
                    className={`icon-btn ${t.reminders ? 'on' : ''}`}
                    aria-pressed={t.reminders}
                    aria-label={`Reminders for ${t.title}`}
                    title={
                      t.reminders ? tr('Reminders on') : tr('Reminders off')
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggleBell(t);
                    }}
                  >
                    <Icon name={t.reminders ? 'bell' : 'bellOff'} />
                  </button>
                  <button
                    className="icon-btn"
                    aria-label={`Delete ${t.title}`}
                    title={tr('Delete')}
                    onClick={(e) => {
                      e.stopPropagation();
                      void complete(t, 'Deleted');
                    }}
                  >
                    <Icon name="trash" />
                  </button>
                </span>
              </div>
            );
          })}
          {!shown.length && (
            <div className="empty mt-empty">
              {tasks.length
                ? tr('No task matches. Try another filter.')
                : tr('Nothing to do. Add a task above.')}
            </div>
          )}
        </div>
        <aside className="mt-side" aria-label={tr('Edit task')}>
          {selected ? (
            <MyTaskEditor
              key={selected.id}
              task={selected}
              onSaved={put}
              onClose={() => setSel(null)}
            />
          ) : (
            <div className="mt-help">
              <b>{tr('Select a task to edit it.')}</b>
              <ReminderRules />
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function MyTaskEditor({
  task,
  onSaved,
  onClose,
}: {
  task: MyTask;
  onSaved: (t: MyTask) => void;
  onClose: () => void;
}) {
  const { attempt, toast } = useApp();
  const [v, setV] = useState<MyTaskInput>({
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate,
    reminders: task.reminders,
  });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const u = await attempt(() => window.worksync.saveMyTask(v, task.id));
    if (u) {
      onSaved(u);
      toast(tr('Saved.'));
    }
  };
  return (
    <form
      className="form mt-edit"
      onSubmit={(e) => void save(e)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="mt-edit-head">
        <span className="k">{tr('Edit task')}</span>
        <button
          type="button"
          className="icon-btn"
          aria-label={tr('Close')}
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
      </div>
      <label>
        {tr('Title')}
        <input
          className="inp"
          value={v.title}
          onChange={(e) => setV({ ...v, title: e.target.value })}
        />
      </label>
      <label>
        {tr('Description')}
        <textarea
          className="inp"
          rows={4}
          value={v.description}
          onChange={(e) => setV({ ...v, description: e.target.value })}
        />
      </label>
      <div className="two">
        <label>
          {tr('Status')}
          <select
            className="inp"
            value={v.status}
            onChange={(e) => setV({ ...v, status: e.target.value as MyStatus })}
          >
            <option value="todo">{tr('Todo')}</option>
            <option value="ongoing">{tr('On-going')}</option>
          </select>
        </label>
        <label>
          {tr('Priority')}
          <select
            className="inp"
            value={v.priority}
            onChange={(e) =>
              setV({ ...v, priority: e.target.value as MyPriority })
            }
          >
            <option value="U">{tr('Urgent')}</option>
            <option value="N">{tr('Normal')}</option>
            <option value="L">{tr('Low')}</option>
          </select>
        </label>
      </div>
      <label>
        {tr('Due date')}
        <input
          className="inp"
          type="date"
          value={v.dueDate ?? ''}
          onChange={(e) => setV({ ...v, dueDate: e.target.value || null })}
        />
      </label>
      <div className="mt-remind">
        <button
          type="button"
          className="switch"
          role="switch"
          aria-checked={v.reminders}
          aria-label={tr('Remind me')}
          onClick={() => setV({ ...v, reminders: !v.reminders })}
        >
          <span />
        </button>
        <span>
          <b>{tr('Remind me')}</b>
          <small>
            {v.reminders
              ? reminderRule(v.status, v.priority)
              : tr('No reminders for this task.')}
          </small>
        </span>
      </div>
      <div className="mt-edit-foot">
        <button type="button" className="btn" onClick={onClose}>
          {tr('Cancel')}
        </button>
        <button className="btn primary" type="submit">
          <Icon name="check" />
          {tr('Save')}
        </button>
      </div>
      <details className="mt-rules">
        <summary>{tr('When reminders appear')}</summary>
        <ReminderRules />
      </details>
    </form>
  );
}

function ReminderRules() {
  return (
    <>
      <div className="mt-rule-grid">
        <span />
        <b>{tr('Urgent')}</b>
        <b>{tr('Normal')}</b>
        <b>{tr('Low')}</b>
        <b>{tr('Todo')}</b>
        <span>{tr('Every 3 hours')}</span>
        <span>{tr('Morning, afternoon')}</span>
        <span>{tr('Morning')}</span>
        <b>{tr('On-going')}</b>
        <span>{tr('Morning, afternoon')}</span>
        <span>{tr('Morning')}</span>
        <span>{tr('None')}</span>
      </div>
      <p className="muted">
        {tr(
          'Morning is from 05:00 to 12:00, afternoon from 12:00 to 18:00. Each reminder appears once, while WorkSync runs.',
        )}
      </p>
    </>
  );
}
