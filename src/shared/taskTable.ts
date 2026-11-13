/**
 * The Tasks table (spec 03): its columns, and how it sorts and filters.
 * Kept apart from the view so the rules can be tested.
 */
import {
  LEVELS,
  LEVEL_NAME,
  STATUSES,
  fileDate,
  matchesSearch,
  shownPriority,
  personName,
  type Person,
  type TableSettings,
  type Task,
} from './model';

/** What a column may need besides the task. */
export interface TableContext {
  people: Person[];
}
const NO_CONTEXT: TableContext = { people: [] };

export type FilterKind = 'text' | 'choice' | 'date';

export interface TableColumn {
  key: string;
  label: string;
  /** Width in pixels, or 0 for the column that takes the spare room. */
  width: number;
  filter: FilterKind;
  /** The choices of a choice filter, as [value, label]. */
  choices?: [string, string][];
  /** The text shown, and matched by a text filter. */
  text: (t: Task, c: TableContext) => string;
  /** What the column sorts by. Empty values always go last. */
  sortValue: (t: Task, c: TableContext) => string | number;
  /** The value a choice filter compares. */
  choiceValue?: (t: Task) => string;
}

const date = (d: string | null) => d ?? '';

export const TABLE_COLUMNS: TableColumn[] = [
  {
    key: 'id',
    label: 'No.',
    width: 72,
    filter: 'text',
    text: (t) => t.customerId,
    sortValue: (t) => t.customerId,
  },
  {
    key: 'title',
    label: 'Title',
    width: 0,
    filter: 'text',
    text: (t) => t.titleTranslation || t.titleOriginal,
    sortValue: (t) => (t.titleTranslation || t.titleOriginal).toLowerCase(),
  },
  {
    key: 'original',
    label: 'Original title',
    width: 240,
    filter: 'text',
    text: (t) => t.titleOriginal,
    sortValue: (t) => t.titleOriginal,
  },
  {
    key: 'status',
    label: 'Status',
    width: 120,
    filter: 'choice',
    choices: STATUSES.map((s) => [s, s]),
    text: (t) => t.status,
    sortValue: (t) => STATUSES.indexOf(t.status) + 1,
    choiceValue: (t) => t.status,
  },
  {
    key: 'priority',
    label: 'Priority',
    width: 96,
    filter: 'choice',
    choices: LEVELS.map((l) => [l, LEVEL_NAME[l]]),
    text: (t) => LEVEL_NAME[shownPriority(t)],
    sortValue: (t) => LEVELS.indexOf(shownPriority(t)) + 1,
    choiceValue: (t) => shownPriority(t),
  },
  {
    key: 'assignee',
    label: 'Assignee',
    width: 110,
    filter: 'text',
    text: (t, c) => personName(c.people, t.projectId, t.assignee),
    sortValue: (t, c) =>
      personName(c.people, t.projectId, t.assignee).toLowerCase(),
  },
  {
    key: 'handledBy',
    label: 'Handled by',
    width: 130,
    filter: 'text',
    text: (t) => t.situation.handledBy,
    sortValue: (t) => t.situation.handledBy.toLowerCase(),
  },
  {
    key: 'plannedStart',
    label: 'Planned start',
    width: 104,
    filter: 'date',
    text: (t) => fileDate(t.plannedStart),
    sortValue: (t) => date(t.plannedStart),
  },
  {
    key: 'plannedEnd',
    label: 'Planned end',
    width: 104,
    filter: 'date',
    text: (t) => fileDate(t.plannedEnd),
    sortValue: (t) => date(t.plannedEnd),
  },
  {
    key: 'actualStart',
    label: 'Actual start',
    width: 104,
    filter: 'date',
    text: (t) => fileDate(t.actualStart),
    sortValue: (t) => date(t.actualStart),
  },
  {
    key: 'actualEnd',
    label: 'Actual end',
    width: 104,
    filter: 'date',
    text: (t) => fileDate(t.actualEnd),
    sortValue: (t) => date(t.actualEnd),
  },
  {
    key: 'labels',
    label: 'Labels',
    width: 140,
    filter: 'text',
    text: (t) => t.labels.join(', '),
    sortValue: (t) => t.labels.join(', ').toLowerCase(),
  },
  {
    key: 'nextStep',
    label: 'Next step',
    width: 220,
    filter: 'text',
    text: (t) => t.situation.nextStep,
    sortValue: (t) => t.situation.nextStep.toLowerCase(),
  },
  {
    key: 'nextDate',
    label: 'Next date',
    width: 104,
    filter: 'date',
    text: (t) => fileDate(t.situation.nextDate),
    sortValue: (t) => date(t.situation.nextDate),
  },
  {
    key: 'asOf',
    label: 'As of',
    width: 104,
    filter: 'date',
    text: (t) => fileDate(t.situation.asOf),
    sortValue: (t) => date(t.situation.asOf),
  },
  {
    key: 'category',
    label: 'Category',
    width: 120,
    filter: 'text',
    text: (t) => t.category,
    sortValue: (t) => t.category.toLowerCase(),
  },
  {
    key: 'updated',
    label: 'Changed',
    width: 104,
    filter: 'date',
    text: (t) => fileDate(t.updatedAt.slice(0, 10)),
    sortValue: (t) => t.updatedAt,
  },
];

export const columnByKey = (key: string) =>
  TABLE_COLUMNS.find((c) => c.key === key);

export const DEFAULT_TABLE: TableSettings = {
  columns: [
    'id',
    'title',
    'status',
    'priority',
    'handledBy',
    'plannedEnd',
    'labels',
  ],
  sort: { key: 'priority', dir: 'asc' },
  filters: {},
};

/** Saved settings, with unknown columns dropped and the title always shown. */
export function tableSettings(saved: TableSettings | null): TableSettings {
  if (!saved) return DEFAULT_TABLE;
  const columns = saved.columns.filter((k) => columnByKey(k));
  if (!columns.includes('title')) columns.splice(1, 0, 'title');
  return {
    columns,
    sort: columnByKey(saved.sort?.key) ? saved.sort : DEFAULT_TABLE.sort,
    filters: Object.fromEntries(
      Object.entries(saved.filters ?? {}).filter(
        ([k, v]) => columnByKey(k) && v,
      ),
    ),
  };
}

/**
 * Whether a task passes a column filter. A text filter matches part of the
 * text, ignoring case; a choice filter matches exactly; a date filter accepts
 * "2026/11", "2026-11-03", or a range such as "2026/11/01-2026/11/15"
 * ("-" alone after a date means from then on), and "none" for no date.
 */
export function passes(
  c: TableColumn,
  t: Task,
  filter: string,
  ctx: TableContext = NO_CONTEXT,
): boolean {
  const f = filter.trim();
  if (!f) return true;
  if (c.filter === 'choice')
    return (c.choiceValue ? c.choiceValue(t) : c.text(t, ctx)) === f;
  const text = c.text(t, ctx);
  if (c.filter === 'date') {
    if (/^(none|empty|-)$/i.test(f)) return !text;
    if (!text) return false;
    const d = text.replaceAll('/', '-');
    const norm = (s: string) => s.trim().replaceAll('/', '-');
    const D = String.raw`\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?`;
    const range = f.match(new RegExp(`^(${D})?\\s*[-~〜]\\s*(${D})?$`));
    if (range && (range[1] || range[2])) {
      const from = range[1] ? pad(norm(range[1])) : '';
      const to = range[2] ? pad(norm(range[2]), true) : '';
      return (!from || d >= from) && (!to || d <= to);
    }
    return d.startsWith(pad(norm(f), false, true));
  }
  const needle = f.toLowerCase();
  // The assignee also matches the name as written in the file.
  return (
    text.toLowerCase().includes(needle) ||
    (c.key === 'assignee' && t.assignee.toLowerCase().includes(needle))
  );
}

/** "2026-1" → "2026-01"; as the end of a range, a month means its last day. */
function pad(s: string, end = false, prefix = false): string {
  const [y, m, d] = s.split('-');
  const mm = m ? m.padStart(2, '0') : '';
  const dd = d ? d.padStart(2, '0') : '';
  if (prefix) return [y, mm, dd].filter(Boolean).join('-');
  if (!mm) return end ? `${y}-12-31` : `${y}-01-01`;
  if (!dd) return end ? `${y}-${mm}-31` : `${y}-${mm}-01`;
  return `${y}-${mm}-${dd}`;
}

/** The rows the table shows: the search, then each column filter, then the sort. */
export function tableRows(
  tasks: Task[],
  settings: TableSettings,
  query: string,
  ctx: TableContext = NO_CONTEXT,
): Task[] {
  const filters = Object.entries(settings.filters)
    .map(([k, v]) => [columnByKey(k), v] as const)
    .filter(([c, v]) => c && v.trim());
  const sortBy = columnByKey(settings.sort.key) ?? columnByKey('priority')!;
  const dir = settings.sort.dir === 'desc' ? -1 : 1;
  return tasks
    .filter((t) => matchesSearch(t, query, ctx.people))
    .filter((t) => filters.every(([c, v]) => passes(c!, t, v, ctx)))
    .map((t) => ({ t, v: sortBy.sortValue(t, ctx) }))
    .sort((a, b) => {
      const ea = a.v === '';
      const eb = b.v === '';
      if (ea !== eb) return ea ? 1 : -1;
      const c =
        typeof a.v === 'number' && typeof b.v === 'number'
          ? a.v - b.v
          : String(a.v).localeCompare(String(b.v), undefined, {
              numeric: true,
            });
      // Ties keep a steady order: by number in the file.
      return (
        c * dir ||
        a.t.customerId.localeCompare(b.t.customerId, undefined, {
          numeric: true,
        })
      );
    })
    .map((x) => x.t);
}

/**
 * The rows a shift-click selects: from the last row clicked to this one, in
 * the order shown.
 */
export function rangeIds(
  shown: string[],
  anchor: string | null,
  id: string,
): string[] {
  const a = anchor ? shown.indexOf(anchor) : -1;
  const b = shown.indexOf(id);
  if (a < 0 || b < 0) return [id];
  return shown.slice(Math.min(a, b), Math.max(a, b) + 1);
}
