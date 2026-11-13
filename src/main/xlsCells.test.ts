import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { editXlsCells } from './xlsCells';
import { readWorkbook } from './workbook';
import { cellText } from '../shared/importRules';
import type { CellEdit } from './xlsxCells';

/**
 * The fixture is a made-up WBS (placeholder content only), saved as Excel
 * 97-2003 by LibreOffice: a merged title, a string table, runs of numbers and
 * formatted empty cells, a formula and a second sheet.
 */
const FIXTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'wbs-sample.xls'),
);

interface R {
  type: number;
  data: Buffer;
}
const ROW = 0x0208;
const DBCELL = 0x00d7;
const INDEX = 0x020b;
const CELLS = new Set([
  0xfd, 0x204, 0xd6, 0x203, 0x27e, 0x205, 0x201, 0x6, 0xbd, 0xbe,
]);

const parse = (b: Buffer): R[] => {
  const out: R[] = [];
  for (let p = 0; p + 4 <= b.length;) {
    const len = b.readUInt16LE(p + 2);
    out.push({
      type: b.readUInt16LE(p),
      data: Buffer.from(b.subarray(p + 4, p + 4 + len)),
    });
    p += 4 + len;
  }
  return out;
};
const join = (rs: R[]) =>
  Buffer.concat(
    rs.flatMap((r) => {
      const h = Buffer.alloc(4);
      h.writeUInt16LE(r.type, 0);
      h.writeUInt16LE(r.data.length, 2);
      return [h, r.data];
    }),
  );
const starts = (rs: R[]) => {
  const at: number[] = [];
  let p = 0;
  for (const r of rs) {
    at.push(p);
    p += 4 + r.data.length;
  }
  return at;
};
const streamOf = (file: Uint8Array) => {
  const cfb = XLSX.CFB.read(Buffer.from(file), { type: 'buffer' });
  const e = XLSX.CFB.find(cfb, 'Workbook')!;
  return { cfb, e, recs: parse(Buffer.from(e.content as Uint8Array)) };
};

/**
 * What the row index should hold, computed from scratch: for each block, the
 * DBCELL offsets, with the first offset counted from `base` (Excel's files
 * have been read both ways, so the test checks both).
 */
function expectedIndex(rs: R[], base: 'secondRow' | 'firstCell') {
  const at = starts(rs);
  const dbcells: { k: number; data: Buffer }[] = [];
  let rows: { row: number; k: number }[] = [];
  const firstCell = new Map<number, number>();
  for (let k = 0; k < rs.length; k++) {
    const r = rs[k];
    if (r.type === 0x0809) {
      rows = [];
      firstCell.clear();
    } else if (r.type === ROW) rows.push({ row: r.data.readUInt16LE(0), k });
    else if (CELLS.has(r.type)) {
      const row = r.data.readUInt16LE(0);
      if (!firstCell.has(row)) firstCell.set(row, at[k]);
    } else if (r.type === DBCELL) {
      const d = Buffer.alloc(4 + rows.length * 2);
      d.writeUInt32LE(at[k] - at[rows[0].k], 0);
      // Rows without cells take the position of the next row's cells.
      const pos = rows.map((x) => firstCell.get(x.row));
      for (let j = pos.length - 1; j >= 0; j--) pos[j] ??= pos[j + 1] ?? at[k];
      let prev =
        base === 'secondRow'
          ? at[rows[Math.min(1, rows.length - 1)].k]
          : at[rows[rows.length - 1].k] +
            4 +
            rs[rows[rows.length - 1].k].data.length;
      pos.forEach((p, j) => {
        d.writeUInt16LE(p! - prev, 4 + j * 2);
        prev = p!;
      });
      dbcells.push({ k, data: d });
      rows = [];
      firstCell.clear();
    }
  }
  return dbcells;
}

/** Adds an INDEX and DBCELL records like Excel writes, and moves the sheet starts. */
function withRowIndex(
  file: Uint8Array,
  base: 'secondRow' | 'firstCell',
): Uint8Array {
  const { cfb, e, recs } = streamOf(file);
  const out: R[] = [];
  let inSheet = false;
  let bofs = 0;
  for (let k = 0; k < recs.length; k++) {
    const r = recs[k];
    out.push(r);
    if (r.type === 0x0809 && ++bofs === 2) {
      inSheet = true;
      out.push({ type: INDEX, data: Buffer.alloc(16) });
    }
    if (!inSheet) continue;
    const next = recs[k + 1];
    const isCell = CELLS.has(r.type);
    if (isCell && next && !CELLS.has(next.type)) {
      const rowsBefore = out.filter(
        (x, i) =>
          x.type === ROW && i > out.map((y) => y.type).lastIndexOf(DBCELL),
      ).length;
      out.push({ type: DBCELL, data: Buffer.alloc(4 + rowsBefore * 2) });
    }
    if (r.type === 0x000a) inSheet = false;
  }
  // The INDEX gets its full size first, so the positions after it are final.
  const idx = out.findIndex((r) => r.type === INDEX);
  out[idx].data = Buffer.alloc(
    16 + out.filter((r) => r.type === DBCELL).length * 4,
  );
  for (const d of expectedIndex(out, base)) out[d.k].data = d.data;
  const at = starts(out);
  const db = out
    .map((r, k) => (r.type === DBCELL ? at[k] : -1))
    .filter((x) => x >= 0);
  db.forEach((p, j) => out[idx].data.writeUInt32LE(p, 16 + j * 4));
  // Sheet starts: the BOF records after the workbook part.
  const bofAt = out
    .map((r, k) => (r.type === 0x0809 ? at[k] : -1))
    .filter((x) => x >= 0);
  let s = 1;
  for (const r of out)
    if (r.type === 0x0085) r.data.writeUInt32LE(bofAt[s++], 0);
  const stream = join(out);
  e.content = stream;
  e.size = stream.length;
  return new Uint8Array(
    XLSX.CFB.write(cfb, { type: 'buffer', fileType: 'cfb' }) as Buffer,
  );
}

const grid = (file: Uint8Array, sheet: string) =>
  readWorkbook(Buffer.from(file), 'x.xls').grid(sheet, false);

const EDITS: CellEdit[] = [
  { row: 2, col: 2, value: { kind: 'text', text: '完了' } }, // existing string, existing cell
  { row: 3, col: 2, value: { kind: 'text', text: '確認待ち' } }, // a new string
  { row: 4, col: 3, value: { kind: 'text', text: '佐藤' } }, // a formatted empty cell
  { row: 5, col: 6, value: { kind: 'date', iso: '2026-11-20' } }, // inside a run of empty cells
  { row: 6, col: 5, value: { kind: 'date', iso: '2026-12-01' } }, // a date replaced
  { row: 7, col: 0, value: { kind: 'empty' } }, // a number emptied
  { row: 303, col: 7, value: { kind: 'text', text: 'x' } }, // the formula
  { row: 0, col: 1, value: { kind: 'text', text: 'x' } }, // under the merged title
];

function check(before: Uint8Array, after: Uint8Array, written: string[]) {
  const a = grid(before, 'WBS');
  const b = grid(after, 'WBS');
  const want: Record<string, string> = {
    '2,2': '完了',
    '3,2': '確認待ち',
    '4,3': '佐藤',
    '5,6': '2026/11/20',
    '6,5': '2026/12/01',
    '7,0': '',
  };
  expect(written.sort()).toEqual(['A8', 'C3', 'C4', 'D5', 'F7', 'G6'].sort());
  for (let r = 0; r < Math.max(a.length, b.length); r++)
    for (let c = 0; c < 8; c++) {
      const got = cellText(b[r]?.[c] ?? null);
      const w = want[`${r},${c}`];
      if (w !== undefined)
        expect(got.replaceAll('-', '/'), `${r},${c}`).toBe(w);
      else expect(got, `${r},${c}`).toBe(cellText(a[r]?.[c] ?? null));
    }
  expect(grid(after, 'Notes')).toEqual(grid(before, 'Notes'));
}

describe('writing cells into .xls files', () => {
  it('changes only the cells written, and keeps formulas, merges and other sheets', () => {
    const { data, skipped, written } = editXlsCells(FIXTURE, 'WBS', EDITS);
    check(FIXTURE, data, written);
    expect(skipped.map((s) => s.ref).sort()).toEqual(['B1', 'H304']);
    // The formula is still a formula.
    const wb = XLSX.read(Buffer.from(data), {
      type: 'buffer',
      cellFormula: true,
    });
    expect(wb.Sheets.WBS.H304.f).toBe('SUM(H3:H302)');
    expect(wb.Sheets.WBS['!merges']).toEqual(
      XLSX.read(FIXTURE, { type: 'buffer' }).Sheets.WBS['!merges'],
    );
  });

  it('keeps the string table counts right', () => {
    const { data } = editXlsCells(FIXTURE, 'WBS', EDITS);
    const sst = streamOf(data).recs.find((r) => r.type === 0xfc)!;
    const old = streamOf(FIXTURE).recs.find((r) => r.type === 0xfc)!;
    expect(sst.data.readUInt32LE(4)).toBe(old.data.readUInt32LE(4) + 2);
  });

  for (const base of ['secondRow', 'firstCell'] as const) {
    it(`moves the row index with the records (${base})`, () => {
      const indexed = withRowIndex(FIXTURE, base);
      // The helper itself makes a readable file.
      expect(grid(indexed, 'WBS')).toEqual(grid(FIXTURE, 'WBS'));
      const { data, written } = editXlsCells(indexed, 'WBS', EDITS);
      check(indexed, data, written);
      const recs = streamOf(data).recs;
      const want = expectedIndex(recs, base);
      const got = recs.filter((r) => r.type === DBCELL);
      expect(got.map((r) => r.data.toString('hex'))).toEqual(
        want.map((w) => w.data.toString('hex')),
      );
      const at = starts(recs);
      const index = recs.find((r) => r.type === INDEX)!;
      const db = recs
        .map((r, k) => (r.type === DBCELL ? at[k] : -1))
        .filter((x) => x >= 0);
      expect(
        Array.from({ length: db.length }, (_, j) =>
          index.data.readUInt32LE(16 + j * 4),
        ),
      ).toEqual(db);
    });
  }

  it('refuses a file older than Excel 97 and a password', () => {
    expect(() => editXlsCells(new Uint8Array(512), 'WBS', EDITS)).toThrow();
  });
});
