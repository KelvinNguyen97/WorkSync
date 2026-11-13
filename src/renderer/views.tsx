import {
  useMemo,
  useState,
  type FormEvent,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  STATUSES,
  byPriority,
  flags,
  focusReasons,
  inFocus,
  isClosed,
  type Project,
  type Status,
  type Task,
} from '../shared/model';
import { useApp } from './appState';
import {
  boardSlots,
  slotOf,
  type BoardColumn,
  type BoardSettings,
  type BoardSlot,
} from '../shared/board';

import { Icon } from './Icon';
import {
  Modal,
  Labels,
  MetaChips,
  PriorityTag,
  StatusChip,
  TaskNumber,
  Titles,
  useTaskLabel,
  DeadlineChip,
  priorityClass,
  confirmDelete,
} from './parts';
import { tr, trReason } from './i18n';

export interface ViewProps {
  query: string;
  /** The search and the top bar filter together. */
  match: (t: Task) => boolean;
  /** The top bar filter alone, for views that search on their own. */
  passes: (t: Task) => boolean;
  openTask: (id: string) => void;
  openMenu: (
    task: Task,
    opener: HTMLElement,
    at?: { x: number; y: number },
  ) => void;
  /** Renders the fixed header: title, subtitle and the controls beside them. */
  header: (title: string, subtitle: string, right?: ReactNode) => ReactNode;
}

/** Right-click, or the context menu key, opens the priority menu without opening the task. */
const contextMenu =
  (task: Task, openMenu: ViewProps['openMenu']) =>
  (e: MouseEvent<HTMLElement>) => {
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const keyboard = !e.clientX && !e.clientY;
    openMenu(
      task,
      e.currentTarget,
      keyboard
        ? { x: r.left + 16, y: r.top + 44 }
        : { x: e.clientX, y: e.clientY },
    );
  };

const keyOpen =
  (id: string, openTask: (id: string) => void) => (e: React.KeyboardEvent) => {
    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openTask(id);
    }
  };

/** Moves the soft light on a card with the pointer. */
const spotlight = (e: MouseEvent<HTMLElement>) => {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`);
};

function FocusCard({
  task,
  project,
  showProject,
  props,
}: {
  task: Task;
  project: Project;
  showProject: boolean;
  props: ViewProps;
}) {
  const label = useTaskLabel();
  const { today } = useApp();
  const why = focusReasons(task, today, project.dueSoonDays);
  const s = task.situation;
  return (
    <article
      className={`tcard ${priorityClass(task)}`}
      tabIndex={0}
      role="button"
      aria-label={tr('Open {task}, {title}', {
        task: label(task),
        title: task.titleTranslation || task.titleOriginal,
      })}
      onClick={() => props.openTask(task.id)}
      onKeyDown={keyOpen(task.id, props.openTask)}
      onContextMenu={contextMenu(task, props.openMenu)}
      onMouseMove={spotlight}
    >
      <div className="tc-top">
        <TaskNumber task={task} />
        {showProject && (
          <span className="tc-proj">{initials(project.name)}</span>
        )}
        <span className="sp" />
        {task.pinned && (
          <span className="pin" title={tr('Pinned')}>
            <Icon name="pin" />
          </span>
        )}
        <PriorityTag task={task} />
      </div>
      <Labels labels={task.labels} />
      <div>
        <Titles task={task} />
      </div>
      {s.handledBy || s.doingNow ? (
        <div className="tc-sit">
          <Icon name="user" />
          <span className="clamp2">
            <b>{s.handledBy || tr('Someone')}</b>
            {s.doingNow ? ` · ${s.doingNow}` : ''}
          </span>
        </div>
      ) : (
        <div className="tc-sit muted">
          <Icon name="user" />
          <span>{tr('No situation recorded yet')}</span>
        </div>
      )}
      <div className="tc-foot">
        <MetaChips task={task} dueSoonDays={project.dueSoonDays} />
      </div>
      {why.length > 0 && (
        <div className="why">{why.map(trReason).join(' · ')}</div>
      )}
    </article>
  );
}

export const initials = (name: string): string => {
  const words = name
    .replace(/^sample:\s*/i, '')
    .replace(/[(（][^)）]*[)）]/g, ' ')
    .split(/[\s・,]+/)
    .filter((w) => /\p{L}/u.test(w));
  if (!words.length) return '–';
  const first = [...words[0]];
  return (
    words.length > 1 ? first[0] + [...words[1]][0] : first.slice(0, 2).join('')
  ).toUpperCase();
};

const QUICK = {
  overdue: {
    label: 'Overdue',
    test: (f: ReturnType<typeof flags>) => f.overdue,
  },
  soon: { label: 'Due soon', test: (f: ReturnType<typeof flags>) => f.dueSoon },
  me: {
    label: 'Needs my action',
    test: (f: ReturnType<typeof flags>) => f.needsMyAction,
  },
  next: {
    label: 'Next step overdue',
    test: (f: ReturnType<typeof flags>) => f.nextStepOverdue,
  },
  diff: {
    label: 'Open difficulties',
    test: (f: ReturnType<typeof flags>) => f.openDifficulties > 0,
  },
} as const;
type QuickKey = keyof typeof QUICK;

export function FocusView({
  scope,
  props,
  onNewTask,
}: {
  scope: string | 'all';
  props: ViewProps;
  onNewTask: () => void;
}) {
  const { tasks, today, project, projects } = useApp();
  const [quick, setQuick] = useState<QuickKey | null>(null);
  const all = scope === 'all';
  const base = useMemo(
    () =>
      tasks.filter((t) => {
        const p = project(t.projectId);
        return (
          p &&
          (all || t.projectId === scope) &&
          inFocus(t, today, p.dueSoonDays)
        );
      }),
    [tasks, scope, all, today, project],
  );
  const days = (t: Task) => project(t.projectId)?.dueSoonDays ?? 7;
  const shown = base
    .filter((t) => !quick || QUICK[quick].test(flags(t, today, days(t))))
    .filter((t) => props.match(t))
    .sort(byPriority);
  const chips = (
    <div className="qchips" role="group" aria-label={tr('Quick filters')}>
      {(Object.keys(QUICK) as QuickKey[]).map((k) => (
        <button
          key={k}
          className="qchip"
          aria-pressed={quick === k}
          onClick={() => setQuick(quick === k ? null : k)}
        >
          {tr(QUICK[k].label)}{' '}
          <b>
            {base.filter((t) => QUICK[k].test(flags(t, today, days(t)))).length}
          </b>
        </button>
      ))}
    </div>
  );
  const date = new Date(`${today}T00:00:00`).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const scopeName = all ? tr('All projects') : (project(scope)?.name ?? '');
  const projectTasks = all ? tasks : tasks.filter((t) => t.projectId === scope);
  return (
    <>
      {props.header(
        tr('Focus'),
        tr(
          '{scope} · {date} · sorted by priority, then due date · right-click a card to change its priority',
          { scope: scopeName, date },
        ),
        chips,
      )}
      {shown.length ? (
        <div className="grid">
          {shown.map((t) => (
            <FocusCard
              key={t.id}
              task={t}
              project={project(t.projectId)!}
              showProject={all && projects.length > 1}
              props={props}
            />
          ))}
        </div>
      ) : (
        <div className="empty">
          {props.query || quick ? (
            tr(
              'No tasks match. Clear the search or the filter to see the full focus list.',
            )
          ) : projectTasks.length ? (
            tr(
              'Nothing needs attention right now. Tasks appear here when they are pinned, urgent, overdue, due soon, late to start, with your next action due, or past their next step.',
            )
          ) : (
            <>
              <p style={{ margin: '0 0 12px' }}>{tr('No tasks yet.')}</p>
              {!all && (
                <button className="btn primary" onClick={onNewTask}>
                  <Icon name="plus" />
                  {tr('New task')}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

/** Columns for each status. Cancelled is hidden unless the owner shows it. */
export function BoardView({
  projectId,
  props,
}: {
  projectId: string;
  props: ViewProps;
}) {
  const { tasks, project, putTask, toast, attempt } = useApp();
  const p = project(projectId)!;
  const label = useTaskLabel();
  const [showHidden, setShowHidden] = useState(false);
  const [managing, setManaging] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const list = tasks.filter((t) => t.projectId === projectId && props.match(t));
  const columns = boardSlots(p.board, showHidden);
  const inHidden = list.filter(
    (t) => p.board.hidden.includes(t.status) && slotOf(t, p.board) === t.status,
  ).length;

  // Puts a task in a column: the column's status, and its own column if it is one.
  // Always asks the main process, never a copy kept by the screen, so an Undo
  // made later restores the saved task too (an unchanged status is a no-op there).
  const place = async (id: string, status: Status, column: string | null) => {
    await window.worksync.updateTask(id, { status });
    return window.worksync.setBoardColumn(id, column);
  };
  const move = async (id: string, slot: BoardSlot) => {
    const t = tasks.find((x) => x.id === id);
    if (!t || slotOf(t, p.board) === slot.key) return;
    const column = slot.kind === 'own' ? slot.id : null;
    putTask({ ...t, status: slot.status, boardColumn: column });
    const u = await attempt(() => place(id, slot.status, column));
    if (!u) return putTask(t);
    putTask(u);
    toast(`${label(t)} moved to ${slot.name}.`, {
      label: 'Undo',
      run: () =>
        void attempt(async () =>
          putTask(await place(id, t.status, t.boardColumn)),
        ),
    });
  };

  const sorted = (slot: BoardSlot) => {
    const col = list.filter((t) => slotOf(t, p.board) === slot.key);
    return slot.status === 'Done' || slot.status === 'Cancelled'
      ? col.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      : col.sort(byPriority);
  };

  return (
    <>
      {props.header(
        tr('Board'),
        tr(
          '{name} · drag a card to change its status, right-click it to change its priority',
          { name: p.name },
        ),
        <div style={{ display: 'flex', gap: 8 }}>
          {(p.board.hidden.length > 0 || showHidden) && (
            <button
              className="btn sm"
              aria-pressed={showHidden}
              onClick={() => setShowHidden(!showHidden)}
              title={tr('Hidden: {list}', {
                list: p.board.hidden.map((h) => tr(h)).join(', '),
              })}
            >
              {showHidden
                ? tr('Hide hidden columns')
                : `${tr('Show hidden')}${inHidden ? ` (${inHidden})` : ''}`}
            </button>
          )}
          <button className="btn sm" onClick={() => setManaging(true)}>
            <Icon name="sliders" />
            {tr('Columns')}
          </button>
        </div>,
      )}
      {managing && (
        <BoardColumnsDialog project={p} onClose={() => setManaging(false)} />
      )}
      <div className="hscroll">
        <div className="board" style={{ minWidth: columns.length * 192 }}>
          {columns.map((slot) => {
            const col = sorted(slot);
            const hidden =
              slot.kind === 'status' && p.board.hidden.includes(slot.status);
            return (
              <section
                key={slot.key}
                className={`col ${over === slot.key ? 'drop' : ''} ${slot.kind === 'own' ? 'own' : ''} ${hidden ? 'hidden-col' : ''}`}
                aria-label={slot.name}
                onDragOver={(e: DragEvent) => {
                  e.preventDefault();
                  setOver(slot.key);
                }}
                onDragLeave={() => setOver((o) => (o === slot.key ? null : o))}
                onDrop={(e: DragEvent) => {
                  e.preventDefault();
                  setOver(null);
                  setDragging(null);
                  const id = e.dataTransfer.getData('text/plain');
                  if (id) void move(id, slot);
                }}
              >
                <div className="col-h">
                  {slot.kind === 'own' ? (
                    <span
                      className="own-h"
                      title={tr('Status: {status}', {
                        status: tr(slot.status),
                      })}
                    >
                      <b>{slot.name}</b>
                      <StatusChip status={slot.status} />
                    </span>
                  ) : (
                    <StatusChip status={slot.status} />
                  )}
                  <span className="count">{col.length}</span>
                </div>
                {col.map((t) => (
                  <article
                    key={t.id}
                    className={`card ${priorityClass(t)} ${dragging === t.id ? 'dragging' : ''}`}
                    draggable
                    tabIndex={0}
                    role="button"
                    aria-label={tr('Open {task}, {title}', {
                      task: label(t),
                      title: t.titleTranslation || t.titleOriginal,
                    })}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', t.id);
                      setDragging(t.id);
                    }}
                    onDragEnd={() => setDragging(null)}
                    onClick={() => props.openTask(t.id)}
                    onKeyDown={keyOpen(t.id, props.openTask)}
                    onContextMenu={contextMenu(t, props.openMenu)}
                    onMouseMove={spotlight}
                  >
                    <div className="tc-top">
                      <TaskNumber task={t} />
                      <span className="sp" />
                      {t.pinned && (
                        <span className="pin">
                          <Icon name="pin" />
                        </span>
                      )}
                      <PriorityTag task={t} />
                    </div>
                    <Labels labels={t.labels} />
                    <Titles task={t} />
                    <div className="card-foot">
                      <span
                        style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}
                      >
                        {!isClosed(t) && (
                          <DeadlineChip task={t} dueSoonDays={p.dueSoonDays} />
                        )}
                        {t.difficulties.some((d) => d.open) && (
                          <span className="chip">
                            <Icon name="alert" />
                            {t.difficulties.filter((d) => d.open).length}
                          </span>
                        )}
                      </span>
                      <span
                        className="avatar"
                        title={
                          t.situation.handledBy ||
                          t.assignee ||
                          tr('Nobody yet')
                        }
                      >
                        {initials(t.situation.handledBy || t.assignee || '–')}
                      </span>
                    </div>
                  </article>
                ))}
              </section>
            );
          })}
        </div>
      </div>
    </>
  );
}

/**
 * The Board's columns: show or hide each status, and add, rename or delete
 * your own columns. An own column sits under one status, so a card moved
 * there takes that status; deleting it puts its cards back in that status.
 */
function BoardColumnsDialog({
  project: p,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const { attempt, putProject, tasks, toast } = useApp();
  const [b, setB] = useState<BoardSettings>(p.board);
  const [name, setName] = useState('');
  const [under, setUnder] = useState<Status>('In progress');
  // Two columns with one name could not be told apart.
  const clash = [...STATUSES, ...b.columns.map((c) => c.name)].find(
    (x) => x.toLowerCase() === name.trim().toLowerCase(),
  );
  const count = (c: BoardColumn) =>
    tasks.filter(
      (t) =>
        t.projectId === p.id && t.boardColumn === c.id && t.status === c.status,
    ).length;
  // Shown only once saved, so a refused change never stays on screen.
  const save = async (next: BoardSettings) => {
    const u = await attempt(() => window.worksync.setBoard(p.id, next));
    if (!u) return false;
    setB(u.board);
    putProject(u);
    return true;
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    void save({
      ...b,
      columns: [
        ...b.columns,
        { id: Math.random().toString(36).slice(2, 10), name: n, status: under },
      ],
    }).then((ok) => {
      if (!ok) return;
      setName('');
      toast(`Added the column ${n}, under ${under}.`);
    });
  };
  return (
    <Modal
      title={tr('Board columns')}
      subtitle={`${p.name} · each project keeps its own`}
      onClose={onClose}
      narrow
      footer={
        <button className="btn primary" onClick={onClose}>
          {tr('Done')}
        </button>
      }
    >
      <div className="form">
        <fieldset>
          <legend>{tr('Status columns')}</legend>
          {STATUSES.map((s) => {
            const n = tasks.filter(
              (t) => t.projectId === p.id && t.status === s,
            ).length;
            const shown = !b.hidden.includes(s);
            return (
              <div key={s} className="bc-row">
                <StatusChip status={s} />
                <span className="muted">
                  {n} task{n === 1 ? '' : 's'}
                </span>
                <button
                  className="switch"
                  role="switch"
                  aria-checked={shown}
                  aria-label={tr('Show {name}', { name: tr(s) })}
                  onClick={() =>
                    void save({
                      ...b,
                      hidden: shown
                        ? [...b.hidden, s]
                        : b.hidden.filter((x) => x !== s),
                    })
                  }
                >
                  <span />
                </button>
              </div>
            );
          })}
          <span className="hint-text">
            {tr(
              'Hiding a column only hides it on the Board; its tasks keep their status. Show hidden on the Board shows them again for a moment.',
            )}
          </span>
        </fieldset>
        <fieldset>
          <legend>{tr('Your own columns')}</legend>
          {b.columns.map((c) => (
            <div key={c.id} className="bc-row">
              <input
                className="inp sm"
                defaultValue={c.name}
                aria-label={tr('Name of {name}', { name: c.name })}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  // The same rule as adding: no status name, no other column's name.
                  const taken = [
                    ...STATUSES,
                    ...b.columns
                      .filter((x) => x.id !== c.id)
                      .map((x) => x.name),
                  ].find((x) => x.toLowerCase() === v.toLowerCase());
                  if (taken) {
                    toast(
                      tr(
                        'There is already a column called {name}. Choose another name.',
                        { name: taken },
                      ),
                    );
                    e.target.value = c.name;
                    return;
                  }
                  if (!v) {
                    e.target.value = c.name;
                    return;
                  }
                  if (v !== c.name)
                    void save({
                      ...b,
                      columns: b.columns.map((x) =>
                        x.id === c.id ? { ...x, name: v } : x,
                      ),
                    });
                }}
              />
              <span className="muted">
                {tr('under {status}', { status: tr(c.status) })} · {count(c)}
              </span>
              <button
                className="icon-btn"
                aria-label={tr('Delete the column {name}', { name: c.name })}
                onClick={async () => {
                  if (
                    !(await confirmDelete({
                      title: tr('Delete the column “{name}”?', {
                        name: c.name,
                      }),
                      text: tr('Its tasks go back to {status}.', {
                        status: tr(c.status),
                      }),
                      yes: tr('Delete'),
                    }))
                  )
                    return;
                  void save({
                    ...b,
                    columns: b.columns.filter((x) => x.id !== c.id),
                  }).then(
                    (ok) =>
                      ok &&
                      toast(
                        tr('Deleted {name}. Its tasks are back in {status}.', {
                          name: c.name,
                          status: tr(c.status),
                        }),
                      ),
                  );
                }}
              >
                <Icon name="trash" />
              </button>
            </div>
          ))}
          <form className="bc-add" onSubmit={add}>
            <input
              className="inp sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={tr('Name, such as Waiting for test')}
              aria-label={tr('New column name')}
            />
            <select
              className="inp sm"
              value={under}
              onChange={(e) => setUnder(e.target.value as Status)}
              aria-label={tr('Status of the new column')}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  under {s}
                </option>
              ))}
            </select>
            <button
              className="btn sm"
              type="submit"
              disabled={!name.trim() || !!clash}
            >
              <Icon name="plus" />
              {tr('Add')}
            </button>
          </form>
          {clash && (
            <span className="warn-text" role="alert">
              {tr('There is already a column called')} {clash}. Choose another
              name.
            </span>
          )}
          <span className="hint-text">
            {tr(
              'A card moved to your column takes its status, so the file and reports see that status. If the status changes elsewhere, the card goes back to the status column.',
            )}
          </span>
        </fieldset>
      </div>
    </Modal>
  );
}
