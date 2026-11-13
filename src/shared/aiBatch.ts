/**
 * Gemini batches (spec 01, Optional AI assistance; spec 06, AI integration).
 *
 * The company allows only the Gemini web app, which takes text pasted in by
 * hand. So the app builds one request for many tasks, the owner pastes it into
 * Gemini, and pastes the answer back. Both steps are plain text with a fixed
 * format, so they can be checked. Everything here is pure; the main process
 * calls it, and a provider that calls an API could later use the same steps.
 */
import { LANGUAGES, type LanguageCode } from './model';

export interface BatchTask {
  taskId: string;
  customerId: string;
  language: LanguageCode;
  title: string;
  description: string;
  /** The owner's current summary, so Gemini can leave a good one alone. */
  summary: string;
}

export interface GlossaryEntry {
  term: string;
  translation: string;
  note: string;
}

export interface Batch {
  /** 1-based number among the batches of one request. */
  number: number;
  of: number;
  /** Request key, as written in the text, → task. */
  keys: Record<string, string>;
  text: string;
}

/** About 20,000 characters, which the Gemini web app accepts comfortably (spec 06). */
export const DEFAULT_BATCH_SIZE = 20_000;

const begin = (key: string, lang?: string) =>
  `=== TASK ${key}${lang ? ` (${lang})` : ''} ===`;
const END = '=== END ===';

/** A key for each task: its number, with #2, #3 for numbers used twice in one batch. */
function keysFor(tasks: BatchTask[]): string[] {
  const seen = new Map<string, number>();
  return tasks.map((t) => {
    const base = (t.customerId || 'NO-ID').replace(/[\s=]/g, '_');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}

function instructions(
  working: string,
  glossary: GlossaryEntry[],
  hasDescriptions: boolean,
): string {
  const lines = [
    `You are helping a project manager understand customer tasks. Translate each task below into ${working}.`,
    '',
    'Rules:',
    `- Translate the title${hasDescriptions ? ' and the description' : ''} into natural ${working}. Keep task numbers, product names, file names, code and anything already in ${working} as it is.`,
    `- Write a SUMMARY of one or two sentences in ${working} that says what the task is really about, for someone who has not read it.`,
    ...(hasDescriptions
      ? [
          '- Keep the description in the same paragraphs as the original, separated by a blank line, so they can be shown side by side.',
        ]
      : []),
    ...(glossary.length
      ? [
          '- Use the glossary translations below exactly, every time the term appears.',
        ]
      : []),
    '- Answer with every task, in the same order, in exactly this format and nothing else:',
    '',
    begin('<the same key as the task>'),
    'TITLE: <the title translated>',
    'SUMMARY: <one or two sentences>',
    ...(hasDescriptions
      ? [
          'DESCRIPTION:',
          '<the description translated, only if the task has one>',
        ]
      : []),
    END,
  ];
  if (glossary.length) {
    lines.push('', 'Glossary:');
    for (const g of glossary)
      lines.push(
        `- ${g.term} = ${g.translation}${g.note ? ` (${g.note})` : ''}`,
      );
  }
  return lines.join('\n');
}

function taskBlock(key: string, t: BatchTask): string {
  const lines = [
    begin(key, LANGUAGES[t.language]),
    `TITLE: ${oneLine(t.title)}`,
  ];
  if (t.description.trim()) lines.push('DESCRIPTION:', t.description.trim());
  lines.push(END);
  return lines.join('\n');
}

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();

/**
 * Builds the requests for a selection of tasks, split so each stays under
 * `maxChars`. Glossary terms are included only where a task in the batch uses them.
 */
export function buildBatches(
  tasks: BatchTask[],
  workingLanguage: LanguageCode,
  glossary: GlossaryEntry[],
  maxChars = DEFAULT_BATCH_SIZE,
): Batch[] {
  const working = LANGUAGES[workingLanguage];
  const groups: BatchTask[][] = [];
  let current: BatchTask[] = [];
  let size = 0;
  const overhead = instructions(working, glossary, true).length + 200;
  for (const t of tasks) {
    const len = taskBlock('X', t).length + 2;
    if (current.length && size + len + overhead > maxChars) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(t);
    size += len;
  }
  if (current.length) groups.push(current);

  return groups.map((group, i) => {
    const keys = keysFor(group);
    const text = group.map((t) => `${t.title}\n${t.description}`).join('\n');
    const used = glossary.filter((g) => g.term && text.includes(g.term));
    const hasDescriptions = group.some((t) => t.description.trim());
    const body = group.map((t, k) => taskBlock(keys[k], t)).join('\n\n');
    return {
      number: i + 1,
      of: groups.length,
      keys: Object.fromEntries(keys.map((k, j) => [k, group[j].taskId])),
      text: `${instructions(working, used, hasDescriptions)}\n\nTasks:\n\n${body}\n`,
    };
  });
}

export interface AnswerItem {
  key: string;
  taskId: string;
  title: string;
  summary: string;
  description: string;
}

export interface ReadAnswer {
  items: AnswerItem[];
  /** Keys in the request with no answer. */
  missing: string[];
  /** Keys in the answer that were not in the request. */
  unknown: string[];
  /** Answers that came back without a title. */
  incomplete: string[];
}

/** Removes what chat answers often add: code fences, bold markers and list bullets. */
function tidy(answer: string): string {
  return answer
    .replace(/\r\n?/g, '\n')
    .replace(/^```[a-z]*\s*$/gim, '')
    .replace(/\*\*(=== [^*]+ ===)\*\*/g, '$1')
    .replace(/^\s*[-*]\s+(?=(TITLE|SUMMARY|DESCRIPTION)\b)/gim, '')
    .replace(/^\s*\*\*(TITLE|SUMMARY|DESCRIPTION)\s*:?\s*\*\*\s*:?/gim, '$1:')
    .replace(/[＝]/g, '=');
}

/**
 * Reads Gemini's answer and checks it against the request: every task should
 * come back once, with a title. Lenient about spacing and chat formatting.
 */
export function readAnswer(
  batch: Pick<Batch, 'keys'>,
  answer: string,
): ReadAnswer {
  const text = tidy(answer);
  const re = /^\s*={2,}\s*TASK\s+(.+?)\s*(?:\([^)]*\))?\s*={2,}\s*$/gim;
  const starts: { key: string; at: number; end: number }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text))
    starts.push({ key: m[1].trim(), at: m.index, end: m.index + m[0].length });
  const items: AnswerItem[] = [];
  const unknown: string[] = [];
  const incomplete: string[] = [];
  const seen = new Set<string>();
  starts.forEach((s, i) => {
    let block = text.slice(
      s.end,
      i + 1 < starts.length ? starts[i + 1].at : text.length,
    );
    block = block.split(/^\s*={2,}\s*END\s*={2,}\s*$/im)[0];
    const field = (name: string, multi: boolean) => {
      const m = block.match(
        new RegExp(
          `^\\s*${name}\\s*[:：]\\s*([\\s\\S]*?)(?=^\\s*(?:TITLE|SUMMARY|DESCRIPTION)\\s*[:：]|$(?![\\s\\S]))`,
          'im',
        ),
      );
      if (!m) return '';
      const v = m[1].trim();
      return multi ? v.replace(/\n{3,}/g, '\n\n') : oneLine(v);
    };
    const key = s.key;
    const taskId = batch.keys[key];
    if (!taskId) {
      unknown.push(key);
      return;
    }
    if (seen.has(key)) return;
    seen.add(key);
    const item = {
      key,
      taskId,
      title: field('TITLE', false),
      summary: field('SUMMARY', false),
      description: field('DESCRIPTION', true),
    };
    if (!item.title) incomplete.push(key);
    items.push(item);
  });
  const missing = Object.keys(batch.keys).filter((k) => !seen.has(k));
  return { items, missing, unknown, incomplete };
}
