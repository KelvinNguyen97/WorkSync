/**
 * Rich text for long fields (summary, notes, comments…): the text is kept as
 * typed, in a small Markdown, and shown formatted. Parsing gives a tree the
 * screens render as elements (never as HTML), and `richPlain` gives the text
 * without the marks, for reports, briefs and one-line previews.
 *
 * Supported: # headings (three levels), **bold**, *italic*, ~~strike~~,
 * `code`, ``` code blocks, - * + • and 1. lists (nested by indent),
 * - [ ] check items, > quotes, --- rules, [text](address) and bare web
 * addresses. A single line break is a line break.
 *
 * Free of Node.js and Electron imports.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'b' | 'i' | 's'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] };

export interface ListItem {
  c: Inline[][];
  /** For check items: ticked or not; null for an ordinary item. */
  checked: boolean | null;
  children: Block[];
}

export type Block =
  | { t: 'p'; lines: Inline[][] }
  | { t: 'h'; level: 1 | 2 | 3; c: Inline[] }
  | { t: 'ul'; items: ListItem[] }
  | { t: 'ol'; start: number; items: ListItem[] }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'code'; v: string }
  | { t: 'hr' };

/** Only web and mail addresses become links. */
export const safeHref = (href: string): string | null =>
  /^(https?:\/\/|mailto:)[^\s<>"']+$/i.test(href.trim()) ? href.trim() : null;

const INLINE: [RegExp, (m: RegExpExecArray) => Inline | null][] = [
  [/`([^`\n]+)`/, (m) => ({ t: 'code', v: m[1] })],
  [
    /\[([^\]\n]+)\]\(([^)\s]+)\)/,
    (m) => {
      const href = safeHref(m[2]);
      return href ? { t: 'link', href, c: parseInline(m[1]) } : null;
    },
  ],
  [
    /https?:\/\/[^\s<>()[\]"'、。]+[^\s<>()[\]"'、。.,;:!?]/,
    (m) => {
      const href = safeHref(m[0]);
      return href ? { t: 'link', href, c: [{ t: 'text', v: m[0] }] } : null;
    },
  ],
  [/\*\*(?!\s)([^\n]+?)(?<!\s)\*\*/, (m) => ({ t: 'b', c: parseInline(m[1]) })],
  [/__(?!\s)([^\n]+?)(?<!\s)__/, (m) => ({ t: 'b', c: parseInline(m[1]) })],
  [/~~(?!\s)([^\n]+?)(?<!\s)~~/, (m) => ({ t: 's', c: parseInline(m[1]) })],
  [
    /\*(?![\s*])([^\n*]+?)(?<![\s*])\*/,
    (m) => ({ t: 'i', c: parseInline(m[1]) }),
  ],
  // _italic_ only between words, so file_names_like_this stay as they are.
  [
    /(?<![\p{L}\p{N}_])_(?![\s_])([^\n_]+?)(?<![\s_])_(?![\p{L}\p{N}_])/u,
    (m) => ({ t: 'i', c: parseInline(m[1]) }),
  ],
];

/** The marks inside one line. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  while (rest) {
    let best: { at: number; len: number; node: Inline } | null = null;
    for (const [re, make] of INLINE) {
      const m = re.exec(rest);
      if (!m || (best && m.index >= best.at)) continue;
      const node = make(m);
      if (node) best = { at: m.index, len: m[0].length, node };
    }
    if (!best) break;
    if (best.at) out.push({ t: 'text', v: rest.slice(0, best.at) });
    out.push(best.node);
    rest = rest.slice(best.at + best.len);
  }
  if (rest) out.push({ t: 'text', v: rest });
  return out;
}

const LIST = /^(\s*)(?:([-*+•])|(\d{1,3})[.)])\s+(.*)$/;
const indentOf = (s: string) => s.replace(/\t/g, '    ').length;

interface RawItem {
  indent: number;
  ordered: boolean;
  n: number;
  lines: string[];
}

function buildList(items: RawItem[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < items.length) {
    const first = items[i];
    const list: ListItem[] = [];
    // Items of one list: the same indent and kind; deeper ones belong to the item before.
    while (
      i < items.length &&
      items[i].indent === first.indent &&
      items[i].ordered === first.ordered
    ) {
      const it = items[i++];
      const deeper: RawItem[] = [];
      while (i < items.length && items[i].indent > first.indent)
        deeper.push(items[i++]);
      let checked: boolean | null = null;
      const lines = [...it.lines];
      const box = /^\[( |x|X)\]\s+(.*)$/.exec(lines[0]);
      if (box) {
        checked = box[1] !== ' ';
        lines[0] = box[2];
      }
      list.push({
        c: lines.map(parseInline),
        checked,
        children: buildList(deeper),
      });
    }
    out.push(
      first.ordered
        ? { t: 'ol', start: first.n, items: list }
        : { t: 'ul', items: list },
    );
    // An item less indented than the list it follows starts over at its own level.
    if (i < items.length && items[i].indent < first.indent) {
      const rest = items.slice(i);
      const base = Math.min(...rest.map((x) => x.indent));
      out.push(
        ...buildList(rest.map((x) => ({ ...x, indent: x.indent - base }))),
      );
      break;
    }
  }
  return out;
}

/** The blocks of a text. */
export function parseRich(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]))
        body.push(lines[i++]);
      i++;
      out.push({ t: 'code', v: body.join('\n') });
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push({
        t: 'h',
        level: Math.min(3, h[1].length) as 1 | 2 | 3,
        c: parseInline(h[2]),
      });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]))
        body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push({ t: 'quote', blocks: parseRich(body.join('\n')) });
      continue;
    }
    if (LIST.test(line)) {
      const items: RawItem[] = [];
      while (i < lines.length) {
        const m = LIST.exec(lines[i]);
        if (m) {
          items.push({
            indent: indentOf(m[1]),
            ordered: m[3] !== undefined,
            n: m[3] !== undefined ? Number(m[3]) : 1,
            lines: [m[4]],
          });
          i++;
        } else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
          // An indented line under an item continues it.
          items[items.length - 1].lines.push(lines[i].trim());
          i++;
        } else break;
      }
      const base = Math.min(...items.map((x) => x.indent));
      out.push(
        ...buildList(items.map((x) => ({ ...x, indent: x.indent - base }))),
      );
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^\s{0,3}#{1,6}\s+\S/.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
      !(para.length && LIST.test(lines[i]))
    )
      para.push(lines[i++]);
    out.push({ t: 'p', lines: para.map(parseInline) });
  }
  return out;
}

const plainInline = (c: Inline[]): string =>
  c
    .map((x) => {
      if (x.t === 'text' || x.t === 'code') return x.v;
      if (x.t === 'link') {
        const label = plainInline(x.c);
        return label === x.href ? label : `${label} (${x.href})`;
      }
      return plainInline(x.c);
    })
    .join('');

function plainBlocks(blocks: Block[], indent: string): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.t === 'p') out.push(...b.lines.map((l) => indent + plainInline(l)));
    else if (b.t === 'h') out.push(indent + plainInline(b.c));
    else if (b.t === 'hr') out.push(`${indent}――――`);
    else if (b.t === 'code')
      out.push(...b.v.split('\n').map((l) => indent + l));
    else if (b.t === 'quote') out.push(...plainBlocks(b.blocks, `${indent}  `));
    else
      b.items.forEach((it, n) => {
        const mark =
          it.checked !== null
            ? it.checked
              ? '☑'
              : '☐'
            : b.t === 'ol'
              ? `${b.start + n}.`
              : '•';
        it.c.forEach((l, k) =>
          out.push(
            `${indent}${k ? ' '.repeat(mark.length + 1) : `${mark} `}${plainInline(l)}`,
          ),
        );
        out.push(...plainBlocks(it.children, `${indent}  `));
      });
  }
  return out;
}

/** The text without its marks, for reports, briefs and files other people read. */
export function richPlain(text: string): string {
  if (!text) return text;
  return plainBlocks(parseRich(text), '').join('\n');
}

/** The first line as plain text, for a one-line preview. */
export const richFirstLine = (text: string): string =>
  richPlain(text)
    .split('\n')
    .find((l) => l.trim())
    ?.trim() ?? '';

// ---------------------------------------------------------------- editing

export interface Edit {
  text: string;
  /** The selection after the change. */
  start: number;
  end: number;
}

/** Puts a mark around the selection, or takes it away when it is there. */
export function toggleWrap(
  text: string,
  start: number,
  end: number,
  mark: string,
): Edit {
  const sel = text.slice(start, end);
  const n = mark.length;
  if (
    text.slice(start - n, start) === mark &&
    text.slice(end, end + n) === mark
  )
    return {
      text: text.slice(0, start - n) + sel + text.slice(end + n),
      start: start - n,
      end: end - n,
    };
  if (sel.length >= 2 * n && sel.startsWith(mark) && sel.endsWith(mark))
    return {
      text: text.slice(0, start) + sel.slice(n, -n) + text.slice(end),
      start,
      end: end - 2 * n,
    };
  return {
    text: text.slice(0, start) + mark + sel + mark + text.slice(end),
    start: start + n,
    end: end + n,
  };
}

export type LineKind = 'ul' | 'ol' | 'check' | 'quote' | 'h';
const PREFIX =
  /^(\s*)(?:[-*+•]\s+\[[ xX]\]\s+|[-*+•]\s+|\d{1,3}[.)]\s+|>\s?|#{1,6}\s+)?/;

/** Makes the selected lines a list, quote or heading, or plain again when they already are. */
export function toggleLines(
  text: string,
  start: number,
  end: number,
  kind: LineKind,
): Edit {
  const from = text.lastIndexOf('\n', start - 1) + 1;
  let to = text.indexOf('\n', Math.max(end - 1, start));
  if (to < 0) to = text.length;
  const lines = text.slice(from, to).split('\n');
  const is = (l: string) =>
    kind === 'ul'
      ? /^\s*[-*+•]\s+(?!\[[ xX]\]\s)/.test(l)
      : kind === 'ol'
        ? /^\s*\d{1,3}[.)]\s+/.test(l)
        : kind === 'check'
          ? /^\s*[-*+•]\s+\[[ xX]\]\s+/.test(l)
          : kind === 'quote'
            ? /^\s*>/.test(l)
            : /^\s*##\s+/.test(l);
  const filled = lines.filter((l) => l.trim());
  const off = filled.length > 0 && filled.every(is);
  let n = 0;
  const next = lines.map((l) => {
    if (!l.trim() && lines.length > 1) return l;
    const m = PREFIX.exec(l)!;
    const body = l.slice(m[0].length);
    if (off) return m[1] + body;
    n++;
    const mark =
      kind === 'ul'
        ? '- '
        : kind === 'ol'
          ? `${n}. `
          : kind === 'check'
            ? '- [ ] '
            : kind === 'quote'
              ? '> '
              : '## ';
    return m[1] + mark + body;
  });
  const block = next.join('\n');
  // With only a cursor, typing goes on at the end of the line; a selection stays selected.
  const caret = start === end;
  return {
    text: text.slice(0, from) + block + text.slice(to),
    start: caret ? from + block.length : from,
    end: from + block.length,
  };
}

/**
 * Enter inside a list: the next item starts by itself, and Enter on an empty
 * item ends the list. Null when the line is not a list item.
 */
export function continueList(text: string, at: number): Edit | null {
  const from = text.lastIndexOf('\n', at - 1) + 1;
  const line = text.slice(from, at);
  const m = /^(\s*)(?:([-*+•])(\s+\[[ xX]\])?|(\d{1,3})([.)]))\s+(.*)$/.exec(
    line,
  );
  if (!m) return null;
  if (!m[6].trim()) {
    // An empty item: the list ends here.
    return {
      text: text.slice(0, from) + text.slice(at),
      start: from,
      end: from,
    };
  }
  const mark = m[2]
    ? `${m[2]}${m[3] ? ' [ ]' : ''} `
    : `${Number(m[4]) + 1}${m[5]} `;
  const ins = `\n${m[1]}${mark}`;
  return {
    text: text.slice(0, at) + ins + text.slice(at),
    start: at + ins.length,
    end: at + ins.length,
  };
}
