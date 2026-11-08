import { useEffect, useMemo, useRef } from 'react';
import {
  LEVELS,
  LEVEL_NAME,
  STATUSES,
  type Level,
  type Status,
  type Task,
} from '../shared/model';
import {
  NO_FILTER,
  filterChoices,
  filterCount,
  type ViewFilter,
} from '../shared/viewFilter';
import { useApp } from './appState';
import { Icon } from './Icon';
import { tr } from './i18n';

const toggle = <T,>(list: T[], v: T) =>
  list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

/** The Filter button in the top bar, with its choices. */
export function FilterButton({
  filter,
  setFilter,
  tasks,
  open,
  setOpen,
}: {
  filter: ViewFilter;
  setFilter: (f: ViewFilter) => void;
  /** The tasks in sight, for the people and labels to offer. */
  tasks: Task[];
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const { people } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const choices = useMemo(() => filterChoices(tasks, people), [tasks, people]);
  const n = filterCount(filter);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [open, setOpen]);
  const group = <T extends string>(
    title: string,
    values: T[],
    chosen: T[],
    set: (v: T[]) => void,
    label: (v: T) => string = (v) => v,
  ) =>
    values.length > 0 && (
      <fieldset className="fb-group">
        <legend>{title}</legend>
        <div className="fb-opts">
          {values.map((v) => (
            <button
              key={v}
              type="button"
              className="fb-opt"
              aria-pressed={chosen.includes(v)}
              onClick={() => set(toggle(chosen, v))}
            >
              {label(v)}
            </button>
          ))}
        </div>
      </fieldset>
    );
  return (
    <div className="fb-wrap" ref={ref}>
      <button
        className="btn top-filter"
        aria-label={tr('Filter')}
        aria-expanded={open}
        aria-pressed={n > 0}
        onClick={() => setOpen(!open)}
        title={tr('Filter every view by person, status, priority and label')}
      >
        <Icon name="sliders" />
        <span className="lbl">{tr('Filter')}</span>
        {n > 0 && <span className="badge">{n}</span>}
      </button>
      {open && (
        <div className="fb-pop" role="dialog" aria-label={tr('Filter')}>
          {group(
            'Assignee or handled by',
            choices.people.slice(0, 30),
            filter.people,
            (people) => setFilter({ ...filter, people }),
          )}
          {group<Status>('Status', [...STATUSES], filter.statuses, (statuses) =>
            setFilter({ ...filter, statuses }),
          )}
          {group<Level>(
            'Priority',
            LEVELS,
            filter.levels,
            (levels) => setFilter({ ...filter, levels }),
            (l) => LEVEL_NAME[l],
          )}
          {group(
            'Label',
            choices.labels.slice(0, 40),
            filter.labels,
            (labels) => setFilter({ ...filter, labels }),
          )}
          <div className="fb-foot">
            <span className="muted">
              {tr('Applies to every view, together with the search.')}
            </span>
            <button
              className="btn sm"
              disabled={!n}
              onClick={() => setFilter(NO_FILTER)}
            >
              {tr('Clear')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A line under the top bar while a filter is on, so a short list is never a surprise. */
export function FilterNotice({
  filter,
  setFilter,
  onEdit,
}: {
  filter: ViewFilter;
  setFilter: (f: ViewFilter) => void;
  onEdit: () => void;
}) {
  if (!filterCount(filter)) return null;
  const parts = [
    ...filter.people,
    ...filter.statuses,
    ...filter.levels.map((l) => LEVEL_NAME[l]),
    ...filter.labels.map((l) => `# ${l}`),
  ];
  return (
    <div className="notice" role="status">
      <Icon name="sliders" />
      <span className="notice-text">
        <b>{tr('Filtered')}</b> · {parts.join(', ')}
      </span>
      <span className="notice-actions">
        <button className="btn sm" onClick={onEdit}>
          {tr('Change')}
        </button>
        <button className="btn sm" onClick={() => setFilter(NO_FILTER)}>
          {tr('Clear')}
        </button>
      </span>
    </div>
  );
}
