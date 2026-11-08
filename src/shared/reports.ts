/**
 * Reports (spec 05): what goes in each one. Built from the information the
 * owner already keeps; the files themselves are made in the main process.
 */
import {
  LEVEL_NAME,
  STATUSES,
  addDays,
  byPriority,
  daysBetween,
  flags,
  formatDate,
  isClosed,
  shownPriority,
  type DateFormat,
  type Level,
  type Project,
  type Status,
  type Task,
} from './model';

export type ReportKind = 'progress' | 'taskList' | 'schedule' | 'briefs';
export type ReportFormat = 'docx' | 'xlsx';
export type ReportLanguage = 'working' | 'original' | 'both';

export const REPORTS: Record<
  ReportKind,
  { name: string; description: string; formats: ReportFormat[] }
> = {
  progress: {
    name: 'Progress report',
    description:
      'An overview of the period, then each task’s brief: what it is, its situation, difficulties and next steps.',
    formats: ['docx', 'xlsx'],
  },
  taskList: {
    name: 'Task list',
    description: 'A table of tasks with the columns you choose.',
    formats: ['xlsx', 'docx'],
  },
  schedule: {
    name: 'Schedule',
    description:
      'Planned and actual dates for each task, drawn as shaded cells.',
    formats: ['xlsx'],
  },
  briefs: {
    name: 'Task briefs',
    description:
      'The brief of each task, for a meeting with your manager or the customer.',
    formats: ['docx'],
  },
};

export interface ReportOptions {
  kind: ReportKind;
  format: ReportFormat;
  projectId: string;
  /** Statuses to include; empty means all. */
  statuses: Status[];
  /** Priority levels to include; empty means all. */
  levels: Level[];
  /** Only tasks with this label, when set. */
  label: string;
  /** Only tasks with this assignee or handler, when set. */
  person: string;
  /** For the progress report: the period, as dates. */
  from: string;
  to: string;
  language: ReportLanguage;
  /** Task list columns, by key. */
  columns: string[];
  includeNotes: boolean;
  preparedBy: string;
  /** Only these tasks, such as the rows selected in the Tasks table. */
  taskIds?: string[];
  /** Filled in by the main process from the project. */
  dateFormat?: DateFormat;
  /**
   * The owner's text in the file's language, by the text as written. Filled
   * in by the main process from the translations the owner accepted.
   */
  translations?: Record<string, string>;
}

const STATUS_JA: Record<Status, string> = {
  'Not started': '未着手',
  'In progress': '対応中',
  'In review': 'レビュー中',
  'On hold': '保留',
  Done: '完了',
  Cancelled: '中止',
};

/**
 * A task's status in the report's language: the file's own word when it has
 * one, and a Japanese word in a Japanese report.
 */
export const statusText = (
  t: Pick<Task, 'status' | 'statusWord' | 'language'>,
  o: Pick<ReportOptions, 'language'>,
): string =>
  t.statusWord ||
  (o.language === 'original' && t.language === 'ja'
    ? STATUS_JA[t.status]
    : t.status);

/** A date in the report's date format. */
export const dateIn = (
  date: string | null,
  o: Pick<ReportOptions, 'dateFormat'>,
): string => formatDate(date, o.dateFormat);

/** Monday to Sunday of the week that holds `today`, the default period. */
export function thisWeek(today: string): { from: string; to: string } {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const from = addDays(today, -((dow + 6) % 7));
  return { from, to: addDays(from, 6) };
}

/**
 * The tasks a report covers. The progress report covers tasks that are not
 * Done or Cancelled, plus tasks that changed during the period. Removed rows
 * are left out.
 */
export function reportTasks(all: Task[], o: ReportOptions): Task[] {
  const person = o.person.trim().toLowerCase();
  const label = o.label.trim().toLowerCase();
  return all
    .filter((t) => t.projectId === o.projectId && t.fileState !== 'removed')
    .filter((t) => !o.taskIds?.length || o.taskIds.includes(t.id))
    .filter((t) => !o.statuses.length || o.statuses.includes(t.status))
    .filter((t) => !o.levels.length || o.levels.includes(shownPriority(t)))
    .filter((t) => !label || t.labels.some((l) => l.toLowerCase() === label))
    .filter(
      (t) =>
        !person ||
        `${t.assignee}\n${t.situation.handledBy}`
          .toLowerCase()
          .includes(person),
    )
    .filter((t) => {
      if (o.kind !== 'progress') return true;
      if (!isClosed(t)) return true;
      const changed = t.updatedAt.slice(0, 10);
      return changed >= o.from && changed <= o.to;
    })
    .sort(byPriority);
}

/** The overview at the top of the progress report. */
export function periodOverview(
  tasks: Task[],
  project: Project,
  o: ReportOptions,
  today: string,
) {
  const open = tasks.filter((t) => !isClosed(t));
  const inPeriod = (d: string | null) => !!d && d >= o.from && d <= o.to;
  return {
    open: open.length,
    finished: tasks.filter(
      (t) =>
        t.status === 'Done' &&
        inPeriod(t.actualEnd ?? t.updatedAt.slice(0, 10)),
    ).length,
    started: tasks.filter((t) => inPeriod(t.actualStart)).length,
    overdue: open.filter((t) => flags(t, today, project.dueSoonDays).overdue)
      .length,
    difficulties: open.reduce(
      (n, t) => n + t.difficulties.filter((d) => d.open).length,
      0,
    ),
    byStatus: STATUSES.map((s) => ({
      status: s,
      count: tasks.filter((t) => t.status === s).length,
    })).filter((x) => x.count),
  };
}

/** A task's title in the chosen language: the working language, the original, or both. */
export function reportTitle(t: Task, language: ReportLanguage): string {
  const tr = t.titleTranslation;
  if (language === 'original' || !tr || tr === t.titleOriginal)
    return t.titleOriginal;
  if (language === 'working') return tr;
  return `${t.titleOriginal}\n${tr}`;
}

/**
 * Text the owner writes, such as summaries, is in the working language. A
 * report in the original language uses the owner's accepted translation, and
 * marks text without one as not translated (spec 05). Both languages show the
 * text with its translation under it.
 */
export function ownerText(
  text: string,
  o: Pick<ReportOptions, 'language' | 'translations'>,
  originalIsJapanese: boolean,
): string {
  if (!text || o.language === 'working') return text;
  const tr = o.translations?.[text];
  if (o.language === 'both') return tr ? `${text}\n${tr}` : text;
  if (tr) return tr;
  return `${originalIsJapanese ? '（未翻訳）' : '(not translated) '}${text}`;
}

/** The owner's texts a report would show, for checking which need a translation. */
export function ownerTexts(t: Task): string[] {
  return [
    t.summary,
    t.situation.doingNow,
    t.situation.nextStep,
    ...t.difficulties.filter((d) => d.open).map((d) => d.text),
  ].filter((x) => x.trim());
}

export interface Column {
  key: string;
  label: string;
  /** The Japanese heading, used when the report is in Japanese or both languages. */
  ja: string;
  width: number;
  value: (t: Task, o: ReportOptions) => string;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export const COLUMNS: Column[] = [
  { key: 'id', label: 'No.', ja: 'No.', width: 8, value: (t) => t.customerId },
  {
    key: 'title',
    label: 'Title',
    ja: '件名',
    width: 44,
    value: (t, o) => reportTitle(t, o.language),
  },
  {
    key: 'status',
    label: 'Status',
    ja: '状態',
    width: 12,
    value: (t, o) => statusText(t, o),
  },
  {
    key: 'priority',
    label: 'Priority',
    ja: '優先度',
    width: 10,
    value: (t) => LEVEL_NAME[shownPriority(t)],
  },
  {
    key: 'assignee',
    label: 'Assignee',
    ja: '担当者',
    width: 14,
    value: (t) => t.assignee,
  },
  {
    key: 'handledBy',
    label: 'Handled by',
    ja: '対応者',
    width: 18,
    value: (t) => t.situation.handledBy,
  },
  {
    key: 'plannedStart',
    label: 'Planned start',
    ja: '予定開始',
    width: 12,
    value: (t, o) => dateIn(t.plannedStart, o),
  },
  {
    key: 'plannedEnd',
    label: 'Planned end',
    ja: '予定終了',
    width: 12,
    value: (t, o) => dateIn(t.plannedEnd, o),
  },
  {
    key: 'actualStart',
    label: 'Actual start',
    ja: '実績開始',
    width: 12,
    value: (t, o) => dateIn(t.actualStart, o),
  },
  {
    key: 'actualEnd',
    label: 'Actual end',
    ja: '実績終了',
    width: 12,
    value: (t, o) => dateIn(t.actualEnd, o),
  },
  {
    key: 'summary',
    label: 'Summary',
    ja: '概要',
    width: 44,
    value: (t, o) => ownerText(t.summary, o, true),
  },
  {
    key: 'doingNow',
    label: 'Doing now',
    ja: '現状',
    width: 36,
    value: (t, o) => ownerText(t.situation.doingNow, o, true),
  },
  {
    key: 'difficulties',
    label: 'Open difficulties',
    ja: '課題',
    width: 36,
    value: (t, o) =>
      t.difficulties
        .filter((d) => d.open)
        .map((d) => ownerText(d.text, o, true))
        .join('\n'),
  },
  {
    key: 'next',
    label: 'Next step',
    ja: '今後の予定',
    width: 36,
    value: (t, o) =>
      t.situation.nextStep
        ? `${ownerText(t.situation.nextStep, o, true)}${t.situation.nextDate ? ` (${dateIn(t.situation.nextDate, o)})` : ''}`
        : '',
  },
  {
    key: 'labels',
    label: 'Labels',
    ja: 'ラベル',
    width: 18,
    value: (t) => t.labels.join(', '),
  },
  {
    key: 'remarks',
    label: 'Remarks',
    ja: '備考',
    width: 30,
    value: (t) => t.remarks,
  },
  {
    key: 'notes',
    label: 'Notes',
    ja: 'メモ',
    width: 36,
    value: (t, o) => (o.includeNotes ? t.notes : ''),
  },
];

export const DEFAULT_COLUMNS = [
  'id',
  'title',
  'status',
  'priority',
  'assignee',
  'plannedEnd',
  'doingNow',
  'next',
];

/** A column heading in the report's language. */
export const heading = (
  c: Pick<Column, 'label' | 'ja'>,
  language: ReportLanguage,
  originalIsJapanese: boolean,
) =>
  !originalIsJapanese || language === 'working'
    ? c.label
    : language === 'original'
      ? c.ja
      : `${c.ja} ${c.label}`;

/** The three parts of a brief, for the progress report and the briefs. */
export function briefParts(
  t: Task,
  o: ReportOptions,
  today: string,
  dueSoonDays: number,
) {
  const s = t.situation;
  const ja = t.language === 'ja';
  // Connecting words in the file's language when the report is in it.
  const inJa = ja && o.language === 'original';
  const open = t.difficulties.filter((d) => d.open);
  const doing = s.doingNow ? ownerText(s.doingNow, o, ja) : '';
  const where = [
    statusText(t, o),
    s.handledBy &&
      (doing
        ? `${s.handledBy}: ${o.language === 'working' ? lower(doing) : doing}`
        : s.handledBy),
  ]
    .filter(Boolean)
    .join(' · ');
  const f = flags(t, today, dueSoonDays);
  const due =
    t.plannedEnd && !isClosed(t)
      ? inJa
        ? `${f.overdue ? '期限超過、期限' : '期限'} ${dateIn(t.plannedEnd, o)}`
        : `${f.overdue ? 'Overdue, was due' : 'Due'} ${dateIn(t.plannedEnd, o)}`
      : '';
  return {
    what: ownerText(t.summary || '', o, ja),
    doingNow: where,
    difficulties: open.map(
      (d) =>
        `${ownerText(d.text, o, ja)}${d.resolver ? ` (${d.resolver})` : ''}`,
    ),
    next: s.nextStep
      ? `${ownerText(s.nextStep, o, ja)}${s.nextDate ? (inJa ? `（${dateIn(s.nextDate, o)}まで）` : ` by ${dateIn(s.nextDate, o)}`) : ''}`
      : '',
    due,
    asOf: s.asOf ? dateIn(s.asOf, o) : '',
    stale: s.asOf ? daysBetween(s.asOf, today) : null,
  };
}

/**
 * The task brief in the file's language (spec 03, Task brief), from the
 * owner's accepted translations. Parts without a translation are marked as
 * not translated.
 */
export function briefInFileLanguage(
  t: Task,
  translations: Record<string, string>,
  today: string,
  dueSoonDays: number,
  dateFormat?: DateFormat,
): { text: string; missing: number } {
  const o = {
    language: 'original',
    translations,
    dateFormat,
  } as ReportOptions;
  const b = briefParts(t, o, today, dueSoonDays);
  const missing = ownerTexts(t).filter((x) => !translations[x]).length;
  const ja = t.language === 'ja';
  const L = ja
    ? {
        what: '概要',
        where: '現状',
        issues: '課題',
        next: '今後の予定',
        none: '未定',
      }
    : {
        what: 'What it is',
        where: 'Where it stands',
        issues: 'Difficulties',
        next: 'What happens next',
        none: 'Not decided yet',
      };
  const lines = [
    `No. ${t.customerId}  ${t.titleOriginal}`,
    `${L.what}: ${b.what || '—'}`,
    `${L.where}: ${[b.doingNow, b.due, b.asOf && (ja ? `${b.asOf}時点` : `as of ${b.asOf}`)].filter(Boolean).join(' · ')}`,
    ...(b.difficulties.length
      ? [`${L.issues}: ${b.difficulties.join(ja ? '、' : '; ')}`]
      : []),
    `${L.next}: ${b.next || L.none}`,
  ];
  return { text: lines.join('\n'), missing };
}

/** The file name for a report, such as "Portal progress report 20261103.docx". */
export function reportFileName(
  project: Project,
  o: Pick<ReportOptions, 'kind' | 'format'>,
  today: string,
): string {
  const safe = project.name
    .replace(/^sample:\s*/i, '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .trim();
  return `${safe} ${REPORTS[o.kind].name.toLowerCase()} ${today.replaceAll('-', '')}.${o.format}`;
}
