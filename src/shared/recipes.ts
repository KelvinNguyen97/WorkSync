/**
 * Recipes (doc 12): an AI request written once, with blanks filled in each
 * time. Pure: the main process and the screens share it.
 */
import type { GlossaryEntry } from './aiBatch';

export type BlankKind = 'short' | 'long' | 'choice' | 'language' | 'person';

/** What a blank takes from a linked ticket or discussion. */
export type FillFrom =
  | ''
  | 'comment'
  | 'description'
  | 'summary'
  | 'situation'
  | 'title';

export interface Blank {
  /** The name between the braces in the instructions. */
  key: string;
  label: string;
  kind: BlankKind;
  /** The options of a choice. */
  choices: string[];
  /** The form opens with the value used last time. */
  remember: boolean;
  last: string;
  from: FillFrom;
}

export interface Recipe {
  id: string;
  /** Null for a personal recipe, usable anywhere. */
  projectId: string | null;
  name: string;
  description: string;
  instructions: string;
  blanks: Blank[];
  /** Answer sections, each with its own Copy; none for one block. */
  sections: string[];
  followups: string[];
  createdAt: string;
  updatedAt: string;
}

export type RecipeInput = Pick<
  Recipe,
  | 'projectId'
  | 'name'
  | 'description'
  | 'instructions'
  | 'blanks'
  | 'sections'
  | 'followups'
>;

/** A ticket or discussion a run takes text from. */
export interface RecipeLink {
  kind: 'ticket' | 'discussion';
  id: string;
  projectId: string;
  /** Such as "Ticket 016 · CSV import shifts dates". */
  label: string;
}

export interface RecipeRun {
  id: string;
  recipeId: string;
  at: string;
  values: Record<string, string>;
  link: RecipeLink | null;
  request: string;
  answer: string;
  provider: string;
}

export interface AnswerSection {
  title: string;
  text: string;
}

export interface ReadRecipeAnswer {
  sections: AnswerSection[];
  /** False when the recipe has sections and none was found. */
  ok: boolean;
}

/** Runs kept per recipe. */
export const RUNS_KEPT = 5;

export const DEFAULT_FOLLOWUPS = [
  'Shorter',
  'More polite',
  'Less formal',
  'Try again',
];

/** What the built-in follow-ups ask; your own are sent as you wrote them. */
const FOLLOWUP_TEXT: Record<string, string> = {
  Shorter: 'Make it shorter.',
  'More polite': 'Make it more polite.',
  'Less formal': 'Make it less formal.',
  'Try again': 'Write it again in a different way.',
};

export const FILL_FROM: [FillFrom, string][] = [
  ['', 'Not used'],
  ['comment', 'Latest comment of its discussion'],
  ['description', 'Original description'],
  ['summary', 'Summary'],
  ['situation', 'Current situation'],
  ['title', 'Title'],
];

const BLANK = /\{\{\s*([^{}\n]{1,40}?)\s*\}\}/g;

/** The blanks named in the instructions, in order, each once. */
export function blankKeys(instructions: string): string[] {
  const out: string[] = [];
  for (const m of instructions.matchAll(BLANK)) {
    const k = m[1].trim();
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

const label = (key: string) =>
  key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ');

/** The blanks for these instructions: settings kept for names still there. */
export function syncBlanks(instructions: string, old: Blank[]): Blank[] {
  return blankKeys(instructions).map(
    (key) =>
      old.find((b) => b.key === key) ?? {
        key,
        label: label(key),
        kind: 'short',
        choices: [],
        remember: false,
        last: '',
        from: '',
      },
  );
}

/** Every blank must be filled, except one whose label ends with "(optional)". */
export const isOptional = (b: Pick<Blank, 'label'>) =>
  /\(optional\)\s*$/i.test(b.label);

export const missingBlanks = (r: Recipe, values: Record<string, string>) =>
  r.blanks.filter((b) => !isOptional(b) && !(values[b.key] ?? '').trim());

/**
 * The request: the instructions with the blanks filled; then the glossary
 * terms that appear in the values; then, with sections, the answer format.
 */
export function buildRequest(
  r: Pick<Recipe, 'instructions' | 'sections'>,
  values: Record<string, string>,
  glossary: GlossaryEntry[] = [],
): string {
  let text = r.instructions.replace(BLANK, (_, k: string) =>
    (values[k.trim()] ?? '').trim(),
  );
  const all = Object.values(values).join('\n');
  const used = glossary.filter(
    (g) => g.term.trim() && g.translation.trim() && all.includes(g.term),
  );
  if (used.length)
    text += `\n\nUse these translations for these terms:\n${used
      .map(
        (g) => `- ${g.term} = ${g.translation}${g.note ? ` (${g.note})` : ''}`,
      )
      .join('\n')}`;
  const sections = r.sections.filter((s) => s.trim());
  if (sections.length)
    text += `\n\nAnswer in exactly these sections, in this order, each starting with its own line as shown, and write nothing before the first one:\n${sections
      .map((s) => `=== ${s.trim()} ===`)
      .join('\n')}`;
  return text;
}

/** A follow-up: the request, the answer, and what to change. */
export function followUpRequest(
  request: string,
  answer: string,
  ask: string,
): string {
  const what = FOLLOWUP_TEXT[ask] ?? ask.trim();
  return `${request}\n\n--- Your previous answer ---\n${answer.trim()}\n\n--- Please change it ---\n${what}\nAnswer again in full, in the same format.`;
}

/** Said when an answer had none of the sections asked for. */
export const SECTIONS_REMINDER =
  '\n\nImportant: start each section with its line exactly as shown above, such as the first one, and write nothing else around them.';

const tidy = (s: string) =>
  s
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*```[a-z]*\s*\n([\s\S]*?)\n\s*```\s*$/i, '$1')
    .trim();

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[*_#:：]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Splits an answer into the recipe's sections. What comes before the first
 * section (such as "Sure, here it is:") is dropped. Lenient about bold and
 * heading marks around the section lines.
 */
export function readRecipeAnswer(
  answer: string,
  sections: string[],
): ReadRecipeAnswer {
  const text = tidy(answer);
  const names = sections.map((s) => s.trim()).filter(Boolean);
  if (!names.length) return { sections: [{ title: '', text }], ok: true };
  const re = /^[ \t>*#_]*={2,}\s*(.+?)\s*={2,}[ \t*_]*$/gm;
  const marks: { i: number; at: number; end: number }[] = [];
  for (const m of text.matchAll(re)) {
    const i = names.findIndex((n) => norm(n) === norm(m[1]));
    if (i >= 0) marks.push({ i, at: m.index, end: m.index + m[0].length });
  }
  if (!marks.length) return { sections: [{ title: '', text }], ok: false };
  const found = new Map<number, string>();
  marks.forEach((m, k) => {
    const stop = k + 1 < marks.length ? marks[k + 1].at : text.length;
    if (!found.has(m.i)) found.set(m.i, text.slice(m.end, stop).trim());
  });
  return {
    sections: names.map((title, i) => ({ title, text: found.get(i) ?? '' })),
    ok: true,
  };
}

/** All sections as one text, for Copy all. */
export const allText = (s: AnswerSection[]) =>
  s
    .map((x) => (x.title ? `${x.title}\n${x.text}` : x.text))
    .join('\n\n')
    .trim();

const blank = (
  key: string,
  o: Partial<Blank> & Pick<Blank, 'label' | 'kind'>,
): Blank => ({ key, choices: [], remember: false, last: '', from: '', ...o });

/** The recipes WorkSync starts with; they can be changed or deleted. */
export const STARTERS: RecipeInput[] = [
  {
    projectId: null,
    name: 'Go-between',
    description:
      'Pass a message between the customer and the vendor, in the words each side expects.',
    instructions:
      'I work between a customer, {{customer}}, and a vendor, {{vendor}}, on a software project. Rewrite the message below for the other side ({{direction}}). Keep every fact, date and number; use the language and the tone the other side expects; do not promise anything the message does not say. Under Notes for you, list anything unclear or anything you changed on purpose.\n\nMessage:\n{{message}}',
    blanks: [
      blank('customer', { label: 'Customer', kind: 'person', remember: true }),
      blank('vendor', { label: 'Vendor', kind: 'short', remember: true }),
      blank('direction', {
        label: 'Direction',
        kind: 'choice',
        choices: ['Customer → Vendor', 'Vendor → Customer'],
        remember: true,
        last: 'Customer → Vendor',
      }),
      blank('message', { label: 'The message', kind: 'long', from: 'comment' }),
    ],
    sections: ['Message to the other side', 'Notes for you'],
    followups: [...DEFAULT_FOLLOWUPS],
  },
  {
    projectId: null,
    name: 'Correct & translate',
    description:
      'Fix the grammar and wording of a paragraph, then translate it.',
    instructions:
      'Correct the grammar and wording of the paragraph below without changing its meaning. Then translate the corrected text into {{language}}. Under What changed, list the main corrections in a few short lines.\n\nParagraph:\n{{paragraph}}',
    blanks: [
      blank('language', {
        label: 'Translate into',
        kind: 'language',
        remember: true,
        last: 'Japanese',
      }),
      blank('paragraph', { label: 'Paragraph', kind: 'long' }),
    ],
    sections: ['Corrected', 'Translation', 'What changed'],
    followups: [...DEFAULT_FOLLOWUPS],
  },
  {
    projectId: null,
    name: 'Reply to a customer email',
    description:
      'Suggest a reply from their email and the points you want to make.',
    instructions:
      "Suggest a reply to the customer's email below. Write it in the language of their email, in a {{tone}} tone, and make the points I want to make. Under Their questions you did not answer, list any question in their email that my points leave open, or write None.\n\nTheir email:\n{{their email}}\n\nWhat I want to say:\n{{what I want to say}}",
    blanks: [
      blank('tone', {
        label: 'Tone',
        kind: 'choice',
        choices: ['formal', 'friendly'],
        remember: true,
        last: 'formal',
      }),
      blank('their email', {
        label: 'Their email',
        kind: 'long',
        from: 'comment',
      }),
      blank('what I want to say', {
        label: 'What I want to say',
        kind: 'long',
      }),
    ],
    sections: ['Suggested reply', 'Their questions you did not answer'],
    followups: [...DEFAULT_FOLLOWUPS],
  },
];
