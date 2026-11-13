/**
 * The import rules from spec 04, on a plain grid of cell values. Reading the
 * workbook itself happens in the main process; everything here is pure, so
 * it can be tested without Excel files.
 */
import { addDays, type Level, type Status } from './model';

/** One cell as read from the sheet: text, a number, or a date (as `YYYY-MM-DD`). */
export type Cell = string | number | { date: string } | null;
/** Rows of cells, with merged cells already filled in by the reader. */
export type Grid = Cell[][];

/** Task fields a column can be matched to. */
export const IMPORT_FIELDS = [
  'customerId',
  'title',
  'description',
  'assignee',
  'plannedStart',
  'plannedEnd',
  'actualStart',
  'actualEnd',
  'status',
  'priority',
  'category',
  'remarks',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const FIELD_NAMES: Record<ImportField, string> = {
  customerId: 'ID',
  title: 'Title',
  description: 'Description',
  assignee: 'Assignee',
  plannedStart: 'Planned start',
  plannedEnd: 'Planned end',
  actualStart: 'Actual start',
  actualEnd: 'Actual end',
  status: 'Status',
  priority: 'Priority',
  category: 'Category',
  remarks: 'Remarks',
};

/**
 * Usual headers for each field (spec 02), most specific first. Matching
 * ignores spaces, so 予定 開始 from two header rows matches 予定開始.
 */
const USUAL_HEADERS: Record<ImportField, string[]> = {
  customerId: [
    '管理番号',
    'no.',
    'no',
    '№',
    '番号',
    'id',
    '項番',
    'チケット番号',
    '課題番号',
    'mã',
    'stt',
  ],
  title: [
    '件名',
    'タスク名',
    '作業項目',
    '作業名',
    '課題',
    '項目',
    'タイトル',
    'title',
    'task',
    'subject',
    'summary',
    'tiêu đề',
    'công việc',
  ],
  description: [
    '作業内容',
    '内容',
    '詳細',
    '説明',
    '概要',
    'description',
    'details',
    'detail',
    'mô tả',
    'nội dung',
  ],
  assignee: [
    '担当者',
    '担当',
    'assignee',
    'owner',
    'person in charge',
    'người phụ trách',
    'phụ trách',
  ],
  plannedStart: [
    '予定開始日',
    '開始予定日',
    '開始予定',
    '予定開始',
    'planned start',
    'start plan',
    'start date',
    'ngày bắt đầu',
  ],
  plannedEnd: [
    '予定終了日',
    '終了予定日',
    '完了予定日',
    '完了予定',
    '終了予定',
    '予定終了',
    '期限',
    '期日',
    '納期',
    'due date',
    'due',
    'planned end',
    'deadline',
    'end date',
    'hạn',
    'ngày kết thúc',
  ],
  actualStart: ['実績開始日', '開始実績', '実績開始', '開始日', 'actual start'],
  actualEnd: [
    '実績終了日',
    '終了実績',
    '実績終了',
    '完了日',
    '終了日',
    'actual end',
    'completed',
    'closed date',
  ],
  status: [
    '対応状況',
    'ステータス',
    '状態',
    '状況',
    '進捗状況',
    'status',
    'state',
    'trạng thái',
  ],
  priority: [
    '優先度',
    '重要度',
    '優先順位',
    'priority',
    'severity',
    'độ ưu tiên',
    'ưu tiên',
  ],
  category: ['分類', '種別', '区分', 'カテゴリ', 'category', 'type', 'loại'],
  remarks: [
    '備考',
    'コメント',
    '特記事項',
    'remarks',
    'comment',
    'comments',
    'note',
    'notes',
    'ghi chú',
  ],
};

const norm = (s: string): string =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　・:：]/g, '')
    .replace(/[（(].*?[)）]/g, '');

// ---------------------------------------------------------------- text

export function cellText(c: Cell): string {
  if (c === null) return '';
  if (typeof c === 'object') return c.date;
  return String(c).trim();
}

// ---------------------------------------------------------------- dates

/** Japanese eras, newest first, with the Gregorian year before year 1. */
const ERAS: { names: string[]; base: number }[] = [
  { names: ['令和', 'r'], base: 2018 },
  { names: ['平成', 'h'], base: 1988 },
  { names: ['昭和', 's'], base: 1925 },
];

const valid = (y: number, m: number, d: number): string | null => {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
};

/** Excel's day 0 is 1899-12-30 (counting its 1900 leap-year bug). */
export function excelSerialToDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  return addDays('1899-12-30', Math.floor(serial));
}

/**
 * Reads a date the many ways customer files write it (spec 04): real Excel
 * dates, 2026/11/03, 11/3, 2026年11月3日, 11月3日, 令和8年11月3日 and R8.11.3.
 * A date without a year takes the year that puts it closest to `readDay`.
 */
export function parseDate(
  c: Cell,
  readDay: string,
  /** True for files that write 3/11 as 3 November; Japanese files write month first. */
  dayFirst = false,
): string | null {
  if (c === null) return null;
  if (typeof c === 'object') return c.date;
  if (typeof c === 'number') return excelSerialToDate(c);
  let s = c.normalize('NFKC').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/\s+/g, '').replace(/[(（][^)）]*[)）]$/, ''); // drop a trailing weekday like (火)

  for (const era of ERAS) {
    for (const name of era.names) {
      const re = new RegExp(
        `^${name}(\\d{1,2}|元)[年./-](\\d{1,2})[月./-](\\d{1,2})日?$`,
      );
      const m = s.match(re);
      if (m)
        return valid(
          era.base + (m[1] === '元' ? 1 : Number(m[1])),
          Number(m[2]),
          Number(m[3]),
        );
    }
  }
  let m = s.match(/^(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})日?$/);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  // 3/11/2026, month or day first as the format says.
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return dayFirst ? valid(Number(m[3]), b, a) : valid(Number(m[3]), a, b);
  }
  m = s.match(/^(\d{1,2})([月./-])(\d{1,2})日?$/);
  if (m) {
    // 11月3日 is always month first; 3/11 follows the format.
    const swap = dayFirst && m[2] !== '月';
    const [mo, d] = swap
      ? [Number(m[3]), Number(m[1])]
      : [Number(m[1]), Number(m[3])];
    const y = Number(readDay.slice(0, 4));
    const candidates = [y - 1, y, y + 1]
      .map((yy) => valid(yy, mo, d))
      .filter((x): x is string => x !== null);
    if (!candidates.length) return null;
    const dist = (x: string) => Math.abs(Date.parse(x) - Date.parse(readDay));
    return candidates.sort((a, b) => dist(a) - dist(b))[0];
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) return excelSerialToDate(Number(s));
  return null;
}

// ---------------------------------------------------------------- headers

/** How well a header text matches a field: 3 exact, 2 starts with, 1 contains, 0 no. */
function headerScore(header: string, field: ImportField): number {
  const h = norm(header);
  if (!h) return 0;
  let best = 0;
  for (const usual of USUAL_HEADERS[field]) {
    const u = norm(usual);
    if (h === u) return 3;
    if (h.startsWith(u) && u.length >= 2) best = Math.max(best, 2);
    else if (u.length >= 2 && h.includes(u)) best = Math.max(best, 1);
  }
  return best;
}

/** The row, among the first 30, that looks most like a header row. */
export function suggestHeaderRow(grid: Grid): number {
  let best = 0;
  let bestScore = -1;
  for (let r = 0; r < Math.min(grid.length, 30); r++) {
    const texts = (grid[r] ?? []).map(cellText).filter(Boolean);
    const matched = texts.filter((t) =>
      IMPORT_FIELDS.some((f) => headerScore(t, f) >= 2),
    ).length;
    const score =
      matched * 10 +
      texts.filter((t) => t.length <= 20 && typeof t === 'string').length;
    if (matched >= 2 && score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The header rows to suggest: the header row, and the row under it when that
 * row holds sub-headers, such as 開始 and 終了 under a merged 予定.
 */
export function suggestHeaderRows(grid: Grid): number[] {
  const h = suggestHeaderRow(grid);
  const top = (grid[h] ?? []).map(cellText);
  const next = (grid[h + 1] ?? []).map(cellText);
  const filled = next.map((t, k) => [t, k] as const).filter(([t]) => t);
  if (filled.length < 2 || filled.some(([t]) => t.length > 12)) return [h];
  // A sub-header sits under an empty cell, or under a merged cell whose text repeats beside it.
  const spanned = filled.filter(
    ([t, k]) =>
      t !== top[k] &&
      (!top[k] || top[k] === top[k - 1] || top[k] === top[k + 1]),
  );
  // Task rows have IDs or dates; sub-headers do not.
  const looksLikeData = filled.some(
    ([t]) => /^\d+$/.test(t) || parseDate(t, '2000-01-01') !== null,
  );
  return spanned.length >= 2 && !looksLikeData ? [h, h + 1] : [h];
}

/**
 * The header name of each column. With two header rows, such as 予定 over 開始
 * and 終了, the upper row's text carries right over the cells it spans and the
 * names are joined, as 予定 開始.
 */
export function headerNames(grid: Grid, headerRows: number[]): string[] {
  const width = Math.max(0, ...grid.map((r) => r.length));
  const rows = [...headerRows].sort((a, b) => a - b);
  const names: string[] = [];
  for (let c = 0; c < width; c++) {
    const parts: string[] = [];
    rows.forEach((r, i) => {
      let t = cellText(grid[r]?.[c] ?? null);
      // An upper header row spans the columns to its right until the next text.
      if (!t && i < rows.length - 1) {
        for (let k = c - 1; k >= 0; k--) {
          const left = cellText(grid[r]?.[k] ?? null);
          if (left) {
            t = left;
            break;
          }
        }
      }
      if (t && parts[parts.length - 1] !== t) parts.push(t);
    });
    names.push(parts.join(' '));
  }
  return names;
}

export type ColumnMapping = Partial<Record<ImportField, number>>;

/** Suggests a column for each field from the header text. Each column is used once. */
export function suggestMapping(headers: string[]): ColumnMapping {
  const pairs: { field: ImportField; col: number; score: number }[] = [];
  headers.forEach((h, col) => {
    for (const field of IMPORT_FIELDS) {
      const score = headerScore(h, field);
      if (score) pairs.push({ field, col, score });
    }
  });
  pairs.sort((a, b) => b.score - a.score || a.col - b.col);
  const mapping: ColumnMapping = {};
  const usedCols = new Set<number>();
  for (const p of pairs) {
    if (mapping[p.field] !== undefined || usedCols.has(p.col)) continue;
    mapping[p.field] = p.col;
    usedCols.add(p.col);
  }
  return mapping;
}

// ---------------------------------------------------------------- values

/** Common status words and symbols (spec 02), as proposals the owner confirms. */
const STATUS_WORDS: Record<string, Status> = {
  未着手: 'Not started',
  未対応: 'Not started',
  未: 'Not started',
  '-': 'Not started',
  'not started': 'Not started',
  open: 'Not started',
  new: 'Not started',
  'chưa bắt đầu': 'Not started',
  対応中: 'In progress',
  作業中: 'In progress',
  着手: 'In progress',
  着手中: 'In progress',
  進行中: 'In progress',
  実施中: 'In progress',
  '△': 'In progress',
  'in progress': 'In progress',
  wip: 'In progress',
  'đang thực hiện': 'In progress',
  'đang làm': 'In progress',
  確認中: 'In review',
  レビュー中: 'In review',
  確認待ち: 'In review',
  承認待ち: 'In review',
  'in review': 'In review',
  review: 'In review',
  'đang kiểm tra': 'In review',
  保留: 'On hold',
  中断: 'On hold',
  待機: 'On hold',
  'on hold': 'On hold',
  pending: 'On hold',
  'tạm dừng': 'On hold',
  完了: 'Done',
  済: 'Done',
  済み: 'Done',
  対応済: 'Done',
  対応済み: 'Done',
  クローズ: 'Done',
  '○': 'Done',
  '◯': 'Done',
  〇: 'Done',
  done: 'Done',
  closed: 'Done',
  completed: 'Done',
  'hoàn thành': 'Done',
  xong: 'Done',
  中止: 'Cancelled',
  取り下げ: 'Cancelled',
  取下げ: 'Cancelled',
  対応不要: 'Cancelled',
  '×': 'Cancelled',
  cancelled: 'Cancelled',
  canceled: 'Cancelled',
  hủy: 'Cancelled',
};

const PRIORITY_WORDS: Record<string, Level> = {
  至急: 'U',
  緊急: 'U',
  最優先: 'U',
  最高: 'U',
  s: 'U',
  urgent: 'U',
  critical: 'U',
  'khẩn cấp': 'U',
  高: 'H',
  優先: 'H',
  a: 'H',
  high: 'H',
  大: 'H',
  cao: 'H',
  中: 'N',
  b: 'N',
  normal: 'N',
  medium: 'N',
  普通: 'N',
  'trung bình': 'N',
  低: 'L',
  c: 'L',
  low: 'L',
  小: 'L',
  thấp: 'L',
};

const key = (s: string) =>
  s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

export const proposeStatus = (word: string): Status | undefined =>
  STATUS_WORDS[key(word)];
export const proposeLevel = (word: string): Level | undefined =>
  PRIORITY_WORDS[key(word)];

/** The distinct values a column holds, in order of first appearance. */
export function distinctValues(
  grid: Grid,
  col: number,
  fromRow: number,
): string[] {
  const seen = new Set<string>();
  for (let r = fromRow; r < grid.length; r++) {
    const t = cellText(grid[r]?.[col] ?? null);
    if (t) seen.add(t);
  }
  return [...seen];
}

// ---------------------------------------------------------------- rows

/** A saved way to read one kind of file (spec 04, Setting up a file format). */
/**
 * Fields that may read the same column. The title may be the ID, for files
 * where a task is known by its number or code (the ID column then gives both).
 */
export const MAY_SHARE: [ImportField, ImportField][] = [
  ['title', 'customerId'],
];

/** Whether a field may use a column another field already uses. */
export function columnFree(
  columns: ColumnMapping,
  field: ImportField,
  col: number,
): boolean {
  return (Object.entries(columns) as [ImportField, number | undefined][]).every(
    ([f, c]) =>
      c !== col ||
      f === field ||
      MAY_SHARE.some(
        ([a, b]) => (a === f && b === field) || (b === f && a === field),
      ),
  );
}

export interface FileFormat {
  name: string;
  sheet: string;
  headerRows: number[];
  columns: ColumnMapping;
  /** The file's own word → app status. */
  statusWords: Record<string, Status>;
  /** The file's own value → priority level. */
  priorityWords: Record<string, Level>;
  /** True when the file writes 3/11 as 3 November (day first). */
  dayFirst?: boolean;
}

export interface ImportedRow {
  /** 1-based row number in the sheet, as Excel shows it. */
  row: number;
  customerId: string;
  title: string;
  description: string;
  assignee: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  /** The file's own status word. */
  statusWord: string;
  status: Status;
  priorityWord: string;
  priority: Level;
  category: string;
  remarks: string;
  /** Columns that were not matched, by header name. */
  extra: Record<string, string>;
}

export interface SkippedRow {
  row: number;
  reason: string;
  text: string;
}

export interface ReadResult {
  rows: ImportedRow[];
  skipped: SkippedRow[];
  /** Words in the file that the format does not map yet. */
  unmappedStatus: string[];
  unmappedPriority: string[];
}

const DATE_FIELDS = [
  'plannedStart',
  'plannedEnd',
  'actualStart',
  'actualEnd',
] as const;

/** Status from the actual dates, for files without a status column (spec 02). */
const statusFromDates = (
  r: Pick<ImportedRow, 'actualStart' | 'actualEnd'>,
): Status =>
  r.actualEnd ? 'Done' : r.actualStart ? 'In progress' : 'Not started';

/**
 * Turns the rows under the headers into tasks. A row is a task when its ID
 * cell has a value, or its title cell if the format has no ID column. Other
 * rows, such as blanks, totals and section titles, are skipped and listed.
 */
export function readRows(
  grid: Grid,
  format: FileFormat,
  readDay: string,
): ReadResult {
  const headers = headerNames(grid, format.headerRows);
  const cols = format.columns;
  const start = Math.max(...format.headerRows) + 1;
  const used = new Set(Object.values(cols));
  const rows: ImportedRow[] = [];
  const skipped: SkippedRow[] = [];
  const unmappedStatus = new Set<string>();
  const unmappedPriority = new Set<string>();
  const at = (r: number, f: ImportField) =>
    cols[f] === undefined ? null : (grid[r]?.[cols[f]!] ?? null);
  const keyCol: ImportField =
    cols.customerId !== undefined ? 'customerId' : 'title';

  for (let r = start; r < grid.length; r++) {
    const line = grid[r] ?? [];
    const rowText = line.map(cellText).filter(Boolean).join(' · ');
    const keyText = cellText(at(r, keyCol));
    if (!keyText) {
      if (rowText)
        skipped.push({
          row: r + 1,
          reason: keyCol === 'customerId' ? 'No ID' : 'No title',
          text: rowText,
        });
      continue;
    }
    const title = cellText(at(r, 'title'));
    if (!title) {
      skipped.push({ row: r + 1, reason: 'No title', text: rowText });
      continue;
    }
    const dates = Object.fromEntries(
      DATE_FIELDS.map((f) => [
        f,
        parseDate(at(r, f), readDay, format.dayFirst),
      ]),
    ) as Record<(typeof DATE_FIELDS)[number], string | null>;
    const statusWord = cellText(at(r, 'status'));
    let status: Status;
    if (cols.status === undefined) status = statusFromDates(dates);
    else if (!statusWord) status = 'Not started';
    else if (format.statusWords[statusWord])
      status = format.statusWords[statusWord];
    else {
      unmappedStatus.add(statusWord);
      status = 'Not started';
    }
    const priorityWord = cellText(at(r, 'priority'));
    let priority: Level = 'N';
    if (priorityWord) {
      if (format.priorityWords[priorityWord])
        priority = format.priorityWords[priorityWord];
      else unmappedPriority.add(priorityWord);
    }
    const extra: Record<string, string> = {};
    line.forEach((c, i) => {
      if (used.has(i)) return;
      const t = cellText(c);
      if (t) extra[headers[i] || `Column ${columnLetter(i)}`] = t;
    });
    rows.push({
      row: r + 1,
      customerId: cellText(at(r, 'customerId')),
      title,
      description: cellText(at(r, 'description')),
      assignee: cellText(at(r, 'assignee')),
      ...dates,
      statusWord,
      status,
      priorityWord,
      priority,
      category: cellText(at(r, 'category')),
      remarks: cellText(at(r, 'remarks')),
      extra,
    });
  }
  return {
    rows,
    skipped,
    unmappedStatus: [...unmappedStatus],
    unmappedPriority: [...unmappedPriority],
  };
}

/** A, B, … Z, AA, AB … as Excel names columns. */
export function columnLetter(index: number): string {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ---------------------------------------------------------------- versions

/** Customer fields compared between versions, in the order the review lists them. */
export const COMPARED = [
  'title',
  'description',
  'assignee',
  'plannedStart',
  'plannedEnd',
  'actualStart',
  'actualEnd',
  'statusWord',
  'priorityWord',
  'category',
  'remarks',
] as const;
export type ComparedField = (typeof COMPARED)[number];

export interface FieldChange {
  field: ComparedField | `extra:${string}`;
  from: string;
  to: string;
}

export interface Comparison {
  added: ImportedRow[];
  removed: ImportedRow[];
  changed: {
    before: ImportedRow;
    after: ImportedRow;
    changes: FieldChange[];
  }[];
  unchanged: number;
  /** Matched rows with no change. */
  unchangedPairs: { before: ImportedRow; after: ImportedRow }[];
  /** True when many IDs changed while the titles stayed: the file seems renumbered. */
  looksRenumbered: boolean;
}

const show = (v: string | null) => v ?? '';

/** The fields that differ between two readings of a row. */
export function rowChanges(a: ImportedRow, b: ImportedRow): FieldChange[] {
  return diff(a, b);
}

function diff(a: ImportedRow, b: ImportedRow): FieldChange[] {
  const out: FieldChange[] = [];
  for (const f of COMPARED)
    if (show(a[f]) !== show(b[f]))
      out.push({ field: f, from: show(a[f]), to: show(b[f]) });
  const keys = new Set([...Object.keys(a.extra), ...Object.keys(b.extra)]);
  for (const k of keys)
    if ((a.extra[k] ?? '') !== (b.extra[k] ?? ''))
      out.push({
        field: `extra:${k}`,
        from: a.extra[k] ?? '',
        to: b.extra[k] ?? '',
      });
  return out;
}

/**
 * Matches the rows of two versions (spec 04, Comparing versions): by customer
 * ID, and by exact title for rows without an ID or with an ID used twice.
 * With `byTitle`, every row is matched by title, for a renumbered file.
 */
export function compareVersions(
  before: ImportedRow[],
  after: ImportedRow[],
  byTitle = false,
): Comparison {
  const counts = (rows: ImportedRow[]) => {
    const m = new Map<string, number>();
    for (const r of rows)
      if (r.customerId) m.set(r.customerId, (m.get(r.customerId) ?? 0) + 1);
    return m;
  };
  const cb = counts(before);
  const ca = counts(after);
  const keyOf = (r: ImportedRow, c: Map<string, number>) =>
    !byTitle && r.customerId && c.get(r.customerId) === 1
      ? `id:${r.customerId}`
      : `title:${r.title}`;
  const oldByKey = new Map<string, ImportedRow>();
  for (const r of before)
    if (!oldByKey.has(keyOf(r, cb))) oldByKey.set(keyOf(r, cb), r);

  const added: ImportedRow[] = [];
  const changed: Comparison['changed'] = [];
  const unchangedPairs: Comparison['unchangedPairs'] = [];
  const matched = new Set<ImportedRow>();
  for (const r of after) {
    let old = oldByKey.get(keyOf(r, ca));
    // A row whose ID is now ambiguous can still match an old row by its title.
    if (!old && !byTitle)
      old = before.find(
        (b) =>
          !matched.has(b) &&
          b.title === r.title &&
          (!b.customerId || !r.customerId),
      );
    if (!old || matched.has(old)) {
      added.push(r);
      continue;
    }
    matched.add(old);
    const changes = diff(old, r);
    if (changes.length) changed.push({ before: old, after: r, changes });
    else unchangedPairs.push({ before: old, after: r });
  }
  const removed = before.filter((r) => !matched.has(r));

  // Renumbered: many rows look new and removed, yet their titles match.
  const titlesRemoved = new Set(removed.map((r) => r.title));
  const sameTitle = added.filter((r) => titlesRemoved.has(r.title)).length;
  const looksRenumbered =
    !byTitle &&
    sameTitle >= 3 &&
    sameTitle >= Math.max(added.length, removed.length) * 0.5;
  return {
    added,
    removed,
    changed,
    unchanged: unchangedPairs.length,
    unchangedPairs,
    looksRenumbered,
  };
}
