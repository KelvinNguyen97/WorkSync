import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import {
  LEVEL_NAME,
  STATUSES,
  brief,
  shownPriority,
  type BulkChange,
  type Status,
  type TableSettings,
  type Task,
} from '../shared/model';
import {
  DEFAULT_TABLE,
  TABLE_COLUMNS,
  columnByKey,
  rangeIds,
  tableRows,
  tableSettings,
  type TableColumn,
} from '../shared/taskTable';
import { useApp } from './appState';
import { Icon } from './Icon';
import { StatusChip } from './parts';
import type { ViewProps } from './views';
import { tr } from './i18n';

const ROW = 40;
const OVERSCAN = 12;
const CHECK = 40;

/**
 * The Tasks table (spec 03): every task in the project, with the columns,
 * sort and filters the owner chooses, remembered per project. Several rows can
 * be selected for one action. Only the rows in sight are drawn, so thousands
 * of tasks stay quick.
 */
export function TasksView({
  projectId,
  props,
  onCopyForAi,
  onReport,
}: {
  projectId: string;
  props: ViewProps;
  onCopyForAi: (ids: string[]) => void;
  onReport: (ids: string[]) => void;
}) {
  const { tasks, project, putProject, attempt, people } = useApp();
  const p = project(projectId)!;
  const [settings, setSettingsState] = useState<TableSettings>(() =>
    tableSettings(p.tableSettings),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [chooser, setChooser] = useState(false);

  // Settings follow the project, and are saved a moment after the last change.
  const saveTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    setSettingsState(tableSettings(project(projectId)?.tableSettings ?? null));
    setSelected(new Set());
    anchor.current = null;
    // Only when the project changes, not on every save of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  const setSettings = (next: TableSettings) => {
    setSettingsState(next);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void attempt(() =>
        window.worksync.setTableSettings(projectId, next),
      ).then((u) => u && putProject(u));
    }, 400);
  };
  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  const all = useMemo(
    () => tasks.filter((t) => t.projectId === projectId && props.passes(t)),
    // props.passes changes with the top bar filter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, projectId, props.passes],
  );
  const rows = useMemo(
    () => tableRows(all, settings, props.query, { people }),
    [all, settings, props.query, people],
  );
  const shownIds = useMemo(() => rows.map((t) => t.id), [rows]);
  // Actions apply to the selected rows that the filters still show.
  const chosen = useMemo(
    () => rows.filter((t) => selected.has(t.id)),
    [rows, selected],
  );
  // The project may hide task numbers; the No. column goes with them.
  const columns = settings.columns
    .filter((k) => k !== 'id' || p.showNumbers)
    .map(columnByKey)
    .filter((c): c is TableColumn => !!c);
  const template = [
    `${CHECK}px`,
    ...columns.map((c) => (c.width ? `${c.width}px` : 'minmax(220px, 1fr)')),
  ].join(' ');
  const minWidth =
    CHECK + columns.reduce((n, c) => n + (c.width || 220), 0) + 4;

  const filtered = Object.values(settings.filters).some((v) => v.trim());
  const sortBy = (key: string) =>
    setSettings({
      ...settings,
      sort: {
        key,
        dir:
          settings.sort.key === key && settings.sort.dir === 'asc'
            ? 'desc'
            : 'asc',
      },
    });
  const setFilter = (key: string, value: string) =>
    setSettings({
      ...settings,
      filters: { ...settings.filters, [key]: value },
    });

  const toggle = (id: string, shift: boolean) => {
    const next = new Set(selected);
    if (shift && anchor.current) {
      const on = !selected.has(id) || selected.has(anchor.current);
      for (const x of rangeIds(shownIds, anchor.current, id))
        if (on) next.add(x);
        else next.delete(x);
    } else if (next.has(id)) next.delete(id);
    else next.add(id);
    anchor.current = id;
    setSelected(next);
  };
  const allShownSelected = rows.length > 0 && chosen.length === rows.length;
  const selectAll = () =>
    setSelected(allShownSelected ? new Set() : new Set(shownIds));

  // ---------------------------------------------------- virtual rows
  const bodyRef = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState({ top: 0, height: 900 });
  const measure = useCallback(() => {
    const body = bodyRef.current;
    const scroller = body?.closest('.view') as HTMLElement | null;
    if (!body || !scroller) return;
    const offset =
      body.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    setWin({
      top: scroller.scrollTop - offset,
      height: scroller.clientHeight,
    });
  }, []);
  useLayoutEffect(() => {
    const scroller = bodyRef.current?.closest('.view') as HTMLElement | null;
    if (!scroller) return;
    measure();
    scroller.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', measure);
      ro.disconnect();
    };
  }, [measure]);
  const first = Math.max(0, Math.floor(win.top / ROW) - OVERSCAN);
  const last = Math.min(
    rows.length,
    Math.ceil((win.top + win.height) / ROW) + OVERSCAN,
  );
  const visible = rows.slice(first, last);

  // Arrow keys move between rows; the scroller follows the focused row.
  const focusRow = (index: number) => {
    const i = Math.max(0, Math.min(rows.length - 1, index));
    const body = bodyRef.current;
    const scroller = body?.closest('.view') as HTMLElement | null;
    if (!body || !scroller) return;
    const offset =
      body.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    const y = offset + i * ROW;
    const headH = 2 * ROW + 8;
    if (y < scroller.scrollTop + headH)
      scroller.scrollTop = Math.max(0, y - headH);
    else if (y + ROW > scroller.scrollTop + scroller.clientHeight - 64)
      scroller.scrollTop = y + ROW - scroller.clientHeight + 64;
    requestAnimationFrame(() =>
      body
        .querySelector<HTMLElement>(`[data-row="${i}"]`)
        ?.focus({ preventScroll: true }),
    );
  };
  const onRowKey = (e: KeyboardEvent<HTMLDivElement>, t: Task, i: number) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') props.openTask(t.id);
    else if (e.key === ' ') {
      e.preventDefault();
      toggle(t.id, e.shiftKey);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusRow(i + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusRow(i - 1);
    }
  };
  const onContext = (t: Task) => (e: MouseEvent<HTMLElement>) => {
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const keyboard = !e.clientX && !e.clientY;
    props.openMenu(
      t,
      e.currentTarget,
      keyboard
        ? { x: r.left + 40, y: r.top + 32 }
        : { x: e.clientX, y: e.clientY },
    );
  };

  const removed = all.filter((t) => t.fileState === 'removed').length;
  return (
    <>
      {props.header(
        tr('Tasks'),
        `${p.name} · ${rows.length === all.length ? tr('{n} tasks', { n: all.length }) : tr('{shown} of {n} tasks shown', { shown: rows.length, n: all.length })}${removed ? ` · ${tr('{n} removed from the file', { n: removed })}` : ''}`,
        <div className="vh-actions">
          {filtered && (
            <button
              className="btn sm"
              onClick={() => setSettings({ ...settings, filters: {} })}
            >
              <Icon name="x" />
              {tr('Clear filters')}
            </button>
          )}
          <div className="tt-pop-wrap">
            <button
              className="btn sm"
              aria-expanded={chooser}
              onClick={() => setChooser(!chooser)}
            >
              <Icon name="sliders" />
              {tr('Columns')}
            </button>
            {chooser && (
              <ColumnChooser
                settings={settings}
                onChange={setSettings}
                onClose={() => setChooser(false)}
              />
            )}
          </div>
        </div>,
      )}
      <div
        className="tt"
        role="grid"
        aria-label={tr('Tasks in {name}', { name: p.name })}
        aria-rowcount={rows.length + 2}
        aria-multiselectable
        style={{ ['--tt-cols' as string]: template, minWidth }}
      >
        <div className="tt-head" role="row" aria-rowindex={1}>
          <span className="tt-check" role="columnheader">
            <input
              type="checkbox"
              aria-label={
                allShownSelected
                  ? tr('Clear the selection')
                  : `Select all ${rows.length} rows shown`
              }
              checked={allShownSelected}
              ref={(el) => {
                if (el)
                  el.indeterminate = chosen.length > 0 && !allShownSelected;
              }}
              onChange={selectAll}
            />
          </span>
          {columns.map((c) => {
            const on = settings.sort.key === c.key;
            return (
              <span
                key={c.key}
                role="columnheader"
                aria-sort={
                  on
                    ? settings.sort.dir === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none'
                }
              >
                <button
                  className={`tt-sort ${on ? 'on' : ''}`}
                  onClick={() => sortBy(c.key)}
                  title={tr('Sort by {name}', { name: tr(c.label) })}
                >
                  {tr(c.label)}
                  <span className={`tt-arrow ${on ? settings.sort.dir : ''}`}>
                    <Icon name="chev" />
                  </span>
                </button>
              </span>
            );
          })}
        </div>
        <div className="tt-filters" role="row" aria-rowindex={2}>
          <span className="tt-check" role="gridcell" />
          {columns.map((c) => (
            <span key={c.key} role="gridcell">
              <FilterInput
                column={c}
                value={settings.filters[c.key] ?? ''}
                onChange={(v) => setFilter(c.key, v)}
              />
            </span>
          ))}
        </div>
        <div
          className="tt-body"
          ref={bodyRef}
          style={{ height: rows.length * ROW }}
        >
          {visible.map((t, n) => {
            const i = first + n;
            const sel = selected.has(t.id);
            return (
              <div
                key={t.id}
                className={`tt-row ${sel ? 'sel' : ''} ${t.fileState === 'removed' ? 'gone' : ''} ${t.status === 'Done' || t.status === 'Cancelled' ? 'closed' : ''}`}
                role="row"
                aria-rowindex={i + 3}
                aria-selected={sel}
                data-row={i}
                tabIndex={0}
                style={{ top: i * ROW }}
                onClick={(e) => {
                  if (e.shiftKey || e.metaKey || e.ctrlKey)
                    toggle(t.id, e.shiftKey);
                  else props.openTask(t.id);
                }}
                onContextMenu={onContext(t)}
                onKeyDown={(e) => onRowKey(e, t, i)}
                title={
                  t.fileState === 'removed'
                    ? tr('This row was removed from the file.')
                    : undefined
                }
              >
                <span
                  className="tt-check"
                  role="gridcell"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(t.id, e.shiftKey);
                  }}
                >
                  <input
                    type="checkbox"
                    tabIndex={-1}
                    aria-label={tr('Select No. {no}', { no: t.customerId })}
                    checked={sel}
                    readOnly
                  />
                </span>
                {columns.map((c) => (
                  <span key={c.key} role="gridcell" className={`c-${c.key}`}>
                    <Cell column={c} task={t} />
                  </span>
                ))}
              </div>
            );
          })}
        </div>
        {!rows.length && (
          <div className="tt-empty">
            {all.length
              ? tr('No task matches the filters.')
              : tr('No tasks in this project yet.')}
          </div>
        )}
      </div>
      {chosen.length > 0 && (
        <BulkBar
          tasks={chosen}
          labels={[...new Set(all.flatMap((t) => t.labels))].sort()}
          onClear={() => setSelected(new Set())}
          onCopyForAi={() => onCopyForAi(chosen.map((t) => t.id))}
          onReport={() => onReport(chosen.map((t) => t.id))}
        />
      )}
    </>
  );
}

function Cell({ column, task: t }: { column: TableColumn; task: Task }) {
  const { people } = useApp();
  switch (column.key) {
    case 'id':
      return (
        <span className="tt-id">
          {t.pinned && <Icon name="pin" />}
          {t.customerId}
        </span>
      );
    case 'title':
      return (
        <span
          className="tt-title"
          lang={t.titleTranslation ? undefined : t.language}
        >
          {t.titleTranslation || t.titleOriginal}
          {t.fileState === 'removed' && (
            <em> {tr('· removed from the file')}</em>
          )}
        </span>
      );
    case 'original':
      return <span lang={t.language}>{t.titleOriginal}</span>;
    case 'status':
      return <StatusChip status={t.status} />;
    case 'priority': {
      const l = shownPriority(t);
      return (
        <span
          className={`tt-pri ${l} ${t.priorityOverride ? 'ovr' : ''}`}
          title={
            t.priorityOverride
              ? `Your priority. The task's own level is ${tr(LEVEL_NAME[t.priority])}.`
              : undefined
          }
        >
          <i />
          {tr(LEVEL_NAME[l])}
          {t.priorityOverride && <Icon name="user" />}
        </span>
      );
    }
    case 'labels':
      return (
        <span className="tt-labels">
          {t.labels.map((l) => (
            <span key={l} className="tt-label">
              {l}
            </span>
          ))}
        </span>
      );
    default:
      return <>{column.text(t, { people })}</>;
  }
}

function FilterInput({
  column: c,
  value,
  onChange,
}: {
  column: TableColumn;
  value: string;
  onChange: (v: string) => void;
}) {
  // Typing updates the box at once and the rows a moment later.
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (c.filter === 'choice')
    return (
      <select
        className={`tt-filter ${value ? 'on' : ''}`}
        aria-label={tr('Filter {name}', { name: tr(c.label) })}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{tr('Any')}</option>
        {c.choices!.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
    );
  return (
    <input
      className={`tt-filter ${value ? 'on' : ''}`}
      aria-label={tr('Filter {name}', { name: tr(c.label) })}
      placeholder={c.filter === 'date' ? 'e.g. 2026/11' : tr('Filter')}
      title={
        c.filter === 'date'
          ? tr(
              'A date or month such as 2026/11, a range such as 2026/11/01-2026/11/15, or none',
            )
          : undefined
      }
      value={draft}
      onChange={(e) => {
        const v = e.target.value;
        setDraft(v);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => onChange(v), 220);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && draft) {
          e.stopPropagation();
          setDraft('');
          onChange('');
        }
      }}
    />
  );
}

function ColumnChooser({
  settings,
  onChange,
  onClose,
}: {
  settings: TableSettings;
  onChange: (s: TableSettings) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);
  const set = (key: string, on: boolean) => {
    const columns = on
      ? TABLE_COLUMNS.map((c) => c.key).filter(
          (k) => k === key || settings.columns.includes(k),
        )
      : settings.columns.filter((k) => k !== key);
    const filters = { ...settings.filters };
    if (!on) delete filters[key];
    onChange({ ...settings, columns, filters });
  };
  return (
    <div className="tt-pop" ref={ref} role="dialog" aria-label={tr('Columns')}>
      <b>{tr('Columns')}</b>
      <div className="tt-pop-list">
        {TABLE_COLUMNS.map((c) => (
          <label key={c.key} className="check">
            <input
              type="checkbox"
              checked={settings.columns.includes(c.key)}
              disabled={c.key === 'title'}
              onChange={(e) => set(c.key, e.target.checked)}
            />{' '}
            {tr(c.label)}
          </label>
        ))}
      </div>
      <button
        className="btn sm"
        onClick={() => onChange(DEFAULT_TABLE)}
        title={tr('The default columns and sort, with no filters')}
      >
        <Icon name="refresh" />
        {tr('Reset the table')}
      </button>
    </div>
  );
}

/** Actions for the selected rows. */
function BulkBar({
  tasks,
  labels,
  onClear,
  onCopyForAi,
  onReport,
}: {
  tasks: Task[];
  labels: string[];
  onClear: () => void;
  onCopyForAi: () => void;
  onReport: () => void;
}) {
  const { putTask, toast, attempt } = useApp();
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const n = tasks.length;
  const rows = tr(n === 1 ? '1 task' : '{n} tasks', { n });
  const fromFile = tasks.filter((t) => t.source === 'file').length;

  const apply = async (change: BulkChange, done: string) => {
    setBusy(true);
    const out = await attempt(() =>
      window.worksync.bulkUpdate(
        tasks.map((t) => t.id),
        change,
      ),
    );
    setBusy(false);
    if (!out) return;
    out.forEach(putTask);
    toast(done);
  };
  const copyBriefs = async () => {
    await attempt(() =>
      window.worksync.copyText(tasks.map((t) => brief(t).text).join('\n\n')),
    );
    toast(`Copied the briefs of ${rows}.`);
  };
  const allPinned = tasks.every((t) => t.pinned);
  const someLabelled = label.trim()
    ? tasks.some((t) =>
        t.labels.some((l) => l.toLowerCase() === label.trim().toLowerCase()),
      )
    : false;

  return (
    <div className="tt-bulk" role="toolbar" aria-label={tr('Selected tasks')}>
      <b>{n} selected</b>
      <span className="tt-bulk-group">
        <input
          className="inp sm"
          list="tt-labels"
          placeholder={tr('Label')}
          aria-label={tr('Label to add or remove')}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && label.trim())
              void apply(
                { addLabel: label.trim() },
                `Added ${label.trim()} to ${rows}.`,
              ).then(() => setLabel(''));
          }}
        />
        <datalist id="tt-labels">
          {labels.map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>
        <button
          className="btn sm"
          disabled={busy || !label.trim()}
          onClick={() =>
            void apply(
              { addLabel: label.trim() },
              `Added ${label.trim()} to ${rows}.`,
            ).then(() => setLabel(''))
          }
        >
          <Icon name="plus" />
          {tr('Add')}
        </button>
        <button
          className="btn sm"
          disabled={busy || !someLabelled}
          onClick={() =>
            void apply(
              { removeLabel: label.trim() },
              `Removed ${label.trim()} from ${rows}.`,
            ).then(() => setLabel(''))
          }
        >
          {tr('Remove')}
        </button>
      </span>
      <select
        className="inp sm"
        aria-label={tr('Set the status')}
        value=""
        disabled={busy}
        onChange={(e) => {
          const s = e.target.value as Status;
          if (s)
            void apply(
              { status: s },
              `${rows} set to ${s}.${fromFile ? ' Not yet written to your copy.' : ''}`,
            );
        }}
      >
        <option value="">{tr('Status…')}</option>
        {STATUSES.map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      <button
        className="btn sm"
        disabled={busy}
        onClick={() =>
          void apply(
            { pinned: !allPinned },
            allPinned ? `Unpinned ${rows}.` : `Pinned ${rows}.`,
          )
        }
      >
        <Icon name="pin" />
        {allPinned ? tr('Unpin') : tr('Pin')}
      </button>
      <button className="btn sm" onClick={onCopyForAi}>
        <Icon name="spark" />
        {tr('Copy for AI')}
      </button>
      <button className="btn sm" onClick={() => void copyBriefs()}>
        <Icon name="copy" />
        {tr('Copy briefs')}
      </button>
      <button className="btn sm" onClick={onReport}>
        <Icon name="note" />
        {tr('Report')}
      </button>
      <button
        className="btn sm ghost"
        onClick={onClear}
        aria-label={tr('Clear the selection')}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}
