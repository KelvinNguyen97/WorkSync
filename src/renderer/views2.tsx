import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import {
  LEVELS,
  LEVEL_NAME,
  STATUSES,
  addDays,
  byPriority,
  daysBetween,
  fileDate,
  flags,
  isClosed,
  monthName,
  shortDate,
  shownPriority,
  type ImportSummary,
  type Task,
} from '../shared/model';
import { useApp } from './appState';
import { Icon } from './Icon';
import { PriorityTag } from './parts';
import type { ViewProps } from './views';
import { tr } from './i18n';

const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
/** The Monday on or before a date. */
const monday = (iso: string) => addDays(iso, -((dow(iso) + 6) % 7));
const title = (t: Task, originalFirst: boolean) =>
  originalFirst || !t.titleTranslation ? t.titleOriginal : t.titleTranslation;

type Zoom = 'days' | 'weeks' | 'months';
const DAY_WIDTH: Record<Zoom, number> = { days: 34, weeks: 20, months: 6 };

/**
 * A Gantt chart (spec 03, Timeline): one row per task, the planned bar with a
 * thin actual bar under it, a line for today, and a striped end on bars that
 * run past today while the task is open.
 */
/** Whether a task's No. shows, per its project's setting. */
function useShowNo() {
  const { project } = useApp();
  return (t: Task) => project(t.projectId)?.showNumbers !== false;
}

export function TimelineView({
  projectId,
  props,
}: {
  projectId: string;
  props: ViewProps;
}) {
  const { tasks, today, project, originalFirst } = useApp();
  const p = project(projectId)!;
  const showNo = useShowNo();
  const [zoom, setZoom] = useState<Zoom>('weeks');
  const list = tasks.filter(
    (t) =>
      t.projectId === projectId && t.fileState !== 'removed' && props.match(t),
  );
  const dated = list
    .filter((t) => t.plannedStart || t.plannedEnd)
    .sort(
      (a, b) =>
        (a.plannedStart ?? a.plannedEnd!).localeCompare(
          b.plannedStart ?? b.plannedEnd!,
        ) || byPriority(a, b),
    );
  const undated = list
    .filter((t) => !t.plannedStart && !t.plannedEnd)
    .sort(byPriority);

  // From the Monday before the first date to a few weeks after the last, always including today.
  const all = dated
    .flatMap((t) => [t.plannedStart, t.plannedEnd, t.actualStart, t.actualEnd])
    .filter((d): d is string => !!d);
  const first = monday([today, ...all].sort()[0]);
  const lastDate = [addDays(today, 14), ...all].sort().at(-1)!;
  const days = Math.min(Math.max(daysBetween(first, lastDate) + 8, 42), 730);
  const dw = DAY_WIDTH[zoom];
  const lw = 290;
  const x = (d: string) => daysBetween(first, d) * dw;
  const todayX = (daysBetween(first, today) + 0.5) * dw;

  const head = [];
  const bg = [];
  if (zoom === 'months') {
    for (let d = first; daysBetween(first, d) < days;) {
      const [y, m] = d.split('-').map(Number);
      const next =
        m === 12
          ? `${y + 1}-01-01`
          : `${y}-${String(m + 1).padStart(2, '0')}-01`;
      const w =
        Math.min(daysBetween(d, next), days - daysBetween(first, d)) * dw;
      head.push(
        <span key={d} style={{ left: x(d), width: w }}>
          {monthName(m)} {y}
        </span>,
      );
      bg.push(<i key={d} className="wk" style={{ left: x(d) }} />);
      d = next;
    }
  } else {
    for (let w = 0; w * 7 < days; w++) {
      const d = addDays(first, w * 7);
      head.push(
        <span key={d} style={{ left: w * 7 * dw, width: 7 * dw }}>
          {zoom === 'days' ? tr('Week of ') : ''}
          {shortDate(d)}
        </span>,
      );
      bg.push(<i key={d} className="wk" style={{ left: w * 7 * dw }} />);
    }
  }
  const dayCells = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(first, i);
    if (zoom !== 'months')
      dayCells.push(
        <span
          key={d}
          className={d === today ? 'today' : ''}
          style={{ left: i * dw, width: dw }}
        >
          {Number(d.slice(8))}
        </span>,
      );
    if (zoom !== 'months' && (dow(d) === 0 || dow(d) === 6))
      bg.push(
        <i key={`we${d}`} className="we" style={{ left: i * dw, width: dw }} />,
      );
  }

  const zoomCtl = (
    <div className="seg-ctl" role="group" aria-label={tr('Zoom')}>
      {(['days', 'weeks', 'months'] as const).map((z) => (
        <button key={z} aria-pressed={zoom === z} onClick={() => setZoom(z)}>
          {tr(z[0].toUpperCase() + z.slice(1))}
        </button>
      ))}
    </div>
  );

  return (
    <>
      {props.header(
        tr('Timeline'),
        tr('{name} · planned and actual dates · {from} to {to}', {
          name: p.name,
          from: shortDate(first),
          to: shortDate(addDays(first, days - 1)),
        }),
        zoomCtl,
      )}
      {dated.length ? (
        <div className="tl-wrap">
          <div
            className="tl"
            style={{
              ['--lw' as string]: `${lw}px`,
              ['--tw' as string]: `${days * dw}px`,
              width: lw + days * dw,
            }}
          >
            <div className="tl-head">
              <div className="tl-row">
                <div className="tl-label">{tr('Task')}</div>
                <div className="tl-weeks">{head}</div>
              </div>
              {zoom !== 'months' && (
                <div className="tl-row">
                  <div className="tl-label" />
                  <div className="tl-days">{dayCells}</div>
                </div>
              )}
            </div>
            <div className="tl-body" style={{ position: 'relative' }}>
              <div className="tl-bg" style={{ left: lw, width: days * dw }}>
                {bg}
                <div className="today-line" style={{ left: todayX }} />
              </div>
              {dated.map((t) => {
                const s = t.plannedStart ?? t.plannedEnd!;
                const e = t.plannedEnd ?? t.plannedStart!;
                const bx = x(s);
                const bw = Math.max(daysBetween(s, e) + 1, 1) * dw;
                const over = !isClosed(t) && daysBetween(today, e) < 0;
                const ow = over ? daysBetween(e, today) * dw : 0;
                const act = t.actualStart
                  ? {
                      x: x(t.actualStart),
                      w:
                        (daysBetween(t.actualStart, t.actualEnd ?? today) + 1) *
                        dw,
                    }
                  : null;
                const level = shownPriority(t);
                const tip = `No. ${t.customerId} ${title(t, false)} · ${tr(LEVEL_NAME[level])}${t.priorityOverride ? ' (your override)' : ''} · ${t.status} · Planned ${fileDate(t.plannedStart) || '…'} to ${fileDate(t.plannedEnd) || '…'}${t.actualStart ? ` · Actual from ${fileDate(t.actualStart)}${t.actualEnd ? ` to ${fileDate(t.actualEnd)}` : ''}` : ''}`;
                return (
                  <div className="tl-row" key={t.id}>
                    <button
                      className={`tl-label pri-${level}`}
                      onClick={() => props.openTask(t.id)}
                      title={tip}
                    >
                      <span className="stripe" />
                      {showNo(t) && <span className="tid">{t.customerId}</span>}
                      {t.priorityOverride && (
                        <span
                          className="ovr-i"
                          title={tr('Your priority override')}
                        >
                          <Icon name="user" />
                        </span>
                      )}
                      <span
                        className="t"
                        lang={
                          originalFirst || !t.titleTranslation
                            ? t.language
                            : undefined
                        }
                      >
                        {title(t, originalFirst)}
                      </span>
                    </button>
                    <div className="track">
                      <button
                        className={`bar pri-${level} ${isClosed(t) ? 'done' : ''}`}
                        style={{ left: bx, width: bw }}
                        title={tip}
                        aria-label={tip}
                        onClick={() => props.openTask(t.id)}
                        onContextMenu={(ev: MouseEvent<HTMLElement>) => {
                          ev.preventDefault();
                          props.openMenu(t, ev.currentTarget, {
                            x: ev.clientX,
                            y: ev.clientY,
                          });
                        }}
                      />
                      {over && (
                        <>
                          <div
                            className="overrun"
                            style={{ left: bx + bw, width: ow }}
                          />
                          <span
                            className="overrun-label"
                            style={{ left: bx + bw + ow + 8 }}
                          >
                            {tr('Overdue')}
                          </span>
                        </>
                      )}
                      {act && (
                        <div
                          className="actual"
                          style={{ left: act.x, width: act.w }}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="empty">
          {tr('No tasks with dates')}
          {props.query ? tr(' match the search') : tr(' yet')}. Add planned
          dates to a task to see it here.
        </div>
      )}
      <div className="legend">
        <span>
          <i className="sw u" />
          {tr('Urgent')}
        </span>
        <span>
          <i className="sw h" />
          {tr('High')}
        </span>
        <span>
          <i className="sw" />
          {tr('Normal')}
        </span>
        <span>
          <i className="sw act" />
          {tr('Actual')}
        </span>
        <span>
          <i className="sw over" />
          {tr('Past the planned end')}
        </span>
        <span>
          <i className="sw now" />
          {tr('Today')}
        </span>
      </div>
      {undated.length > 0 && (
        <details className="skipped undated">
          <summary>
            {undated.length} task{undated.length === 1 ? '' : 's'}{' '}
            {tr('without dates')}
          </summary>
          <ul>
            {undated.map((t) => (
              <li key={t.id}>
                <button
                  className="linkbtn"
                  onClick={() => props.openTask(t.id)}
                >
                  {showNo(t) ? `No. ${t.customerId}` : title(t, originalFirst)}
                </button>{' '}
                {showNo(t) && title(t, originalFirst)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

interface CalItem {
  task: Task;
  kind: 'due' | 'next' | 'action';
}

/** Tasks on their planned end date, by month or by week (spec 03, Calendar). */
export function CalendarView({
  projectId,
  props,
}: {
  projectId: string;
  props: ViewProps;
}) {
  const { tasks, today, project, originalFirst } = useApp();
  const p = project(projectId)!;
  const [mode, setMode] = useState<'month' | 'week'>('month');
  const [anchor, setAnchor] = useState(today);
  const [showSteps, setShowSteps] = useState(false);
  const list = tasks.filter(
    (t) =>
      t.projectId === projectId &&
      t.fileState !== 'removed' &&
      !isClosed(t) &&
      props.match(t),
  );

  const byDay = useMemo(() => {
    const m = new Map<string, CalItem[]>();
    const put = (d: string | null, item: CalItem) => {
      if (!d) return;
      m.set(d, [...(m.get(d) ?? []), item]);
    };
    for (const t of list) {
      put(t.plannedEnd, { task: t, kind: 'due' });
      if (showSteps) {
        put(t.situation.nextDate, { task: t, kind: 'next' });
        put(t.nextActionDate, { task: t, kind: 'action' });
      }
    }
    for (const [k, v] of m)
      m.set(
        k,
        v.sort(
          (a, b) =>
            (a.kind === 'due' ? 0 : 1) - (b.kind === 'due' ? 0 : 1) ||
            byPriority(a.task, b.task),
        ),
      );
    return m;
  }, [list, showSteps]);

  const monthStart = `${anchor.slice(0, 8)}01`;
  const start = mode === 'month' ? monday(monthStart) : monday(anchor);
  const count = mode === 'month' ? 42 : 7;
  const month = Number(anchor.slice(5, 7));
  const shift = (n: number) => {
    if (mode === 'week') return setAnchor(addDays(anchor, n * 7));
    const [y, m] = anchor.split('-').map(Number);
    const nm = m + n;
    const yy = y + Math.floor((nm - 1) / 12);
    const mm = ((((nm - 1) % 12) + 12) % 12) + 1;
    setAnchor(`${yy}-${String(mm).padStart(2, '0')}-01`);
  };
  const label =
    mode === 'month'
      ? `${monthName(month)} ${anchor.slice(0, 4)}`
      : `Week of ${shortDate(start)} ${start.slice(0, 4)}`;
  const max = mode === 'month' ? 3 : 50;

  const controls = (
    <div
      style={{
        display: 'flex',
        gap: 8,
        flexWrap: 'wrap',
        alignItems: 'center',
      }}
    >
      <label
        className="check"
        style={{
          fontSize: 12.5,
          color: 'var(--fg-2)',
          display: 'flex',
          gap: 6,
          alignItems: 'center',
        }}
      >
        <input
          type="checkbox"
          checked={showSteps}
          onChange={(e) => setShowSteps(e.target.checked)}
        />{' '}
        {tr('Next steps and actions')}
      </label>
      <div className="seg-ctl" role="group" aria-label={tr('Calendar view')}>
        {(['month', 'week'] as const).map((k) => (
          <button key={k} aria-pressed={mode === k} onClick={() => setMode(k)}>
            {k === 'month' ? tr('Month') : tr('Week')}
          </button>
        ))}
      </div>
      <div className="seg-ctl" role="group" aria-label={tr('Move')}>
        <button
          onClick={() => shift(-1)}
          aria-label={tr(mode === 'month' ? 'Previous month' : 'Previous week')}
        >
          ‹
        </button>
        <button onClick={() => setAnchor(today)}>{tr('Today')}</button>
        <button
          onClick={() => shift(1)}
          aria-label={tr(mode === 'month' ? 'Next month' : 'Next week')}
        >
          ›
        </button>
      </div>
    </div>
  );

  const ICON = { due: null, next: 'ball', action: 'check' } as const;
  return (
    <>
      {props.header(
        tr('Calendar'),
        tr('{name} · tasks on their due date · {label}', {
          name: p.name,
          label,
        }),
        controls,
      )}
      <div className="cal-wrap">
        <div className={`cal ${mode === 'week' ? 'week' : ''}`}>
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
            <div key={d} className="cal-dow">
              {tr(d)}
            </div>
          ))}
          {Array.from({ length: count }, (_, i) => {
            const d = addDays(start, i);
            const items = byDay.get(d) ?? [];
            const cls = [
              mode === 'month' && Number(d.slice(5, 7)) !== month && 'out',
              (dow(d) === 0 || dow(d) === 6) && 'we',
              d === today && 'today',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <div key={d} className={`cal-day ${cls}`}>
                <span className="dn">
                  {d.endsWith('-01')
                    ? `${monthName(Number(d.slice(5, 7)))} `
                    : ''}
                  {Number(d.slice(8))}
                </span>
                {items.slice(0, max).map((it) => {
                  const icon = ICON[it.kind];
                  const what =
                    it.kind === 'due'
                      ? tr('Due')
                      : it.kind === 'next'
                        ? tr('Next step: {text}', {
                            text: it.task.situation.nextStep,
                          })
                        : tr('Your action: {text}', {
                            text: it.task.nextAction,
                          });
                  return (
                    <button
                      key={`${it.task.id}${it.kind}`}
                      className={`cal-pill pri-${shownPriority(it.task)} ${it.kind}`}
                      title={`${what} · No. ${it.task.customerId} ${title(it.task, false)}${it.task.priorityOverride ? ` · ${tr('your priority override')}` : ''}`}
                      onClick={() => props.openTask(it.task.id)}
                      onContextMenu={(ev: MouseEvent<HTMLElement>) => {
                        ev.preventDefault();
                        props.openMenu(it.task, ev.currentTarget, {
                          x: ev.clientX,
                          y: ev.clientY,
                        });
                      }}
                    >
                      {icon && <Icon name={icon} />}
                      <b>{it.task.customerId}</b>
                      {title(it.task, originalFirst)}
                    </button>
                  );
                })}
                {items.length > max && (
                  <button
                    className="cal-more linkbtn"
                    onClick={() => {
                      setAnchor(d);
                      setMode('week');
                    }}
                  >
                    +{items.length - max} more
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {showSteps && (
        <div className="legend">
          <span>
            <Icon name="ball" />
            {tr('Next step date')}
          </span>
          <span>
            <Icon name="check" />
            {tr('Your next action')}
          </span>
        </div>
      )}
    </>
  );
}

const STATUS_COLOR: Record<string, string> = {
  'Not started': '#4b5466',
  'In progress': '#6f8fff',
  'In review': '#a483ff',
  'On hold': '#8a93a3',
  Done: '#3fb67d',
  Cancelled: '#3a414d',
};
const LEVEL_COLOR = {
  U: 'var(--urgent)',
  H: 'var(--high)',
  N: '#7c879a',
  L: 'var(--low)',
};

/** Counts, priorities, what waits on the customer and the last import (spec 03, Dashboard). */
export function DashboardView({
  projectId,
  props,
}: {
  projectId: string;
  props: ViewProps;
}) {
  const { tasks, today, project, sources } = useApp();
  const p = project(projectId)!;
  const showNo = useShowNo();
  const [asTable, setAsTable] = useState(false);
  const [lastImport, setLastImport] = useState<ImportSummary | null>(null);
  useEffect(() => {
    void window.worksync.lastImport(projectId).then(setLastImport);
  }, [projectId, sources]);

  const all = tasks.filter(
    (t) =>
      t.projectId === projectId && t.fileState !== 'removed' && props.match(t),
  );
  const open = all.filter((t) => !isClosed(t));
  const f = (t: Task) => flags(t, today, p.dueSoonDays);
  const overdue = open.filter((t) => f(t).overdue);
  // The same rule and number of days as Focus's Due soon (the project setting).
  const thisWeek = open.filter((t) => f(t).dueSoon);
  const days = p.dueSoonDays;
  const withDiff = open.filter((t) => f(t).openDifficulties > 0);
  const diffCount = open.reduce((n, t) => n + f(t).openDifficulties, 0);
  const total = all.length || 1;
  const statusCounts = STATUSES.map((s) => ({
    s,
    n: all.filter((t) => t.status === s).length,
  })).filter((x) => x.n);
  const levelCounts = LEVELS.map((k) => ({
    k,
    n: open.filter((t) => shownPriority(t) === k).length,
  }));
  const maxLevel = Math.max(1, ...levelCounts.map((x) => x.n));

  const tile = (
    label: string,
    value: number,
    note: string,
    icon: 'focus' | 'clock' | 'alert' | 'ball',
  ) => (
    <div className="tile">
      <span className="lab">
        <Icon name={icon} />
        {tr(label)}
      </span>
      <span className="val">{value}</span>
      <span className="note">{note}</span>
    </div>
  );

  const miniList = (list: Task[], empty: string) =>
    list.length ? (
      <div className="wlist">
        {list.slice(0, 8).map((t) => (
          <div
            key={t.id}
            className={`witem pri-${shownPriority(t)}`}
            tabIndex={0}
            role="button"
            onClick={() => props.openTask(t.id)}
            onKeyDown={(e) =>
              (e.key === 'Enter' || e.key === ' ') &&
              (e.preventDefault(), props.openTask(t.id))
            }
          >
            <div className="tc-top">
              {showNo(t) && (
                <span className="tid">
                  {tr('No.')} {t.customerId}
                </span>
              )}
              <span className="sp" />
              <PriorityTag task={t} />
            </div>
            <div className="title">{t.titleTranslation || t.titleOriginal}</div>
            <div className="nx">
              {t.situation.nextStep || tr('No next step yet')}
              {t.situation.nextDate
                ? ` · ${tr('by {date}', { date: shortDate(t.situation.nextDate) })}`
                : ''}
              {t.plannedEnd
                ? ` · ${tr('due {date}', { date: shortDate(t.plannedEnd) })}`
                : ''}
            </div>
          </div>
        ))}
        {list.length > 8 && (
          <div className="hint">
            {tr('and {n} more', { n: list.length - 8 })}
          </div>
        )}
      </div>
    ) : (
      <div className="hint">{empty}</div>
    );

  return (
    <>
      {props.header(
        tr('Dashboard'),
        `${p.name}${p.customer ? ` · ${p.customer}` : ''} · ${tr('as of {date}', { date: `${shortDate(today)} ${today.slice(0, 4)}` })}`,
      )}
      <div className="tiles">
        {tile(
          'Open tasks',
          open.length,
          tr('{n} done or cancelled', { n: all.length - open.length }),
          'focus',
        )}
        {tile('Overdue', overdue.length, tr('past the planned end'), 'clock')}
        {tile(
          'Due soon',
          thisWeek.length,
          tr(days === 1 ? 'within {n} day' : 'within {n} days', { n: days }),
          'clock',
        )}
        {tile(
          'Open difficulties',
          diffCount,
          tr(withDiff.length === 1 ? 'on {n} task' : 'on {n} tasks', {
            n: withDiff.length,
          }),
          'alert',
        )}
      </div>
      <div className="panels">
        <section className="panel">
          <div className="panel-h">
            <h2>{tr('Tasks by status')}</h2>
            <button
              className="btn sm"
              aria-pressed={asTable}
              onClick={() => setAsTable(!asTable)}
            >
              {asTable ? tr('Hide table') : tr('View as table')}
            </button>
          </div>
          {all.length ? (
            <>
              <div
                className="segbar"
                role="img"
                aria-label={statusCounts
                  .map((x) => `${tr(x.s)} ${x.n}`)
                  .join(', ')}
              >
                {statusCounts.map((x) => {
                  const pct = (x.n / total) * 100;
                  return (
                    <div
                      key={x.s}
                      title={tr('{status}: {n} of {all} · {pct}%', {
                        status: tr(x.s),
                        n: x.n,
                        all: all.length,
                        pct: Math.round(pct),
                      })}
                      style={{
                        flex: `${x.n} 1 0`,
                        background: STATUS_COLOR[x.s],
                        color: x.s === 'On hold' ? '#0b0f15' : '#fff',
                      }}
                    >
                      {pct >= 11 ? `${Math.round(pct)}%` : ''}
                    </div>
                  );
                })}
              </div>
              <div className="seg-legend">
                {statusCounts.map((x) => (
                  <span key={x.s}>
                    <i style={{ background: STATUS_COLOR[x.s] }} />
                    {tr(x.s)} {x.n}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <div className="hint">{tr('No tasks yet.')}</div>
          )}
          {asTable && (
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{tr('Status')}</th>
                    <th className="num">{tr('Tasks')}</th>
                    <th className="num">{tr('Share')}</th>
                  </tr>
                </thead>
                <tbody>
                  {statusCounts.map((x) => (
                    <tr key={x.s}>
                      <td>{tr(x.s)}</td>
                      <td className="num">{x.n}</td>
                      <td className="num">
                        {Math.round((x.n / total) * 100)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="panel-h" style={{ marginTop: 22 }}>
            <h2>{tr('Open tasks by priority')}</h2>
          </div>
          <div className="pbars">
            {levelCounts.map((x) => (
              <div className="pbar" key={x.k}>
                <span>{tr(LEVEL_NAME[x.k])}</span>
                <span className="trk">
                  <i
                    style={{
                      width: `${(x.n / maxLevel) * 78}%`,
                      background: LEVEL_COLOR[x.k],
                    }}
                    title={tr(x.n === 1 ? '{n} open task' : '{n} open tasks', {
                      n: x.n,
                    })}
                  />
                  <b>{x.n}</b>
                </span>
              </div>
            ))}
          </div>
          <div className="panel-h" style={{ marginTop: 24 }}>
            <h2>{tr('Last import')}</h2>
            {lastImport && (
              <span className="hint">
                {new Date(lastImport.at).toLocaleString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            )}
          </div>
          {lastImport ? (
            <div className="import-chips">
              <span className="chip">{lastImport.added} new</span>
              <span className="chip">{lastImport.changed} changed</span>
              <span className="chip">{lastImport.removed} removed</span>
            </div>
          ) : (
            <div className="hint">
              {tr('No linked file has been imported yet.')}
            </div>
          )}
        </section>
        <section className="panel">
          <div className="panel-h">
            <h2>{tr('Overdue')}</h2>
          </div>
          {miniList(overdue.sort(byPriority), tr('Nothing is overdue.'))}
          <div className="panel-h" style={{ marginTop: 22 }}>
            <h2>{tr('Due soon')}</h2>
          </div>
          {miniList(
            thisWeek.sort(byPriority),
            tr(
              days === 1
                ? 'Nothing is due in the next {n} day.'
                : 'Nothing is due in the next {n} days.',
              { n: days },
            ),
          )}
          <div className="panel-h" style={{ marginTop: 22 }}>
            <h2>{tr('Open difficulties')}</h2>
          </div>
          {miniList(withDiff.sort(byPriority), tr('No open difficulties.'))}
        </section>
      </div>
    </>
  );
}
