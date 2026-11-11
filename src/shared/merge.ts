/**
 * Merging two copies of a project (spec: merge).
 *
 * Each side is the project's rows by table, in "uid space": a row's `id` is
 * the id it has in every copy, and its links to other rows (task_id,
 * project_id…) use those ids too. The main process turns database rows and
 * .worksync files into this form and back.
 *
 * With the common starting point (the last file the two copies exchanged), a
 * change only one side made is taken without asking; only where both sides
 * changed the same thing is there a question. Without one, every difference
 * is a question, and rows only one side has are added.
 *
 * Free of Node.js and Electron imports: used by the main process and tests.
 */
import { LEVEL_NAME, type Level } from './model';

export type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;
export type Pick = 'mine' | 'theirs' | 'both';

export interface MergeInput {
  mine: Tables;
  theirs: Tables;
  /** The project as both copies last had it; null before the first merge. */
  base: Tables | null;
  /** False when the file was exported without the owner's notes. */
  theirsHasNotes: boolean;
}

/** What the owner chose; anything not given takes its suggestion. */
export interface MergeChoices {
  answers?: Record<string, Pick>;
  /** Automatic items and situation updates (upd:<id>) left out. */
  off?: string[];
}

/** Where a question or item is: a task, the project, a note… */
export interface Where {
  kind: 'project' | 'task' | 'term' | 'person' | 'note';
  /** The task number, if any. */
  no: string;
  name: string;
}

export interface AutoItem {
  id: string;
  /** What kind of change, in English (translated by the page). */
  tag:
    | 'New task'
    | 'Changes'
    | 'Deleted'
    | 'Situation updates'
    | 'Difficulty'
    | 'Glossary'
    | 'Person'
    | 'Note'
    | 'Project';
  where: Where;
  /** The fields that change, as English labels. */
  fields: string[];
  /** A short detail from the data itself (a term, a difficulty…). */
  detail: string;
  /** For situation updates: how many. */
  count: number;
}

interface QuestionBase {
  id: string;
  where: Where;
  /** When each side last changed it, if known (ISO). */
  mineAt: string | null;
  theirsAt: string | null;
  /** The suggestion: the newer side, or yours when unknown. */
  suggest: Pick;
  /** For a task: its other fields on both sides, to see the whole task. */
  context?: { field: string; mine: string; theirs: string }[];
}

export type Question =
  | (QuestionBase & {
      kind: 'field';
      /** The field, as an English label. */
      field: string;
      mine: string;
      theirs: string;
      /** The values are status or priority words, which the page translates. */
      words: boolean;
    })
  | (QuestionBase & {
      kind: 'deleted';
      /** Who deleted it; the other side changed it since. */
      by: 'mine' | 'theirs';
      fields: string[];
    })
  | (QuestionBase & {
      kind: 'timeline';
      updates: {
        id: string;
        at: string;
        side: 'mine' | 'theirs' | 'both';
        handledBy: string;
        doingNow: string;
        nextStep: string;
        nextDate: string;
      }[];
    })
  | (QuestionBase & {
      kind: 'note';
      field: string;
      mine: string;
      theirs: string;
      /** The note as it would be with each answer. */
      results: Record<Pick, string>;
    });

export interface MergeResult {
  auto: AutoItem[];
  questions: Question[];
  /** The merged project, in uid space. */
  tables: Tables;
}

// ------------------------------------------------------------ values

const text = (v: unknown): string =>
  v === null || v === undefined ? '' : String(v);
const same = (a: unknown, b: unknown) => text(a) === text(b);

const list = <T = string>(v: unknown): T[] => {
  try {
    const x = JSON.parse(text(v) || '[]');
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
};

/** A value as the owner reads it. */
export function shown(field: string, v: unknown): string {
  const s = text(v);
  if (!s) return '';
  if (field === 'priority' || field === 'priority_override')
    return LEVEL_NAME[s as Level] ?? s;
  if (field === 'labels' || field === 'tags' || field === 'spellings')
    return list(s).join(' · ');
  if (field === 'original_languages') return list(s).join(', ');
  if (field === 'links')
    return list<{ name?: string; target?: string }>(s)
      .map((l) => l.name || l.target || '')
      .join('\n');
  if (field === 'open') return s === '1' ? 'Open' : 'Resolved';
  if (field === 'pinned' || field === 'show_numbers')
    return s === '1' ? 'Yes' : 'No';
  return s;
}

const LABELS: Record<string, string> = {
  name: 'Name',
  customer: 'Customer',
  original_languages: 'File languages',
  working_language: 'Working language',
  due_soon_days: 'Due soon (days)',
  date_format: 'Report date format',
  show_numbers: 'Show task numbers',
  customer_id: 'Number',
  language: 'Language',
  title_original: 'Title',
  title_translation: 'Title (translation)',
  description_original: 'Description',
  description_translation: 'Description (translation)',
  summary: 'Summary',
  notes: 'My notes',
  status: 'Status',
  priority: 'Priority',
  priority_override: 'Priority (set by hand)',
  labels: 'Labels',
  assignee: 'Assignee',
  category: 'Category',
  remarks: 'Remarks',
  planned_start: 'Planned start',
  planned_end: 'Planned end',
  actual_start: 'Actual start',
  actual_end: 'Actual end',
  next_action: 'Next action',
  next_action_date: 'Next action date',
  links: 'Links',
  board_column: 'Board column',
  text: 'Difficulty',
  resolver: 'Who resolves it',
  open: 'Open or resolved',
  raised_on: 'Raised on',
  term: 'Term',
  translation: 'Translation',
  note: 'Note',
  display_name: 'Shown as',
  side: 'Side',
  spellings: 'Other spellings',
  title: 'Title',
  body: 'Text',
  tags: 'Tags',
  handled_by: 'Handled by',
  doing_now: 'Doing now',
  next_step: 'Next step',
  next_date: 'Next step date',
};
export const fieldLabel = (f: string) => LABELS[f] ?? f;

// ------------------------------------------------------------ lines

/** Indexes of a longest common subsequence: for each a[i], its b index or -1. */
function lcs(a: string[], b: string[]): number[] {
  const n = a.length;
  const m = b.length;
  const match = Array.from({ length: n }, () => -1);
  if (!n || !m || n * m > 4_000_000) return match;
  const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i][j] =
        a[i] === b[j]
          ? t[i + 1][j + 1] + 1
          : Math.max(t[i + 1][j], t[i][j + 1]);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) {
      match[i] = j;
      i++;
      j++;
    } else if (t[i + 1][j] >= t[i][j + 1]) i++;
    else j++;
  }
  return match;
}

export type Chunk =
  | { kind: 'same'; lines: string[] }
  | { kind: 'conflict'; mine: string[]; theirs: string[] };

const eqLines = (x: string[], y: string[]) =>
  x.length === y.length && x.every((l, i) => l === y[i]);

/**
 * A three-way merge of lines. Lines only one side changed are taken; where
 * both changed the same place differently, a conflict chunk holds both.
 * Without a starting point, the lines both sides share stand in for it.
 */
export function mergeLines(
  base: string | null,
  mine: string,
  theirs: string,
): Chunk[] {
  const a = mine.split('\n');
  const b = theirs.split('\n');
  let o: string[];
  if (base === null) {
    const m = lcs(a, b);
    o = a.filter((_, i) => m[i] >= 0);
  } else o = base.split('\n');
  const ma = lcs(o, a);
  const mb = lcs(o, b);
  const out: Chunk[] = [];
  const keep = (lines: string[]) => {
    if (!lines.length) return;
    const last = out[out.length - 1];
    if (last?.kind === 'same') last.lines.push(...lines);
    else out.push({ kind: 'same', lines: [...lines] });
  };
  let io = 0;
  let ia = 0;
  let ib = 0;
  for (;;) {
    if (io < o.length && ma[io] === ia && mb[io] === ib) {
      keep([o[io]]);
      io++;
      ia++;
      ib++;
      continue;
    }
    let j = io;
    while (j < o.length && !(ma[j] >= ia && mb[j] >= ib)) j++;
    const ea = j < o.length ? ma[j] : a.length;
    const eb = j < o.length ? mb[j] : b.length;
    const O = o.slice(io, j);
    const A = a.slice(ia, ea);
    const B = b.slice(ib, eb);
    if (eqLines(A, O)) keep(B);
    else if (eqLines(B, O)) keep(A);
    else if (eqLines(A, B)) keep(A);
    else out.push({ kind: 'conflict', mine: A, theirs: B });
    if (j >= o.length) break;
    io = j;
    ia = ea;
    ib = eb;
  }
  return out;
}

/** The merged text, with conflicts settled one way. */
export function resolveLines(chunks: Chunk[], pick: Pick): string {
  return chunks
    .flatMap((c) =>
      c.kind === 'same'
        ? c.lines
        : pick === 'mine'
          ? c.mine
          : pick === 'theirs'
            ? c.theirs
            : [...c.mine, ...c.theirs],
    )
    .join('\n');
}

// ------------------------------------------------------------ the merge

const byId = (rows: Row[] | undefined) =>
  new Map((rows ?? []).map((r) => [text(r.id), r]));

/** Task fields, by how they merge. */
const TASK_ASKED = [
  'customer_id',
  'title_original',
  'title_translation',
  'description_original',
  'description_translation',
  'summary',
  'status',
  'priority',
  'priority_override',
  'labels',
  'assignee',
  'category',
  'remarks',
  'planned_start',
  'planned_end',
  'actual_start',
  'actual_end',
  'links',
  'board_column',
  'language',
];
const TASK_OWNER = ['notes', 'next_action', 'next_action_date'];
/** Merged, but a clash keeps yours without asking: they follow other fields. */
const TASK_QUIET = [
  'translation_state',
  'status_word',
  'priority_word',
  'extra',
  'source',
  'language_set',
];
const SITUATION = [
  'handled_by',
  'doing_now',
  'waiting_on',
  'next_step',
  'next_date',
  'as_of',
];
// The name is not merged: each copy may be called something else here.
const PROJECT_ASKED = [
  'customer',
  'original_languages',
  'working_language',
  'due_soon_days',
  'date_format',
  'show_numbers',
];

export function mergeProject(
  input: MergeInput,
  choices: MergeChoices = {},
): MergeResult {
  const answers = choices.answers ?? {};
  const off = new Set(choices.off ?? []);
  const auto: AutoItem[] = [];
  const questions: Question[] = [];
  const out: Tables = {};
  const M = (t: string) => byId(input.mine[t]);
  const T = (t: string) => byId(input.theirs[t]);
  const B = (t: string) => (input.base ? byId(input.base[t]) : null);

  const taskWhere = (r: Row): Where => ({
    kind: 'task',
    no: text(r.customer_id),
    name: text(r.title_translation) || text(r.title_original),
  });
  const answer = (q: Question): Pick => answers[q.id] ?? q.suggest;
  const newer = (m: unknown, t: unknown): Pick =>
    text(t) > text(m) ? 'theirs' : 'mine';

  /**
   * Merges the fields of one row both sides have. Returns the row, the fields
   * taken from theirs automatically, and asks where both changed a field.
   */
  const mergeFields = (o: {
    table: string;
    id: string;
    m: Row;
    t: Row;
    b: Row | undefined;
    asked: string[];
    quiet: string[];
    where: Where;
    mineAt: string | null;
    theirsAt: string | null;
  }): { row: Row; taken: string[] } => {
    const row: Row = { ...o.m };
    const taken: string[] = [];
    const changeId = `chg:${o.table}:${o.id}`;
    for (const f of [...o.asked, ...o.quiet]) {
      const mv = o.m[f];
      const tv = o.t[f];
      if (same(mv, tv)) continue;
      const bv = o.b ? o.b[f] : undefined;
      if (o.b && same(bv, mv)) {
        // Only theirs changed it.
        if (!off.has(changeId)) row[f] = tv;
        if (o.asked.includes(f)) taken.push(fieldLabel(f));
        continue;
      }
      if (o.b && same(bv, tv)) continue; // only yours changed it
      if (o.quiet.includes(f)) continue; // keeps yours
      const q: Question = {
        id: `q:${o.table}:${o.id}:${f}`,
        kind: 'field',
        where: o.where,
        field: fieldLabel(f),
        mine: shown(f, mv),
        theirs: shown(f, tv),
        words: f === 'status' || f === 'priority' || f === 'priority_override',
        mineAt: o.mineAt,
        theirsAt: o.theirsAt,
        suggest: o.mineAt && o.theirsAt ? newer(o.mineAt, o.theirsAt) : 'mine',
      };
      questions.push(q);
      if (answer(q) === 'theirs') row[f] = tv;
    }
    if (taken.length)
      auto.push({
        id: changeId,
        tag: o.where.kind === 'project' ? 'Project' : 'Changes',
        where: o.where,
        fields: taken,
        detail: '',
        count: 0,
      });
    return { row, taken };
  };

  /**
   * Rows of a table: both sides' rows matched by id. Rows only one side has
   * are kept, added, or deleted, as the starting point shows.
   */
  const mergeTable = (o: {
    table: string;
    asked: string[];
    quiet: string[];
    where: (r: Row) => Where;
    at?: (r: Row) => string | null;
    keep?: (r: Row) => boolean;
    added?: (r: Row) => AutoItem | null;
    /** Fields that differ from the starting point, to tell a changed row. */
    changedSince?: string[];
  }): Row[] => {
    const mine = M(o.table);
    const theirs = T(o.table);
    const base = B(o.table);
    const ids = [...new Set([...mine.keys(), ...theirs.keys()])];
    const rows: Row[] = [];
    const changed = (r: Row, b: Row) =>
      (o.changedSince ?? [...o.asked, ...o.quiet]).some(
        (f) => !same(r[f], b[f]),
      );
    for (const id of ids) {
      const m = mine.get(id);
      const t = theirs.get(id);
      const b = base?.get(id);
      if (o.keep && !o.keep(m ?? t!)) {
        if (m) rows.push(m);
        continue;
      }
      if (m && t) {
        rows.push(
          mergeFields({
            table: o.table,
            id,
            m,
            t,
            b,
            asked: o.asked,
            quiet: o.quiet,
            where: o.where(m),
            mineAt: o.at?.(m) ?? null,
            theirsAt: o.at?.(t) ?? null,
          }).row,
        );
      } else if (m) {
        if (!b) {
          rows.push(m); // yours, new
          continue;
        }
        // They deleted it.
        if (changed(m, b)) {
          const q: Question = {
            id: `q:${o.table}:${id}:deleted`,
            kind: 'deleted',
            where: o.where(m),
            by: 'theirs',
            fields: [...o.asked]
              .filter((f) => !same(m[f], b[f]))
              .map(fieldLabel),
            mineAt: o.at?.(m) ?? null,
            theirsAt: null,
            suggest: 'mine',
          };
          questions.push(q);
          if (answer(q) !== 'theirs') rows.push(m);
        } else {
          const item: AutoItem = {
            id: `del:${o.table}:${id}`,
            tag: 'Deleted',
            where: o.where(m),
            fields: [],
            detail: '',
            count: 0,
          };
          auto.push(item);
          if (off.has(item.id)) rows.push(m);
        }
      } else if (t) {
        if (b) {
          // You deleted it.
          if (changed(t, b)) {
            const q: Question = {
              id: `q:${o.table}:${id}:deleted`,
              kind: 'deleted',
              where: o.where(t),
              by: 'mine',
              fields: [...o.asked]
                .filter((f) => !same(t[f], b[f]))
                .map(fieldLabel),
              mineAt: null,
              theirsAt: o.at?.(t) ?? null,
              suggest: 'mine',
            };
            questions.push(q);
            if (answer(q) === 'theirs') rows.push(t);
          }
          continue;
        }
        const item = o.added?.(t) ?? null;
        if (item) {
          auto.push(item);
          if (!off.has(item.id)) rows.push(t);
        } else rows.push(t);
      }
    }
    return rows;
  };

  // The project itself.
  const pm = input.mine.projects?.[0];
  const pt = input.theirs.projects?.[0];
  if (pm && pt) {
    const pb = input.base?.projects?.[0];
    out.projects = [
      mergeFields({
        table: 'projects',
        id: text(pm.id),
        m: pm,
        t: pt,
        b: pb,
        asked: PROJECT_ASKED,
        quiet: ['board'],
        where: { kind: 'project', no: '', name: text(pm.name) },
        mineAt: null,
        theirsAt: null,
      }).row,
    ];
  } else out.projects = pm ? [pm] : [];

  // Source files: yours stay; ones only theirs has come along (their tasks may use them).
  out.source_files = [
    ...(input.mine.source_files ?? []),
    ...(input.theirs.source_files ?? []).filter(
      (s) => !M('source_files').has(text(s.id)),
    ),
  ];
  const sourceIds = new Set(out.source_files.map((s) => text(s.id)));
  out.file_versions = [
    ...(input.mine.file_versions ?? []),
    ...(input.theirs.file_versions ?? []).filter(
      (v) =>
        !M('source_files').has(text(v.source_id)) &&
        sourceIds.has(text(v.source_id)),
    ),
  ];

  // Tasks.
  const ownerFields = input.theirsHasNotes ? TASK_OWNER : [];
  out.tasks = mergeTable({
    table: 'tasks',
    asked: [...TASK_ASKED, ...ownerFields],
    quiet: TASK_QUIET,
    where: taskWhere,
    at: (r) => text(r.updated_at) || null,
    changedSince: [...TASK_ASKED, ...ownerFields, ...SITUATION],
    added: (t) => ({
      id: `add:tasks:${text(t.id)}`,
      tag: 'New task',
      where: taskWhere(t),
      fields: [],
      detail: '',
      count: 0,
    }),
  });
  const taskIds = new Set(out.tasks.map((t) => text(t.id)));
  const mineTasks = M('tasks');
  const tasksById = new Map(out.tasks.map((t) => [text(t.id), t]));
  // A task that came from theirs keeps its link to a file only if the file came too.
  for (const t of out.tasks)
    if (t.source_file_id && !sourceIds.has(text(t.source_file_id)))
      t.source_file_id = null;

  // Situation updates: both sides' updates, by date. Where both added some,
  // the owner keeps or drops each one.
  const um = M('situation_updates');
  const ut = T('situation_updates');
  const ub = B('situation_updates');
  const updates: Row[] = [];
  const byTask = new Map<string, { m: Row[]; t: Row[]; both: Row[] }>();
  const slot = (task: string) => {
    let s = byTask.get(task);
    if (!s) byTask.set(task, (s = { m: [], t: [], both: [] }));
    return s;
  };
  for (const [id, r] of um) {
    const task = text(r.task_id);
    if (ut.has(id)) slot(task).both.push(r);
    else if (!(ub && ub.has(id))) slot(task).m.push(r);
    // (an update you have that theirs dropped: kept)
    else slot(task).both.push(r);
  }
  for (const [id, r] of ut)
    if (!um.has(id) && !(ub && ub.has(id))) slot(text(r.task_id)).t.push(r);
  for (const [task, s] of byTask) {
    if (!taskIds.has(task)) continue;
    const t = tasksById.get(task)!;
    const newTask = !mineTasks.has(task);
    if (s.m.length && s.t.length) {
      const all = [...s.both, ...s.m, ...s.t].sort((x, y) =>
        text(x.at).localeCompare(text(y.at)),
      );
      const firstNew = all.findIndex((r) => !s.both.includes(r));
      const shownRows = all.slice(Math.max(0, firstNew - 1));
      questions.push({
        id: `q:updates:${task}`,
        kind: 'timeline',
        where: taskWhere(t),
        mineAt: null,
        theirsAt: null,
        suggest: 'both',
        updates: shownRows.map((r) => ({
          id: text(r.id),
          at: text(r.at),
          side: s.both.includes(r)
            ? 'both'
            : s.m.includes(r)
              ? 'mine'
              : 'theirs',
          handledBy: text(r.handled_by),
          doingNow: text(r.doing_now),
          nextStep: text(r.next_step),
          nextDate: text(r.next_date),
        })),
      });
      updates.push(
        ...s.both,
        ...[...s.m, ...s.t].filter((r) => !off.has(`upd:${text(r.id)}`)),
      );
    } else if (s.t.length && !newTask) {
      const item: AutoItem = {
        id: `upd:task:${task}`,
        tag: 'Situation updates',
        where: taskWhere(t),
        fields: [],
        detail: '',
        count: s.t.length,
      };
      auto.push(item);
      updates.push(...s.both, ...s.m, ...(off.has(item.id) ? [] : s.t));
    } else updates.push(...s.both, ...s.m, ...s.t);
  }
  // An update both have but changed differently (a mistake fixed): theirs if only they fixed it.
  out.situation_updates = updates.map((r) => {
    const id = text(r.id);
    const m = um.get(id);
    const t = ut.get(id);
    const b = ub?.get(id);
    if (!m || !t || !b) return r;
    const row = { ...m };
    for (const f of ['handled_by', 'doing_now', 'next_step', 'next_date'])
      if (!same(m[f], t[f]) && same(m[f], b[f])) row[f] = t[f];
    return row;
  });
  // The current situation is the newest update kept.
  const newest = new Map<string, Row>();
  for (const r of out.situation_updates) {
    const task = text(r.task_id);
    const n = newest.get(task);
    if (!n || text(r.at) > text(n.at)) newest.set(task, r);
  }
  for (const t of out.tasks) {
    const n = newest.get(text(t.id));
    if (!n) continue;
    for (const f of SITUATION) t[f] = n[f];
  }

  // Difficulties.
  out.difficulties = mergeTable({
    table: 'difficulties',
    asked: ['text', 'resolver', 'open'],
    quiet: ['raised_on', 'position'],
    where: (r) => {
      const t =
        tasksById.get(text(r.task_id)) ?? T('tasks').get(text(r.task_id));
      return t ? taskWhere(t) : { kind: 'task', no: '', name: '' };
    },
    keep: (r) => taskIds.has(text(r.task_id)),
    added: (r) =>
      mineTasks.has(text(r.task_id))
        ? {
            id: `add:difficulties:${text(r.id)}`,
            tag: 'Difficulty',
            where: taskWhere(tasksById.get(text(r.task_id))!),
            fields: [],
            detail: text(r.text),
            count: 0,
          }
        : null,
  }).filter((r) => taskIds.has(text(r.task_id)));

  // History: everything either side recorded.
  const am = M('activity');
  out.activity = [
    ...am.values(),
    ...[...T('activity').values()].filter((r) => !am.has(text(r.id))),
  ].filter((r) => taskIds.has(text(r.task_id)));

  // Glossary and people.
  out.glossary_terms = mergeTable({
    table: 'glossary_terms',
    asked: ['term', 'translation', 'note'],
    quiet: ['language'],
    where: (r) => ({ kind: 'term', no: '', name: text(r.term) }),
    added: (r) => ({
      id: `add:glossary_terms:${text(r.id)}`,
      tag: 'Glossary',
      where: { kind: 'term', no: '', name: text(r.term) },
      fields: [],
      detail: text(r.translation),
      count: 0,
    }),
  });
  out.people = mergeTable({
    table: 'people',
    asked: ['name', 'display_name', 'side', 'spellings'],
    quiet: [],
    where: (r) => ({ kind: 'person', no: '', name: text(r.name) }),
    added: (r) => ({
      id: `add:people:${text(r.id)}`,
      tag: 'Person',
      where: { kind: 'person', no: '', name: text(r.name) },
      fields: [],
      detail: text(r.display_name),
      count: 0,
    }),
  });

  // Notes: the text merges line by line.
  if (input.theirsHasNotes) {
    const nm = M('notes');
    const nt = T('notes');
    const nb = B('notes');
    const noteWhere = (r: Row): Where => ({
      kind: 'note',
      no: '',
      name: text(r.title),
    });
    const notes = mergeTable({
      table: 'notes',
      asked: ['title', 'tags'],
      quiet: [],
      changedSince: ['title', 'tags', 'body'],
      where: noteWhere,
      at: (r) => text(r.updated_at) || null,
      added: (r) => ({
        id: `add:notes:${text(r.id)}`,
        tag: 'Note',
        where: noteWhere(r),
        fields: [],
        detail: '',
        count: 0,
      }),
    });
    for (const r of notes) {
      const id = text(r.id);
      const m = nm.get(id);
      const t = nt.get(id);
      if (!m || !t || same(m.body, t.body)) continue;
      const b = nb?.get(id);
      const chunks = mergeLines(
        b ? text(b.body) : null,
        text(m.body),
        text(t.body),
      );
      const conflicts = chunks.some((c) => c.kind === 'conflict');
      if (conflicts) {
        const q: Question = {
          id: `q:notes:${id}:body`,
          kind: 'note',
          where: noteWhere(m),
          field: 'Text',
          mine: text(m.body),
          theirs: text(t.body),
          results: {
            mine: resolveLines(chunks, 'mine'),
            theirs: resolveLines(chunks, 'theirs'),
            both: resolveLines(chunks, 'both'),
          },
          mineAt: text(m.updated_at) || null,
          theirsAt: text(t.updated_at) || null,
          suggest: newer(m.updated_at, t.updated_at),
        };
        questions.push(q);
        r.body = q.results[answer(q)];
      } else {
        const merged = resolveLines(chunks, 'mine');
        if (merged === text(m.body)) continue;
        const changeId = `chg:notes:${id}`;
        const item = auto.find((a) => a.id === changeId);
        if (item) item.fields.push('Text');
        else
          auto.push({
            id: changeId,
            tag: 'Note',
            where: noteWhere(m),
            fields: ['Text'],
            detail: '',
            count: 0,
          });
        if (!off.has(changeId)) r.body = merged;
      }
    }
    out.notes = notes;
  } else out.notes = input.mine.notes ?? [];

  // Translations of the owner's text: the newer of each.
  const key = (r: Row) =>
    `${text(r.task_id)}|${text(r.field)}|${text(r.language)}`;
  const tr = new Map<string, Row>();
  for (const r of input.mine.owner_translations ?? []) tr.set(key(r), r);
  for (const r of input.theirs.owner_translations ?? []) {
    const k = key(r);
    const m = tr.get(k);
    if (!m || text(r.at) > text(m.at)) tr.set(k, r);
  }
  out.owner_translations = [...tr.values()].filter((r) =>
    taskIds.has(text(r.task_id)),
  );

  // Rows of the customer's file either side deleted on purpose.
  const dk = (r: Row) =>
    `${text(r.source_id)}|${text(r.customer_id)}|${text(r.title)}`;
  const dr = new Map<string, Row>();
  for (const r of [
    ...(input.mine.deleted_rows ?? []),
    ...(input.theirs.deleted_rows ?? []),
  ])
    if (sourceIds.has(text(r.source_id)) && !dr.has(dk(r))) dr.set(dk(r), r);
  out.deleted_rows = [...dr.values()];

  // Each question about a task carries the rest of the task, both sides.
  const tm = M('tasks');
  const tt = T('tasks');
  for (const q of questions) {
    const m = /^q:(tasks|updates):([^:]+)/.exec(q.id);
    if (!m) continue;
    const a = tm.get(m[2]);
    const b = tt.get(m[2]);
    q.context = [...TASK_ASKED, ...ownerFields]
      .filter((f) => !(q.kind === 'field' && q.id.endsWith(`:${f}`)))
      .map((f) => ({
        field: fieldLabel(f),
        mine: a ? shown(f, a[f]) : '',
        theirs: b ? shown(f, b[f]) : '',
      }))
      .filter((c) => c.mine || c.theirs);
  }

  return { auto, questions, tables: out };
}
