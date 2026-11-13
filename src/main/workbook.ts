import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import * as cptable from 'xlsx/dist/cpexcel.full.mjs';
import { excelSerialToDate, type Cell, type Grid } from '../shared/importRules';

// Older .xls files store text in a code page, such as Shift-JIS for Japanese.
XLSX.set_cptable(cptable);

export interface Workbook {
  sheetNames: string[];
  /** The sheet's cells. Merged cells give their value to every cell they cover unless `fillMerges` is false. */
  grid(sheet: string, fillMerges?: boolean): Grid;
}

export class UnreadableFileError extends Error {}

export const READABLE = ['.xlsx', '.xlsm', '.xls', '.csv'];

export const sha256 = (data: Buffer): string =>
  createHash('sha256').update(data).digest('hex');

/** Decodes a CSV file: UTF-8 when it is valid UTF-8, otherwise Shift-JIS, as Japanese Excel saves it. */
function decodeCsv(data: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true })
      .decode(data)
      .replace(/^﻿/, '');
  } catch {
    return new TextDecoder('shift_jis').decode(data);
  }
}

/**
 * Reads a workbook from its bytes. Macros are never run, formulas are read as
 * the value Excel last saved, and hidden rows are read like any other row.
 */
export function readWorkbook(data: Buffer, fileName: string): Workbook {
  const ext = path.extname(fileName).toLowerCase();
  let wb: XLSX.WorkBook;
  // .xlsx and .xlsm are zip files (PK); .xls is an OLE file (D0 CF 11 E0), as are password-protected workbooks.
  const zip = data[0] === 0x50 && data[1] === 0x4b;
  const ole = data.readUInt32BE(0) === 0xd0cf11e0;
  if (ext !== '.csv' && !zip && !ole) {
    throw new UnreadableFileError(
      'This file is damaged or is not an Excel workbook.',
    );
  }
  try {
    wb =
      ext === '.csv'
        ? XLSX.read(decodeCsv(data), {
            type: 'string',
            raw: true,
            dense: false,
          })
        : XLSX.read(data, {
            type: 'buffer',
            cellNF: true,
            cellFormula: false,
            cellHTML: false,
            cellStyles: false,
            bookVBA: false,
          });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/password|encrypt/i.test(msg)) {
      throw new UnreadableFileError(
        'This file is protected with an opening password. Open it in Excel, save a copy without the password in a private folder, and link that copy.',
      );
    }
    throw new UnreadableFileError(
      `The file could not be read as a workbook: ${msg}`,
    );
  }
  if (!wb.SheetNames.length)
    throw new UnreadableFileError('This file has no sheets.');
  return {
    sheetNames: wb.SheetNames,
    grid: (sheet, fillMerges = true) => sheetGrid(wb.Sheets[sheet], fillMerges),
  };
}

/** Rows of cell values. Merged cells give their value to every cell they cover. */
function sheetGrid(ws: XLSX.WorkSheet | undefined, fillMerges = true): Grid {
  if (!ws || !ws['!ref']) return [];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const rows = Math.min(range.e.r, 20000);
  const cols = Math.min(range.e.c, 200);
  const grid: Grid = [];
  for (let r = 0; r <= rows; r++) {
    const line: Cell[] = [];
    for (let c = 0; c <= cols; c++)
      line.push(cellValue(ws[XLSX.utils.encode_cell({ r, c })]));
    while (line.length && line[line.length - 1] === null) line.pop();
    grid.push(line);
  }
  for (const m of fillMerges ? (ws['!merges'] ?? []) : []) {
    const v = grid[m.s.r]?.[m.s.c] ?? null;
    if (v === null) continue;
    for (let r = m.s.r; r <= Math.min(m.e.r, rows); r++) {
      for (let c = m.s.c; c <= Math.min(m.e.c, cols); c++) {
        if (r === m.s.r && c === m.s.c) continue;
        while (grid[r].length <= c) grid[r].push(null);
        grid[r][c] = v;
      }
    }
  }
  while (grid.length && grid[grid.length - 1].length === 0) grid.pop();
  return grid;
}

function cellValue(cell: XLSX.CellObject | undefined): Cell {
  if (!cell || cell.v === undefined || cell.v === null) return null;
  if (cell.t === 'e') return null;
  if (cell.t === 'n') {
    // A number shown with a date format is a date; Excel stores it as days since 1899-12-30.
    const z = typeof cell.z === 'string' ? cell.z : undefined;
    if (z && XLSX.SSF.is_date(z)) {
      const d = excelSerialToDate(Number(cell.v));
      if (d) return { date: d };
    }
    return Number(cell.v);
  }
  if (cell.t === 'd' && cell.v instanceof Date) {
    const d = cell.v;
    const p = (n: number) => String(n).padStart(2, '0');
    return {
      date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    };
  }
  if (cell.t === 'b') return cell.v ? 'TRUE' : 'FALSE';
  const s = String(cell.v).trim();
  return s === '' ? null : s;
}

/** Reads a file from disk after copying it, so the customer's file is never kept open or locked. */
export function snapshotAndRead(
  file: string,
  snapshotDir: string,
): {
  snapshot: string;
  fingerprint: string;
  size: number;
  mtimeMs: number;
  workbook: Workbook;
} {
  const stat = fs.statSync(file);
  const data = fs.readFileSync(file);
  const fingerprint = sha256(data);
  fs.mkdirSync(snapshotDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshot = path.join(snapshotDir, `${stamp}-${path.basename(file)}`);
  fs.writeFileSync(snapshot, data);
  return {
    snapshot,
    fingerprint,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    workbook: readWorkbook(data, file),
  };
}
