/**
 * Translating the owner's own text into the file's language (spec 05,
 * Reports): summaries, situations, next steps and difficulties are written in
 * the working language, and a report or brief in the customer's language
 * needs them translated. Same copy-and-paste flow as the task batches, with
 * its own fixed format. Pure, like aiBatch.
 */
import { LANGUAGES, type LanguageCode, type Task } from './model';
import { DEFAULT_BATCH_SIZE, type GlossaryEntry } from './aiBatch';

/** A field of the owner's text: summary, doingNow, nextStep or difficulty:<id>. */
export type OwnerField = string;

export interface OwnerTranslation {
  taskId: string;
  field: OwnerField;
  language: LanguageCode;
  /** The text as it was when translated; a changed text needs a new translation. */
  source: string;
  text: string;
}

export interface OwnerPart {
  field: OwnerField;
  label: string;
  source: string;
}

export interface OwnerBatch {
  number: number;
  of: number;
  language: LanguageCode;
  /** Request key → the task and its parts, in order. */
  keys: Record<string, { taskId: string; parts: OwnerPart[] }>;
  text: string;
}

/** The owner's texts of a task, each with the label used in the request. */
export function ownerParts(t: Task): OwnerPart[] {
  const parts: OwnerPart[] = [
    { field: 'summary', label: 'SUMMARY', source: t.summary },
    { field: 'doingNow', label: 'DOING NOW', source: t.situation.doingNow },
    { field: 'nextStep', label: 'NEXT STEP', source: t.situation.nextStep },
    ...t.difficulties
      .filter((d) => d.open)
      .map((d, i) => ({
        field: `difficulty:${d.id}`,
        label: `DIFFICULTY ${i + 1}`,
        source: d.text,
      })),
  ];
  return parts.filter((p) => p.source.trim());
}

/** The parts with no translation for their current text. */
export function untranslated(
  t: Task,
  done: OwnerTranslation[],
  language: LanguageCode,
): OwnerPart[] {
  return ownerParts(t).filter(
    (p) =>
      !done.some(
        (d) =>
          d.taskId === t.id &&
          d.field === p.field &&
          d.language === language &&
          d.source === p.source,
      ),
  );
}

/** Source text → translation, for the translations that still match their text. */
export function translationMap(
  tasks: Task[],
  done: OwnerTranslation[],
  language: LanguageCode,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const t of tasks)
    for (const p of ownerParts(t)) {
      const d = done.find(
        (x) =>
          x.taskId === t.id &&
          x.field === p.field &&
          x.language === language &&
          x.source === p.source,
      );
      if (d) map[p.source] = d.text;
    }
  return map;
}

const begin = (key: string) => `=== TASK ${key} ===`;
const END = '=== END ===';
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();

function instructions(
  from: string,
  to: string,
  glossary: GlossaryEntry[],
): string {
  const lines = [
    `You are helping a project manager report to a customer. Translate the notes below from ${from} into ${to}, in the polite business style used in reports to customers.`,
    '',
    'Rules:',
    `- Translate every line after its label. Keep task numbers, product names, file names and code as they are.`,
    '- Keep each answer to one line, like the original.',
    ...(glossary.length
      ? ['- Use the glossary terms below exactly, every time the word appears.']
      : []),
    '- Answer with every task, in the same order, with the same labels, in exactly this format and nothing else:',
    '',
    begin('<the same key as the task>'),
    '<LABEL>: <the line translated>',
    END,
  ];
  if (glossary.length) {
    lines.push('', 'Glossary:');
    for (const g of glossary) lines.push(`- ${g.translation} = ${g.term}`);
  }
  return lines.join('\n');
}

/**
 * Builds the requests for the parts that need translating, split so each
 * stays under `maxChars`. The glossary goes the other way: working-language
 * word = the customer's term.
 */
export function buildOwnerBatches(
  items: { task: Task; parts: OwnerPart[] }[],
  from: LanguageCode,
  to: LanguageCode,
  glossary: GlossaryEntry[],
  maxChars = DEFAULT_BATCH_SIZE,
): OwnerBatch[] {
  const block = (key: string, parts: OwnerPart[]) =>
    [
      begin(key),
      ...parts.map((p) => `${p.label}: ${oneLine(p.source)}`),
      END,
    ].join('\n');
  const list = items.filter((x) => x.parts.length);
  const overhead =
    instructions(LANGUAGES[from], LANGUAGES[to], glossary).length + 200;
  const groups: (typeof list)[] = [];
  let current: typeof list = [];
  let size = 0;
  for (const x of list) {
    const len = block('X', x.parts).length + 2;
    if (current.length && size + len + overhead > maxChars) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(x);
    size += len;
  }
  if (current.length) groups.push(current);

  return groups.map((group, i) => {
    const seen = new Map<string, number>();
    const keyed = group.map((x) => {
      const base = (x.task.customerId || 'NO-ID').replace(/[\s=]/g, '_');
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return { key: n === 1 ? base : `${base}#${n}`, ...x };
    });
    const text = keyed
      .map((x) => x.parts.map((p) => p.source).join('\n'))
      .join('\n');
    const used = glossary.filter(
      (g) =>
        g.translation &&
        text.toLowerCase().includes(g.translation.toLowerCase()),
    );
    return {
      number: i + 1,
      of: groups.length,
      language: to,
      keys: Object.fromEntries(
        keyed.map((x) => [x.key, { taskId: x.task.id, parts: x.parts }]),
      ),
      text: `${instructions(LANGUAGES[from], LANGUAGES[to], used)}\n\nTasks:\n\n${keyed
        .map((x) => block(x.key, x.parts))
        .join('\n\n')}\n`,
    };
  });
}

export interface OwnerAnswer {
  translations: OwnerTranslation[];
  /** Keys in the request with no answer at all. */
  missing: string[];
  /** Lines asked for that came back empty or not at all, as "key LABEL". */
  incomplete: string[];
  unknown: string[];
}

/** Reads the answer, leniently about chat formatting, and checks it against the request. */
export function readOwnerAnswer(
  batch: Pick<OwnerBatch, 'keys' | 'language'>,
  answer: string,
): OwnerAnswer {
  const text = answer
    .replace(/\r\n?/g, '\n')
    .replace(/^```[a-z]*\s*$/gim, '')
    .replace(/\*\*/g, '')
    .replace(/[＝]/g, '=');
  const re = /^\s*={2,}\s*TASK\s+(.+?)\s*(?:\([^)]*\))?\s*={2,}\s*$/gim;
  const starts: { key: string; at: number; end: number }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text))
    starts.push({ key: m[1].trim(), at: m.index, end: m.index + m[0].length });
  const translations: OwnerTranslation[] = [];
  const incomplete: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  starts.forEach((s, i) => {
    const asked = batch.keys[s.key];
    if (!asked) {
      unknown.push(s.key);
      return;
    }
    if (seen.has(s.key)) return;
    seen.add(s.key);
    const block = text
      .slice(s.end, i + 1 < starts.length ? starts[i + 1].at : text.length)
      .split(/^\s*={2,}\s*END\s*={2,}\s*$/im)[0];
    for (const p of asked.parts) {
      const m = block.match(
        new RegExp(`^\\s*[-*]?\\s*${p.label}\\s*[:：]\\s*(.+)$`, 'im'),
      );
      const v = m ? oneLine(m[1]) : '';
      if (!v) incomplete.push(`${s.key} ${p.label}`);
      else
        translations.push({
          taskId: asked.taskId,
          field: p.field,
          language: batch.language,
          source: p.source,
          text: v,
        });
    }
  });
  return {
    translations,
    missing: Object.keys(batch.keys).filter((k) => !seen.has(k)),
    incomplete,
    unknown,
  };
}
