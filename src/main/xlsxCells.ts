import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { columnLetter } from '../shared/importRules';

/**
 * Edits single cells inside an .xlsx or .xlsm file without rebuilding the
 * workbook (spec 04, Writing to the owner's copy). Every other part of the
 * file is copied byte for byte, so formatting, formulas, merged cells, input
 * rules, conditional formatting, images and other sheets stay as they are.
 */

export type CellValue =
  | { kind: 'text'; text: string }
  | { kind: 'date'; iso: string }
  | { kind: 'empty' };

export interface CellEdit {
  /** Zero-based row and column, as in the reader's grid. */
  row: number;
  col: number;
  value: CellValue;
}

export interface SkippedCell {
  ref: string;
  reason: string;
}

export const cellRef = (row: number, col: number) =>
  `${columnLetter(col)}${row + 1}`;

const colIndex = (letters: string) =>
  [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const splitRef = (ref: string) => {
  const m = ref.match(/^([A-Z]+)(\d+)$/)!;
  return { col: colIndex(m[1]), row: Number(m[2]) - 1 };
};

const xmlText = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Days since 1899-12-30, as Excel stores dates. */
const serial = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(
    (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000,
  );
};

/** Finds the sheet's XML file through the workbook and its relationships. */
function sheetPath(files: Record<string, Uint8Array>, sheet: string): string {
  const wb = strFromU8(files['xl/workbook.xml']);
  const rels = strFromU8(files['xl/_rels/workbook.xml.rels']);
  const decode = (s: string) =>
    s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = m[0].match(/\bname="([^"]*)"/)?.[1];
    const rid =
      m[0].match(/\br:id="([^"]*)"/)?.[1] ??
      m[0].match(/\b[a-zA-Z0-9]+:id="([^"]*)"/)?.[1];
    if (name === undefined || decode(name) !== sheet || !rid) continue;
    for (const r of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      if (r[0].match(/\bId="([^"]*)"/)?.[1] !== rid) continue;
      const target = r[0].match(/\bTarget="([^"]*)"/)![1];
      return target.startsWith('/')
        ? target.slice(1)
        : `xl/${target.replace(/^\.\//, '')}`;
    }
  }
  throw new Error(`The sheet “${sheet}” was not found in the workbook.`);
}

interface ParsedCell {
  xml: string;
  col: number;
  style: string | null;
  type: string | null;
  hasFormula: boolean;
  hasValue: boolean;
}

function parseCell(xml: string): ParsedCell {
  const open = xml.match(/^<c\b[^>]*>/)![0];
  const ref = open.match(/\br="([A-Z]+)\d+"/)![1];
  return {
    xml,
    col: colIndex(ref),
    style: open.match(/\bs="(\d+)"/)?.[1] ?? null,
    type: open.match(/\bt="(\w+)"/)?.[1] ?? null,
    hasFormula: /<f[\s>/]/.test(xml),
    hasValue: /<v>|<is>/.test(xml),
  };
}

const CELL_RE = /<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;

/** Merged areas, so a cell hidden under a merge is not written. */
function merges(
  sheetXml: string,
): { r1: number; c1: number; r2: number; c2: number }[] {
  return [
    ...sheetXml.matchAll(/<mergeCell\b[^>]*\bref="([A-Z]+\d+):([A-Z]+\d+)"/g),
  ].map((m) => {
    const a = splitRef(m[1]);
    const b = splitRef(m[2]);
    return { r1: a.row, c1: a.col, r2: b.row, c2: b.col };
  });
}

/**
 * How a column holds dates, from its other cells: as Excel dates with a style,
 * or as text such as 2026/11/03. Used when the target cell is empty.
 */
function columnDateStyle(
  rowsXml: string[],
  col: number,
  skipRow: number,
): { asText: boolean; style: string | null } {
  for (const [i, rowXml] of rowsXml.entries()) {
    if (i === skipRow) continue;
    for (const c of rowXml.match(CELL_RE) ?? []) {
      const p = parseCell(c);
      if (p.col !== col || !p.hasValue) continue;
      if (p.type === 's' || p.type === 'inlineStr' || p.type === 'str') {
        if (/\d{4}[/.-]\d{1,2}[/.-]\d{1,2}|\d{1,2}[/月]\d{1,2}/.test(c))
          return { asText: true, style: p.style };
        continue;
      }
      return { asText: false, style: p.style };
    }
  }
  return { asText: false, style: null };
}

function newCellXml(
  ref: string,
  style: string | null,
  value: CellValue,
  asText: boolean,
): string {
  const s = style ? ` s="${style}"` : '';
  if (value.kind === 'empty') return `<c r="${ref}"${s}/>`;
  if (value.kind === 'date' && !asText)
    return `<c r="${ref}"${s}><v>${serial(value.iso)}</v></c>`;
  const text =
    value.kind === 'date' ? value.iso.replaceAll('-', '/') : value.text;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlText(text)}</t></is></c>`;
}

/** Writes the edits into the sheet. Formula cells and cells hidden under a merge are skipped and listed. */
export function editCells(
  data: Uint8Array,
  sheet: string,
  edits: CellEdit[],
): { data: Uint8Array; skipped: SkippedCell[]; written: string[] } {
  const files = unzipSync(data);
  const file = sheetPath(files, sheet);
  let xml = strFromU8(files[file]);
  const skipped: SkippedCell[] = [];
  const written: string[] = [];
  const merged = merges(xml);

  const dataStart = xml.indexOf('<sheetData');
  const dataEnd = xml.indexOf('</sheetData>');
  if (dataStart < 0) throw new Error('The sheet has no cell data.');
  if (dataEnd < 0) {
    // <sheetData/>: nothing to edit, and no row to write into.
    for (const e of edits)
      skipped.push({
        ref: cellRef(e.row, e.col),
        reason: 'The row is not in the sheet.',
      });
    return { data, skipped, written };
  }
  const head = xml.slice(0, dataStart);
  const sheetData = xml.slice(dataStart, dataEnd);
  const tail = xml.slice(dataEnd);
  const rowRe = /<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g;
  const rows = sheetData.match(rowRe) ?? [];
  const rowNum = (r: string) => Number(r.match(/\br="(\d+)"/)?.[1]) - 1;
  const byIndex = new Map(rows.map((r, i) => [rowNum(r), i]));
  // Rows as plain strings by sheet row number, for finding how a column holds dates.
  const rowsBySheetRow: string[] = [];
  rows.forEach((r) => (rowsBySheetRow[rowNum(r)] = r));

  for (const e of edits) {
    const ref = cellRef(e.row, e.col);
    if (
      merged.some(
        (m) =>
          e.row >= m.r1 &&
          e.row <= m.r2 &&
          e.col >= m.c1 &&
          e.col <= m.c2 &&
          !(e.row === m.r1 && e.col === m.c1),
      )
    ) {
      skipped.push({
        ref,
        reason: 'The cell is covered by a merged cell. Update it in Excel.',
      });
      continue;
    }
    const i = byIndex.get(e.row);
    if (i === undefined) {
      skipped.push({ ref, reason: 'The row is not in the sheet.' });
      continue;
    }
    let row = rows[i];
    if (row.endsWith('/>')) row = `${row.slice(0, -2)}></row>`;
    const open = row.match(/^<row\b[^>]*>/)![0];
    const cells = (
      row.slice(open.length, -'</row>'.length).match(CELL_RE) ?? []
    ).map(parseCell);
    const at = cells.findIndex((c) => c.col === e.col);
    const old = at >= 0 ? cells[at] : null;
    if (old?.hasFormula) {
      skipped.push({
        ref,
        reason:
          'The cell holds a formula, so it is not overwritten. Update it in Excel.',
      });
      continue;
    }
    let asText = false;
    let style = old?.style ?? null;
    if (e.value.kind === 'date') {
      if (old?.hasValue)
        asText =
          old.type === 's' || old.type === 'inlineStr' || old.type === 'str';
      else {
        const col = columnDateStyle(rowsBySheetRow.filter(Boolean), e.col, -1);
        asText = col.asText;
        style = style ?? col.style;
      }
    }
    const cellXml = newCellXml(ref, style, e.value, asText);
    if (old) cells[at] = { ...old, xml: cellXml };
    else {
      const before = cells.findIndex((c) => c.col > e.col);
      const add = parseCell(cellXml);
      if (before < 0) cells.push(add);
      else cells.splice(before, 0, add);
    }
    rows[i] = `${open}${cells.map((c) => c.xml).join('')}</row>`;
    written.push(ref);
  }

  // Rebuild sheetData from the rows, keeping anything between them as it was.
  let k = 0;
  const newSheetData = sheetData.replace(rowRe, () => rows[k++]);
  xml = head + newSheetData + tail;

  const out: Zippable = {};
  for (const [name, bytes] of Object.entries(files))
    out[name] = name === file ? strToU8(xml) : bytes;
  // Ask Excel to recalculate formulas that use the changed cells when it opens the copy. Only an
  // existing calcPr is adjusted: adding one could break the element order Excel requires.
  const wbXml = strFromU8(files['xl/workbook.xml']);
  const calc = wbXml.match(/<calcPr\b[^>]*>/)?.[0];
  if (written.length && calc && !/fullCalcOnLoad="(1|true)"/.test(calc)) {
    const fixed = calc
      .replace(/\s+fullCalcOnLoad="[^"]*"/, '')
      .replace(/^<calcPr\b/, '<calcPr fullCalcOnLoad="1"');
    out['xl/workbook.xml'] = strToU8(wbXml.replace(calc, fixed));
  }
  return { data: zipSync(out, { level: 6 }), skipped, written };
}
