/**
 * Discussion tickets (doc 09): comments, replies, files and decisions, and a
 * summary into the linked progress ticket by copy-paste with the AI.
 *
 * Free of Node.js and Electron imports: used by the main process, the
 * screens and tests.
 */
import { LANGUAGES, STATUSES, type LanguageCode, type Status } from './model';

export type DiscussionState = 'open' | 'resolved';

export interface Discussion {
  id: string;
  projectId: string;
  /** The No.; for a linked discussion, the progress ticket's No. */
  no: string;
  /** The progress ticket it is linked to (the same No.), or null. */
  linkedTaskId: string | null;
  title: string;
  description: string;
  state: DiscussionState;
  labels: string[];
  /** Member ids. */
  watchers: string[];
  madeBy: string;
  /** When the last summary was applied, and the newest comment it used (its time). */
  summarizedAt: string | null;
  summarizedUpto: string | null;
  createdAt: string;
  updatedAt: string;
  /** Comments not deleted. */
  commentCount: number;
  /** Comments made or edited after the last summary. */
  newSinceSummary: number;
}

export type DiscussionInput = Pick<
  Discussion,
  'no' | 'title' | 'description' | 'state' | 'labels' | 'watchers'
>;

export interface AttachmentInfo {
  id: string;
  commentId: string | null;
  name: string;
  type: string;
  size: number;
}

export interface Comment {
  id: string;
  discussionId: string;
  /** A reply's comment (one level). */
  parentId: string | null;
  /** Member id. */
  author: string;
  body: string;
  decision: boolean;
  deleted: boolean;
  createdAt: string;
  editedAt: string | null;
  attachments: AttachmentInfo[];
}

/** A comment can be edited for 15 minutes; after that only deleted. */
export const EDIT_MINUTES = 15;
export const canEdit = (c: Comment, nowMs: number) =>
  !c.deleted && nowMs - Date.parse(c.createdAt) < EDIT_MINUTES * 60_000;

/** At most 25 MB per file. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** @names in a comment that are members (by name, case-insensitive). */
export function mentions(
  body: string,
  members: { id: string; name: string }[],
): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/@([^\s@,.;:!?]+)/g)) {
    const w = m[1].toLowerCase();
    const hit = members.filter((x) => x.name.toLowerCase() === w);
    if (hit.length === 1) out.add(hit[0].id);
  }
  return [...out];
}

// ---------------------------------------------------------------- Summarize

export interface SummaryItem {
  /** The No., used as the key of the block. */
  key: string;
  progress: {
    title: string;
    status: Status;
    doingNow: string;
    nextStep: string;
    nextDate: string | null;
    difficulties: string[];
  };
  discussion: {
    title: string;
    description: string;
    /** The last summary applied, if any, in place of older comments. */
    lastSummary: string;
    comments: {
      n: number;
      author: string;
      at: string;
      body: string;
      decision: boolean;
      reply: boolean;
    }[];
    /** Older comments left out to keep the request small. */
    leftOut: number;
  };
}

export interface SummaryBatch {
  number: number;
  of: number;
  keys: string[];
  text: string;
}

const day = (iso: string) => iso.slice(0, 10).replaceAll('-', '/');

function instructions(lang: LanguageCode): string {
  const name = LANGUAGES[lang];
  return [
    `You help a project manager keep progress tickets up to date from team discussions.`,
    `For each ticket below, read the discussion and write the new progress in ${name}, whatever language the comments are in.`,
    `Comments marked [DECISION] are decisions the team made. Do not invent facts that are not in the discussion.`,
    `Answer with exactly one block per ticket, in this format and nothing else:`,
    '',
    '=== TICKET <the same key as the ticket> ===',
    'DOING NOW: <what is being done now, one or two sentences>',
    'SITUATION: <who handles it now, a name from the comments, or empty>',
    'DIFFICULTIES:',
    '- <a new difficulty the discussion raised, one per line, or none>',
    'RESOLVED:',
    '- <a difficulty from the list that the discussion resolved, copied exactly, or none>',
    'NEXT STEP: <the next step>',
    'NEXT DATE: <yyyy/mm/dd, or none>',
    `STATUS: <one of ${STATUSES.filter((s) => s !== 'Cancelled').join(' | ')} | (keep)>`,
    'ACTION ITEMS:',
    '- <a job someone must do, starting with the person when the comments name one, e.g. "Suzuki: test on Stg by 2026/11/21">',
    '=== END ===',
  ].join('\n');
}

function block(i: SummaryItem): string {
  const p = i.progress;
  const d = i.discussion;
  const lines = [
    `=== TICKET ${i.key} ===`,
    `PROGRESS TICKET: ${p.title}`,
    `CURRENT STATUS: ${p.status}`,
    `CURRENT DOING NOW: ${p.doingNow || '(none)'}`,
    `CURRENT NEXT STEP: ${p.nextStep || '(none)'}${p.nextDate ? ` by ${day(p.nextDate)}` : ''}`,
    'OPEN DIFFICULTIES:',
    ...(p.difficulties.length
      ? p.difficulties.map((x) => `- ${x}`)
      : ['- none']),
    `DISCUSSION: ${d.title}`,
  ];
  if (d.description.trim()) lines.push('DESCRIPTION:', d.description.trim());
  if (d.lastSummary.trim())
    lines.push(
      'THE LAST SUMMARY (of the older comments):',
      d.lastSummary.trim(),
    );
  if (d.leftOut)
    lines.push(
      `(${d.leftOut} older comments are left out to keep this short.)`,
    );
  lines.push('COMMENTS:');
  if (!d.comments.length) lines.push('(no new comments)');
  for (const c of d.comments)
    lines.push(
      `#${c.n}${c.reply ? ' (reply)' : ''} ${c.author}, ${day(c.at)}${c.decision ? ' [DECISION]' : ''}: ${c.body.replace(/\s*\n\s*/g, ' / ')}`,
    );
  lines.push('=== END ===');
  return lines.join('\n');
}

/**
 * The requests to paste into the AI: each under `limit` characters; a
 * discussion too long for one keeps its newest comments.
 */
export function buildSummaryBatches(
  items: SummaryItem[],
  lang: LanguageCode,
  limit = 20_000,
): SummaryBatch[] {
  const head = instructions(lang);
  const fitted = items.map((it) => {
    let x = it;
    while (
      head.length + block(x).length + 4 > limit &&
      x.discussion.comments.length > 1
    ) {
      const drop = Math.max(1, Math.ceil(x.discussion.comments.length / 5));
      x = {
        ...x,
        discussion: {
          ...x.discussion,
          comments: x.discussion.comments.slice(drop),
          leftOut: x.discussion.leftOut + drop,
        },
      };
    }
    return x;
  });
  const groups: SummaryItem[][] = [];
  let cur: SummaryItem[] = [];
  let size = head.length;
  for (const it of fitted) {
    const b = block(it).length + 2;
    if (cur.length && size + b > limit) {
      groups.push(cur);
      cur = [];
      size = head.length;
    }
    cur.push(it);
    size += b;
  }
  if (cur.length) groups.push(cur);
  return groups.map((g, i) => ({
    number: i + 1,
    of: groups.length,
    keys: g.map((x) => x.key),
    text: `${head}\n\n${g.map(block).join('\n\n')}`,
  }));
}

export interface SummaryAnswer {
  key: string;
  doingNow: string;
  situation: string;
  difficulties: string[];
  resolved: string[];
  nextStep: string;
  /** yyyy-mm-dd, null for none, undefined when not given. */
  nextDate: string | null | undefined;
  /** null to keep the status. */
  status: Status | null;
  actionItems: string[];
}

export interface SummaryRead {
  answers: SummaryAnswer[];
  /** Keys asked but not answered. */
  missing: string[];
  /** Blocks for keys not asked, or that could not be read, with their text. */
  unreadable: { key: string; text: string }[];
}

const clean = (s: string) =>
  s
    .replace(/^\s*[-*•]\s?/, '')
    .replace(/\*\*/g, '')
    .trim();
const none = (s: string) =>
  /^\(?(none|n\/a|nothing|なし|-)\)?\.?$/i.test(s.trim());

/** Reads the AI's answer; tolerant of chat formatting. Old === TASK blocks are read too. */
export function readSummaryAnswer(text: string, keys: string[]): SummaryRead {
  const out: SummaryRead = { answers: [], missing: [], unreadable: [] };
  const re =
    /^[\s*`]*={2,}\s*(?:TICKET|TASK)\s+(.+?)\s*(?:\([^)]*\))?\s*={2,}[\s*`]*$/gim;
  const starts: { key: string; at: number; end: number }[] = [];
  for (const m of text.matchAll(re))
    starts.push({
      key: m[1].trim(),
      at: m.index!,
      end: m.index! + m[0].length,
    });
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const stop = i + 1 < starts.length ? starts[i + 1].at : text.length;
    let body = text.slice(s.end, stop);
    const endAt = body.search(/^[\s*`]*={2,}\s*END\s*={2,}/im);
    if (endAt >= 0) body = body.slice(0, endAt);
    if (!keys.includes(s.key)) {
      out.unreadable.push({ key: s.key, text: body.trim() });
      continue;
    }
    const a: SummaryAnswer = {
      key: s.key,
      doingNow: '',
      situation: '',
      difficulties: [],
      resolved: [],
      nextStep: '',
      nextDate: undefined,
      status: null,
      actionItems: [],
    };
    let list: string[] | null = null;
    let found = false;
    for (const raw of body.split(/\r?\n/)) {
      const line = raw
        .replace(/\*\*/g, '')
        .replace(/^\s*[-*]\s+(?=[A-Z ]+:)/, '');
      const m =
        /^\s*(DOING NOW|SITUATION|DIFFICULTIES|RESOLVED|NEXT STEP|NEXT DATE|STATUS|ACTION ITEMS)\s*:\s*(.*)$/i.exec(
          line,
        );
      if (m) {
        found = true;
        const field = m[1].toUpperCase();
        const v = m[2].trim();
        list = null;
        if (field === 'DOING NOW') a.doingNow = none(v) ? '' : v;
        else if (field === 'SITUATION') a.situation = none(v) ? '' : v;
        else if (field === 'NEXT STEP') a.nextStep = none(v) ? '' : v;
        else if (field === 'NEXT DATE') {
          const d = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(v);
          a.nextDate = d
            ? `${d[1]}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')}`
            : none(v) || !v
              ? null
              : undefined;
        } else if (field === 'STATUS') {
          const st = STATUSES.find((x) => x.toLowerCase() === v.toLowerCase());
          a.status = st ?? null;
        } else {
          list =
            field === 'DIFFICULTIES'
              ? a.difficulties
              : field === 'RESOLVED'
                ? a.resolved
                : a.actionItems;
          if (v && !none(v)) list.push(clean(v));
        }
        continue;
      }
      if (list && /^\s*[-*•]/.test(raw)) {
        const v = clean(raw);
        if (v && !none(v)) list.push(v);
      }
    }
    if (!found) out.unreadable.push({ key: s.key, text: body.trim() });
    else if (!out.answers.some((x) => x.key === a.key)) out.answers.push(a);
  }
  out.missing = keys.filter((k) => !out.answers.some((a) => a.key === k));
  return out;
}

/** "Suzuki: test on Stg by 2026/11/21" → who, what and when, as far as found. */
export function readActionItem(
  item: string,
  members: { id: string; name: string }[],
): { title: string; assignee: string; dueDate: string | null } {
  let title = item.trim();
  let assignee = '';
  const m = /^([^:：]{1,40})[:：]\s*(.+)$/.exec(title);
  if (m) {
    const who = m[1].trim().toLowerCase();
    const hit = members.filter(
      (x) =>
        x.name.toLowerCase() === who ||
        who.split(/\s+/).includes(x.name.toLowerCase()),
    );
    if (hit.length === 1) {
      assignee = hit[0].id;
      title = m[2].trim();
    }
  }
  let dueDate: string | null = null;
  const d =
    /\s*(?:by|until|due|まで)?\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s*(?:まで)?/i.exec(
      title,
    );
  if (d) {
    dueDate = `${d[1]}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')}`;
    title = (title.slice(0, d.index) + title.slice(d.index + d[0].length))
      .replace(/\s+/g, ' ')
      .trim();
  }
  return { title, assignee, dueDate };
}
