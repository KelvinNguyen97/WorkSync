import * as cptable from 'xlsx/dist/cpexcel.full.mjs';

// The typings name only the table; the module also exports its encode and decode helpers.
const codepage = cptable as unknown as {
  utils: { encode: (cp: number, s: string) => ArrayLike<number> };
};
import { cellRef, type CellEdit, type SkippedCell } from './xlsxCells';

/**
 * Edits single fields of a CSV file (spec 04, Writing to the owner's copy).
 * Every other byte stays as it was: the encoding (UTF-8, with or without a
 * byte order mark, or Shift-JIS as Japanese Excel saves it), the separator,
 * the line endings, the quoting of other fields and the end of the file.
 */

interface Field {
  start: number;
  end: number;
  quoted: boolean;
  value: string;
}

type Encoding = 'utf8' | 'utf8-bom' | 'sjis';

function decode(data: Uint8Array): { text: string; encoding: Encoding } {
  const bom = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
  try {
    // The decoder drops a byte order mark itself; it is put back on writing.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    return { text, encoding: bom ? 'utf8-bom' : 'utf8' };
  } catch {
    return {
      text: new TextDecoder('shift_jis').decode(data),
      encoding: 'sjis',
    };
  }
}

function encode(text: string, encoding: Encoding): Uint8Array {
  if (encoding === 'sjis') {
    const out = codepage.utils.encode(932, text);
    return Uint8Array.from(out);
  }
  const body = new TextEncoder().encode(text);
  if (encoding === 'utf8') return body;
  const withBom = new Uint8Array(body.length + 3);
  withBom.set([0xef, 0xbb, 0xbf]);
  withBom.set(body, 3);
  return withBom;
}

/** The separator the file uses: the one that splits the first line most often, outside quotes. */
function separatorOf(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const outside = firstLine.replace(/"[^"]*"/g, '');
  const counts = [',', '\t', ';'].map(
    (s) => [s, outside.split(s).length - 1] as const,
  );
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

/** Splits CSV text into rows of fields, keeping where each field starts and ends. */
export function parseCsv(text: string, sep: string): Field[][] {
  const rows: Field[][] = [];
  let row: Field[] = [];
  let i = 0;
  const n = text.length;
  if (!n) return rows;
  for (;;) {
    const start = i;
    let quoted = false;
    let value = '';
    if (text[i] === '"') {
      quoted = true;
      i++;
      for (;;) {
        if (i >= n) break;
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += text[i++];
      }
      // Anything after the closing quote up to the separator stays part of the field.
      while (i < n && text[i] !== sep && text[i] !== '\n' && text[i] !== '\r')
        value += text[i++];
    } else {
      while (i < n && text[i] !== sep && text[i] !== '\n' && text[i] !== '\r')
        value += text[i++];
    }
    row.push({ start, end: i, quoted, value });
    if (i >= n) {
      rows.push(row);
      break;
    }
    if (text[i] === sep) {
      i++;
      continue;
    }
    // End of the line: \r\n, \n or \r.
    if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
    else i++;
    rows.push(row);
    row = [];
    if (i >= n) break;
  }
  return rows;
}

const needsQuotes = (s: string, sep: string) =>
  s.includes(sep) || /["\r\n]/.test(s) || /^\s|\s$/.test(s);

/** The date pattern the column already uses, so a new date looks like its neighbours. */
function datePattern(rows: Field[][], col: number): '-' | '/' {
  for (const r of rows) {
    const v = r[col]?.value ?? '';
    if (/^\d{4}-\d{1,2}-\d{1,2}/.test(v)) return '-';
    if (/^\d{4}\/\d{1,2}\/\d{1,2}/.test(v)) return '/';
  }
  return '/';
}

export function editCsvCells(
  data: Uint8Array,
  edits: CellEdit[],
): { data: Uint8Array; skipped: SkippedCell[]; written: string[] } {
  const { text, encoding } = decode(data);
  const sep = separatorOf(text);
  const rows = parseCsv(text, sep);
  const skipped: SkippedCell[] = [];
  const written: string[] = [];
  // New text per row and column; fields past the end of a short row are added after it.
  const byRow = new Map<number, Map<number, string>>();
  for (const e of edits) {
    const ref = cellRef(e.row, e.col);
    const row = rows[e.row];
    if (!row) {
      skipped.push({ ref, reason: 'The row is not in the file.' });
      continue;
    }
    let value =
      e.value.kind === 'text'
        ? e.value.text
        : e.value.kind === 'date'
          ? e.value.iso.replaceAll('-', datePattern(rows, e.col))
          : '';
    if (encoding === 'sjis') {
      const back = new TextDecoder('shift_jis').decode(encode(value, 'sjis'));
      if (back !== value) {
        skipped.push({
          ref,
          reason:
            'The new text has characters that Shift-JIS cannot hold. Update this cell in Excel.',
        });
        continue;
      }
    }
    const quote = needsQuotes(value, sep) || (row[e.col]?.quoted ?? false);
    if (quote) value = `"${value.replaceAll('"', '""')}"`;
    if (!byRow.has(e.row)) byRow.set(e.row, new Map());
    byRow.get(e.row)!.set(e.col, value);
    written.push(ref);
  }
  // Replacements as [start, end, text], applied from the end so earlier positions stay valid.
  const replace: [number, number, string][] = [];
  for (const [r, cols] of byRow) {
    const row = rows[r];
    let extra = '';
    const maxCol = Math.max(...cols.keys());
    for (let c = row.length; c <= maxCol; c++)
      extra += sep + (cols.get(c) ?? '');
    for (const [c, v] of cols)
      if (c < row.length) replace.push([row[c].start, row[c].end, v]);
    if (extra) {
      const end = row[row.length - 1].end;
      replace.push([end, end, extra]);
    }
  }
  replace.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  let out = text;
  for (const [s, en, v] of replace) out = out.slice(0, s) + v + out.slice(en);
  return { data: encode(out, encoding), skipped, written };
}
