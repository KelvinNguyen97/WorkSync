import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { daysBetween, shortDate, type Task } from '../shared/model';
import {
  isLate,
  memberLabel,
  nextWorkStatus,
  parseQuickAdd,
  WORK_STATUS_NAME,
  type Member,
  type ProjectTask,
  type ProjectTaskInput,
  type WorkEvent,
  type WorkStatus,
} from '../shared/work';
import type { MyPriority } from '../shared/myTasks';
import { useApp } from './appState';
import { Icon } from './Icon';
import { tr } from './i18n';
import { confirmDelete, Modal } from './parts';

/** Tells every list of project tasks to load again. */
const CHANGED = 'worksync:work-changed';
export const workChanged = () => window.dispatchEvent(new Event(CHANGED));

/** Discussions, as far as tasks need them (filled in by discussions.tsx). */
export interface TicketRef {
  id: string;
  no: string;
  title: string;
  kind: 'progress' | 'discussion';
}

/** Project tasks of one project, or of all projects, kept current. */
export function useProjectTasks(projectId?: string) {
  const [list, setList] = useState<ProjectTask[]>([]);
  const load = useCallback(async () => {
    try {
      setList(await window.worksync.listProjectTasks(projectId));
    } catch {
      setList([]);
    }
  }, [projectId]);
  useEffect(() => {
    void load();
    const on = () => void load();
    window.addEventListener(CHANGED, on);
    return () => window.removeEventListener(CHANGED, on);
  }, [load]);
  return list;
}

export function useMembers(projectId: string | null) {
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    void window.worksync
      .listMembers(projectId)
      .then((m) => live && setMembers(m))
      .catch(() => live && setMembers([]));
    const on = () =>
      void window.worksync
        .listMembers(projectId)
        .then((m) => live && setMembers(m))
        .catch(() => undefined);
    window.addEventListener(CHANGED, on);
    return () => {
      live = false;
      window.removeEventListener(CHANGED, on);
    };
  }, [projectId]);
  return members;
}

/** Discussions of a project for ticket chips, loaded lazily. */
export function useDiscussionRefs(projectId: string | null): TicketRef[] {
  const [refs, setRefs] = useState<TicketRef[]>([]);
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    const load = () =>
      void window.worksync
        .listDiscussions(projectId)
        .then(
          (l) =>
            live &&
            setRefs(
              l.map((d) => ({
                id: d.id,
                no: d.no,
                title: d.title,
                kind: 'discussion' as const,
              })),
            ),
        )
        .catch(() => undefined);
    load();
    window.addEventListener(CHANGED, load);
    return () => {
      live = false;
      window.removeEventListener(CHANGED, load);
    };
  }, [projectId]);
  return refs;
}

const ticketTitle = (t: Task) => t.titleTranslation || t.titleOriginal;

const dueText = (d: string | null, today: string, done: boolean) => {
  if (!d) return { text: '', tone: '' };
  const n = daysBetween(today, d);
  if (!done && n < 0)
    return { text: tr('{date} late', { date: shortDate(d) }), tone: 'over' };
  if (n === 0) return { text: tr('Today'), tone: done ? '' : 'today' };
  if (n === 1) return { text: tr('Tomorrow'), tone: '' };
  return { text: shortDate(d), tone: '' };
};

function Check({ t, onNext }: { t: ProjectTask; onNext: () => void }) {
  return (
    <button
      className={`wk-check ${t.status}`}
      aria-label={tr('Move on: {title} ({status})', {
        title: t.title,
        status: tr(WORK_STATUS_NAME[t.status]),
      })}
      title={tr('{status}. Press to move it on.', {
        status: tr(WORK_STATUS_NAME[t.status]),
      })}
      onClick={(e) => {
        e.stopPropagation();
        onNext();
      }}
    >
      {t.status === 'done' ? (
        <Icon name="check" />
      ) : t.status === 'doing' ? (
        <span className="dot" />
      ) : null}
    </button>
  );
}

export function MemberChip({ id, members }: { id: string; members: Member[] }) {
  if (!id) return <span className="wk-who muted">{tr('Unassigned')}</span>;
  const m = members.find((x) => x.id === id);
  if (!m) return <span className="wk-who muted">{tr('Not a member')}</span>;
  return (
    <span className="wk-who" title={`${m.name} · ${m.account} · ${m.pc}`}>
      <span
        className="wk-avatar"
        style={{ background: m.color }}
        aria-hidden="true"
      >
        {m.name.slice(0, 1).toUpperCase()}
      </span>
      {m.me ? tr('You') : m.name}
      <span className="wk-tag">·{m.tag}</span>
    </span>
  );
}

/** One row of a task, for the Tasks view, a ticket and My tasks. */
export function TaskRow({
  t,
  members,
  ticket,
  onOpen,
  onOpenTicket,
  showTicket = true,
  from,
}: {
  t: ProjectTask;
  members: Member[];
  ticket?: TicketRef | null;
  onOpen: () => void;
  onOpenTicket?: (ref: TicketRef) => void;
  showTicket?: boolean;
  /** A line under the title, such as the project. */
  from?: string;
}) {
  const { attempt, today, toast } = useApp();
  const due = dueText(t.dueDate, today, t.status === 'done');
  const next = async () => {
    const status = nextWorkStatus(t.status);
    const u = await attempt(() =>
      window.worksync.saveProjectTask(t.projectId, { status }, t.id),
    );
    if (u) {
      workChanged();
      if (status === 'done')
        toast(tr('Done: “{title}”.', { title: t.title }), {
          label: tr('Undo'),
          run: () =>
            void attempt(() =>
              window.worksync.saveProjectTask(
                t.projectId,
                { status: t.status },
                t.id,
              ),
            ).then(() => workChanged()),
        });
    }
  };
  return (
    <div
      role="listitem"
      className={`wk-row ${t.status} ${isLate(t, today) ? 'late' : ''}`}
      onClick={onOpen}
    >
      <Check t={t} onNext={() => void next()} />
      <button
        className="wk-title"
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
      >
        <span>{t.title}</span>
        {from && <small>{from}</small>}
      </button>
      {showTicket && (
        <span className="wk-ticket-cell">
          {ticket && (
            <button
              className="wk-ticket"
              title={ticket.title}
              onClick={(e) => {
                e.stopPropagation();
                onOpenTicket?.(ticket);
              }}
            >
              {ticket.kind === 'discussion' ? (
                <Icon name="chat" />
              ) : (
                <Icon name="menu" />
              )}
              {ticket.no || tr('No number')}
            </button>
          )}
        </span>
      )}
      <MemberChip id={t.assignee} members={members} />
      <span className={`wk-due ${due.tone}`}>{due.text}</span>
    </div>
  );
}

/** The ticket a task points at, if it is still there. */
function refFor(
  t: ProjectTask,
  tickets: Task[],
  discussions: TicketRef[],
): TicketRef | null {
  if (t.ticketId) {
    const k = tickets.find((x) => x.id === t.ticketId);
    if (k)
      return {
        id: k.id,
        no: k.customerId,
        title: ticketTitle(k),
        kind: 'progress',
      };
  }
  if (t.discussionId)
    return discussions.find((d) => d.id === t.discussionId) ?? null;
  return null;
}

/** The quick add line: "Test streaming on Stg @Suzuki 11/21 #025". */
export function QuickAdd({
  projectId,
  members,
  ticketId,
  discussionId,
  placeholder,
}: {
  projectId: string;
  members: Member[];
  /** Adding from inside a ticket links the task to it. */
  ticketId?: string | null;
  discussionId?: string | null;
  placeholder?: string;
}) {
  const { attempt, tasks, today } = useApp();
  const discussions = useDiscussionRefs(projectId);
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const tickets = useMemo(
    () =>
      tasks
        .filter((t) => t.projectId === projectId)
        .map((t) => ({ id: t.id, no: t.customerId })),
    [tasks, projectId],
  );
  const parsed = parseQuickAdd(text, {
    members,
    tickets,
    discussions,
    today,
  });
  const at = /@(\S*)$/.exec(text);
  const offers = at
    ? members.filter((m) =>
        m.name.toLowerCase().startsWith(at[1].toLowerCase()),
      )
    : [];
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!parsed.title) {
      ref.current?.focus();
      return;
    }
    const inTicket = ticketId || discussionId;
    const t = await attempt(() =>
      window.worksync.saveProjectTask(projectId, {
        title: parsed.title,
        assignee: parsed.assignee,
        dueDate: parsed.dueDate,
        ticketId: inTicket ? (ticketId ?? null) : parsed.ticketId,
        discussionId: inTicket ? (discussionId ?? null) : parsed.discussionId,
      }),
    );
    if (t) {
      setText('');
      workChanged();
      ref.current?.focus();
    }
  };
  const who = members.find((m) => m.id === parsed.assignee);
  return (
    <form className="wk-add" onSubmit={(e) => void add(e)}>
      <div className="wk-add-line">
        <input
          ref={ref}
          className="inp grow"
          aria-label={tr('Add a task')}
          placeholder={
            placeholder ??
            tr('Add a task… (@who, a date like 11/21, #ticket number)')
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="btn primary" type="submit">
          <Icon name="plus" />
          {tr('Add')}
        </button>
      </div>
      {offers.length > 0 && (
        <div className="wk-offers" role="listbox" aria-label={tr('Members')}>
          {offers.map((m) => (
            <button
              type="button"
              role="option"
              aria-selected="false"
              key={m.id}
              className="qchip"
              onClick={() => {
                setText(text.replace(/@\S*$/, `@${m.name} `));
                ref.current?.focus();
              }}
            >
              {memberLabel(m, members)}
            </button>
          ))}
        </div>
      )}
      {text.trim() && (
        <div className="wk-parse muted" aria-live="polite">
          {parsed.title || '…'}
          {who && ` · ${who.me ? tr('You') : who.name}`}
          {parsed.dueDate && ` · ${shortDate(parsed.dueDate)}`}
          {parsed.ticketNo &&
            !ticketId &&
            !discussionId &&
            ` · #${parsed.ticketNo}`}
        </div>
      )}
    </form>
  );
}

/** The editor of one task, with its history. */
export function TaskDialog({
  task,
  onClose,
  onOpenTicket,
}: {
  task: ProjectTask;
  onClose: () => void;
  onOpenTicket?: (ref: TicketRef) => void;
}) {
  const { attempt, toast, tasks, project } = useApp();
  const members = useMembers(task.projectId);
  const discussions = useDiscussionRefs(task.projectId);
  const [history, setHistory] = useState<WorkEvent[]>([]);
  const [v, setV] = useState<ProjectTaskInput>({
    title: task.title,
    note: task.note,
    ticketId: task.ticketId,
    discussionId: task.discussionId,
    assignee: task.assignee,
    dueDate: task.dueDate,
    priority: task.priority,
    status: task.status,
    reminders: task.reminders,
  });
  useEffect(() => {
    void window.worksync
      .workHistory(task.id)
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [task.id]);
  const tickets = tasks.filter((t) => t.projectId === task.projectId);
  const link = v.ticketId
    ? `p:${v.ticketId}`
    : v.discussionId
      ? `d:${v.discussionId}`
      : '';
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const u = await attempt(() =>
      window.worksync.saveProjectTask(task.projectId, v, task.id),
    );
    if (u) {
      workChanged();
      toast(tr('Saved.'));
      onClose();
    }
  };
  const remove = async () => {
    if (
      !(await confirmDelete({
        title: tr('Delete “{title}”?', { title: task.title }),
        text: tr('The task is deleted from the project, with its history.'),
        yes: tr('Delete'),
      }))
    )
      return;
    const gone = await attempt(() =>
      window.worksync.deleteProjectTask(task.id),
    );
    if (!gone) return;
    workChanged();
    onClose();
    toast(tr('Deleted “{title}”.', { title: task.title }), {
      label: tr('Undo'),
      run: () =>
        void attempt(() => window.worksync.restoreProjectTask(gone)).then(() =>
          workChanged(),
        ),
    });
  };
  const name = (id: string) => {
    const m = members.find((x) => x.id === id);
    return m ? (m.me ? tr('You') : `${m.name} ·${m.tag}`) : '';
  };
  const ref = refFor(task, tasks, discussions);
  return (
    <Modal
      title={tr('Task')}
      subtitle={project(task.projectId)?.name ?? ''}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="btn danger-text"
            onClick={() => void remove()}
          >
            <Icon name="trash" />
            {tr('Delete')}
          </button>
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn primary" type="submit" form="wk-edit">
            <Icon name="check" />
            {tr('Save')}
          </button>
        </>
      }
    >
      <form id="wk-edit" className="form" onSubmit={(e) => void save(e)}>
        <label>
          {tr('Title')}
          <input
            className="inp"
            value={v.title}
            onChange={(e) => setV({ ...v, title: e.target.value })}
          />
        </label>
        <label>
          {tr('Note')}
          <textarea
            className="inp"
            rows={3}
            value={v.note}
            onChange={(e) => setV({ ...v, note: e.target.value })}
          />
        </label>
        <div className="two">
          <label>
            {tr('Assignee')}
            <select
              className="inp"
              value={v.assignee}
              onChange={(e) => setV({ ...v, assignee: e.target.value })}
            >
              <option value="">{tr('Unassigned')}</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.me
                    ? `${tr('You')} (${m.name} ·${m.tag})`
                    : memberLabel(m, members)}
                </option>
              ))}
              {v.assignee && !members.some((m) => m.id === v.assignee) && (
                <option value={v.assignee}>{tr('Not a member')}</option>
              )}
            </select>
          </label>
          <label>
            {tr('Due date')}
            <input
              className="inp"
              type="date"
              value={v.dueDate ?? ''}
              onChange={(e) => setV({ ...v, dueDate: e.target.value || null })}
            />
          </label>
        </div>
        <div className="two">
          <label>
            {tr('Status')}
            <select
              className="inp"
              value={v.status}
              onChange={(e) =>
                setV({ ...v, status: e.target.value as WorkStatus })
              }
            >
              <option value="todo">{tr('To do')}</option>
              <option value="doing">{tr('Doing')}</option>
              <option value="done">{tr('Done')}</option>
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
          {tr('Ticket')}
          <select
            className="inp"
            value={link}
            onChange={(e) => {
              const x = e.target.value;
              setV({
                ...v,
                ticketId: x.startsWith('p:') ? x.slice(2) : null,
                discussionId: x.startsWith('d:') ? x.slice(2) : null,
              });
            }}
          >
            <option value="">{tr('No ticket')}</option>
            {tickets.map((t) => (
              <option key={t.id} value={`p:${t.id}`}>
                {t.customerId ? `${t.customerId} · ` : ''}
                {ticketTitle(t)}
              </option>
            ))}
            {discussions.map((d) => (
              <option key={d.id} value={`d:${d.id}`}>
                {tr('Discussion')} {d.no ? `${d.no} · ` : ''}
                {d.title}
              </option>
            ))}
          </select>
        </label>
        {ref && onOpenTicket && (
          <button
            type="button"
            className="linkbtn"
            onClick={() => {
              onClose();
              onOpenTicket(ref);
            }}
          >
            {tr('Open ticket {no}', { no: ref.no || ref.title })}
          </button>
        )}
        <p className="muted">
          {tr('Made by {who} on {date}.', {
            who: name(task.madeBy) || tr('someone'),
            date: shortDate(task.createdAt.slice(0, 10)),
          })}
          {task.doneAt &&
            ` ${tr('Done by {who} on {date}.', {
              who: name(task.doneBy) || tr('someone'),
              date: shortDate(task.doneAt.slice(0, 10)),
            })}`}
        </p>
        {history.length > 0 && (
          <details className="wk-history">
            <summary>{tr('History')}</summary>
            <ul>
              {history.map((h) => (
                <li key={h.id}>
                  <span className="mono">
                    {h.at.slice(0, 16).replace('T', ' ')}
                  </span>{' '}
                  {name(h.by) && <b>{name(h.by)}</b>} {trWork(h.text)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </form>
    </Modal>
  );
}

/** History lines are stored in English; these are their shapes. */
export function trWork(text: string): string {
  return text
    .split(/(?<=\.)\s+/)
    .map((part) => {
      let m = /^Status: (.+) → (.+)\.$/.exec(part);
      if (m) return tr('Status: {a} → {b}.', { a: tr(m[1]), b: tr(m[2]) });
      m = /^Assigned to (.+) \(was (.+)\)\.$/.exec(part);
      if (m)
        return tr('Assigned to {a} (was {b}).', {
          a: tr(m[1]),
          b: tr(m[2]),
        });
      m = /^Made and assigned to (.+)\.$/.exec(part);
      if (m) return tr('Made and assigned to {a}.', { a: tr(m[1]) });
      m = /^Linked to progress ticket (.*)\.$/.exec(part);
      if (m) return tr('Linked to progress ticket {no}.', { no: m[1] });
      m = /^Unlinked from progress ticket (.*)\.$/.exec(part);
      if (m) return tr('Unlinked from progress ticket {no}.', { no: m[1] });
      m = /^Summarized into progress ticket (.*), up to comment (\d+)\.$/.exec(
        part,
      );
      if (m)
        return tr('Summarized into progress ticket {no}, up to comment {n}.', {
          no: m[1],
          n: m[2],
        });
      m = /^Due date: (.+)\.$/.exec(part);
      if (m)
        return tr('Due date: {d}.', { d: m[1] === 'none' ? tr('none') : m[1] });
      return tr(part);
    })
    .join(' ');
}

type Group = 'status' | 'assignee';
type Filter = 'all' | 'mine' | 'unassigned' | 'overdue' | 'ticket';

/** The Tasks view of a project (doc 10, 3.2). */
export function WorkView({
  projectId,
  query,
  header,
  openTicket,
}: {
  projectId: string;
  query: string;
  header: (title: string, subtitle: string) => React.ReactNode;
  openTicket: (ref: TicketRef) => void;
}) {
  const { tasks: tickets, today, project } = useApp();
  const list = useProjectTasks(projectId);
  const members = useMembers(projectId);
  const discussions = useDiscussionRefs(projectId);
  const [group, setGroup] = useState<Group>('status');
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<ProjectTask | null>(null);
  const [showDone, setShowDone] = useState(false);
  const me = members.find((m) => m.me)?.id ?? '';
  const q = query.trim().toLowerCase();
  const refs = new Map(
    list.map((t) => [t.id, refFor(t, tickets, discussions)]),
  );
  const passes = (t: ProjectTask) =>
    (filter === 'all' ||
      (filter === 'mine' && t.assignee === me) ||
      (filter === 'unassigned' && !t.assignee) ||
      (filter === 'overdue' && isLate(t, today)) ||
      (filter === 'ticket' && !!refs.get(t.id))) &&
    (!q ||
      `${t.title} ${t.note} ${refs.get(t.id)?.no ?? ''}`
        .toLowerCase()
        .includes(q));
  const shown = list.filter(passes);
  const open_ = shown.filter((t) => t.status !== 'done');
  const done = shown.filter((t) => t.status === 'done');
  const sortDue = (a: ProjectTask, b: ProjectTask) =>
    (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
    a.createdAt.localeCompare(b.createdAt);
  const groups: { key: string; name: string; items: ProjectTask[] }[] =
    group === 'status'
      ? (['todo', 'doing'] as WorkStatus[]).map((s) => ({
          key: s,
          name: tr(WORK_STATUS_NAME[s]),
          items: open_.filter((t) => t.status === s).sort(sortDue),
        }))
      : [
          ...members.map((m) => ({
            key: m.id,
            name: m.me
              ? `${tr('You')} (${m.name} ·${m.tag})`
              : memberLabel(m, members),
            items: open_.filter((t) => t.assignee === m.id).sort(sortDue),
          })),
          {
            key: '',
            name: tr('Unassigned'),
            items: open_
              .filter((t) => !members.some((m) => m.id === t.assignee))
              .sort(sortDue),
          },
        ];
  const counts: Record<Filter, number> = {
    all: list.length,
    mine: list.filter((t) => t.assignee === me && t.status !== 'done').length,
    unassigned: list.filter((t) => !t.assignee && t.status !== 'done').length,
    overdue: list.filter((t) => isLate(t, today)).length,
    ticket: list.filter((t) => !!refs.get(t.id)).length,
  };
  const chips: [Filter, string][] = [
    ['all', 'All'],
    ['mine', 'Mine'],
    ['unassigned', 'Unassigned'],
    ['overdue', 'Overdue'],
    ['ticket', 'For a ticket'],
  ];
  return (
    <div className="wk-page">
      {header(
        tr('Tasks'),
        tr('{name} · small jobs for the project, each for one person', {
          name: project(projectId)?.name ?? '',
        }),
      )}
      <QuickAdd projectId={projectId} members={members} />
      <div className="mt-chips">
        <div role="group" aria-label={tr('Show')} className="wk-chips">
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
        </div>
        <span className="grow" />
        <div className="seg-ctl" role="radiogroup" aria-label={tr('Group by')}>
          <button
            role="radio"
            aria-checked={group === 'status'}
            onClick={() => setGroup('status')}
          >
            {tr('By status')}
          </button>
          <button
            role="radio"
            aria-checked={group === 'assignee'}
            onClick={() => setGroup('assignee')}
          >
            {tr('By assignee')}
          </button>
        </div>
      </div>
      <div className="wk-groups">
        {groups.map((g) => (
          <section
            key={g.key || 'none'}
            className="wk-group"
            aria-label={g.name}
          >
            <h2>
              {g.name} <span className="muted">{g.items.length}</span>
            </h2>
            <div role="list">
              {g.items.map((t) => (
                <TaskRow
                  key={t.id}
                  t={t}
                  members={members}
                  ticket={refs.get(t.id)}
                  onOpen={() => setOpen(t)}
                  onOpenTicket={openTicket}
                />
              ))}
              {!g.items.length && (
                <div className="wk-empty muted">{tr('Nothing here.')}</div>
              )}
            </div>
          </section>
        ))}
        <section className="wk-group done" aria-label={tr('Done')}>
          <button
            className="wk-fold"
            aria-expanded={showDone}
            onClick={() => setShowDone(!showDone)}
          >
            <Icon name="chev" />
            {tr('Done')} <span className="muted">{done.length}</span>
          </button>
          {showDone && (
            <div role="list">
              {done
                .sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''))
                .map((t) => (
                  <TaskRow
                    key={t.id}
                    t={t}
                    members={members}
                    ticket={refs.get(t.id)}
                    onOpen={() => setOpen(t)}
                    onOpenTicket={openTicket}
                  />
                ))}
            </div>
          )}
        </section>
        {!list.length && (
          <div className="empty">
            <b>{tr('No tasks yet.')}</b>
            <p className="muted">
              {tr(
                'Type a task above and press Enter. Add @name for who does it, a date like 11/21, and #025 to link it to ticket 025.',
              )}
            </p>
          </div>
        )}
      </div>
      {open && (
        <TaskDialog
          task={list.find((x) => x.id === open.id) ?? open}
          onClose={() => setOpen(null)}
          onOpenTicket={openTicket}
        />
      )}
    </div>
  );
}

/** The Tasks part of a progress or discussion ticket (doc 10, 3.3). */
export function TicketTasks({
  projectId,
  ticketId,
  discussionId,
}: {
  projectId: string;
  ticketId?: string;
  discussionId?: string;
}) {
  const list = useProjectTasks(projectId).filter((t) =>
    ticketId ? t.ticketId === ticketId : t.discussionId === discussionId,
  );
  const members = useMembers(projectId);
  const [open, setOpen] = useState<ProjectTask | null>(null);
  const done = list.filter((t) => t.status === 'done').length;
  return (
    <section className="wk-in-ticket" aria-label={tr('Tasks')}>
      <div className="wk-in-head">
        <h3 className="k">
          {tr('Tasks')}
          {list.length > 0 && (
            <span className="muted">
              {' '}
              · {tr('{done} of {total} done', { done, total: list.length })}
            </span>
          )}
        </h3>
        {list.length > 0 && (
          <div className="wk-bar" aria-hidden="true">
            <div
              style={{ width: `${Math.round((done / list.length) * 100)}%` }}
            />
          </div>
        )}
      </div>
      <div role="list">
        {list
          .sort(
            (a, b) =>
              Number(a.status === 'done') - Number(b.status === 'done') ||
              a.createdAt.localeCompare(b.createdAt),
          )
          .map((t) => (
            <TaskRow
              key={t.id}
              t={t}
              members={members}
              showTicket={false}
              onOpen={() => setOpen(t)}
            />
          ))}
      </div>
      <QuickAdd
        projectId={projectId}
        members={members}
        ticketId={ticketId ?? null}
        discussionId={discussionId ?? null}
        placeholder={tr('Add a task to this ticket… (@who, a date)')}
      />
      {open && (
        <TaskDialog
          task={list.find((x) => x.id === open.id) ?? open}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}

/** My tasks › From projects: project tasks assigned to you (doc 10, 3.4). */
export function FromProjects({
  query,
  onOpenTicket,
  focusId,
}: {
  query: string;
  onOpenTicket: (ref: TicketRef, projectId: string) => void;
  focusId?: string | null;
}) {
  const { projects, tasks: tickets } = useApp();
  const all = useProjectTasks();
  const [me, setMe] = useState('');
  const [members, setMembers] = useState<Record<string, Member[]>>({});
  const [open, setOpen] = useState<ProjectTask | null>(null);
  useEffect(() => {
    void window.worksync
      .myMemberId()
      .then(setMe)
      .catch(() => undefined);
  }, []);
  const mine = all.filter(
    (t) => t.assignee === me && me && t.status !== 'done',
  );
  const projectIds = [...new Set(mine.map((t) => t.projectId))];
  useEffect(() => {
    for (const p of projectIds)
      if (!members[p])
        void window.worksync
          .listMembers(p)
          .then((m) => setMembers((x) => ({ ...x, [p]: m })))
          .catch(() => undefined);
  }, [projectIds.join(',')]);
  useEffect(() => {
    if (focusId) {
      const t = all.find((x) => x.id === focusId);
      if (t) setOpen(t);
    }
  }, [focusId, all.length]);
  const q = query.trim().toLowerCase();
  const shown = mine.filter(
    (t) => !q || `${t.title} ${t.note}`.toLowerCase().includes(q),
  );
  if (!mine.length) return null;
  return (
    <section className="wk-from" aria-label={tr('From projects')}>
      <h2 className="k">
        {tr('From projects · assigned to you')}{' '}
        <span className="muted">{mine.length}</span>
      </h2>
      {projects
        .filter((p) => shown.some((t) => t.projectId === p.id))
        .map((p) => {
          const items = shown
            .filter((t) => t.projectId === p.id)
            .sort(
              (a, b) =>
                (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
                a.createdAt.localeCompare(b.createdAt),
            );
          return (
            <div key={p.id} className="wk-from-group">
              <div className="wk-from-name">
                <b>{p.name}</b>{' '}
                <span className="muted">
                  {tr(items.length === 1 ? '{n} task' : '{n} tasks', {
                    n: items.length,
                  })}
                </span>
              </div>
              <div role="list">
                {items.map((t) => (
                  <TaskRow
                    key={t.id}
                    t={t}
                    members={members[p.id] ?? []}
                    ticket={refFor(t, tickets, [])}
                    onOpen={() => setOpen(t)}
                    onOpenTicket={(r) => onOpenTicket(r, p.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      {open && (
        <TaskDialog
          task={all.find((x) => x.id === open.id) ?? open}
          onClose={() => setOpen(null)}
          onOpenTicket={(r) => onOpenTicket(r, open.projectId)}
        />
      )}
    </section>
  );
}
