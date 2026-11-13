import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { editCells } from './xlsxCells';
import { readWorkbook } from './workbook';

/** A WBS with a date-formatted column, a text-date column, a formula, a merged area and a second sheet. */
function workbook(): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([
    ['No.', '件名', '状態', '予定終了', '実績終了', '工数', '分類'],
    ['1', 'ログイン', '対応中', null, '2026/10/30', null, 'バグ'],
    ['2', '出荷', '未着手', null, null, null, null],
    ['3', '帳票', '完了', null, '2026/10/20', null, null],
  ]);
  ws['D2'] = { t: 'n', v: 46329, z: 'yyyy/mm/dd' }; // 2026-11-03
  ws['D4'] = { t: 'n', v: 46320, z: 'yyyy/mm/dd' };
  ws['F2'] = { t: 'n', f: 'D2-46000', v: 329 };
  ws['!merges'] = [{ s: { r: 1, c: 6 }, e: { r: 2, c: 6 } }];
  ws['!ref'] = 'A1:G4';
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['表紙']]), '表紙');
  XLSX.utils.book_append_sheet(wb, ws, 'WBS');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
}

describe('editCells', () => {
  it('changes only the target cells and keeps every other part of the file', () => {
    const before = workbook();
    const { data, skipped, written } = editCells(before, 'WBS', [
      { row: 1, col: 2, value: { kind: 'text', text: '完了' } }, // C2 text
      { row: 2, col: 3, value: { kind: 'date', iso: '2026-11-20' } }, // D3 empty, in a date-formatted column
      { row: 1, col: 3, value: { kind: 'date', iso: '2026-11-05' } }, // D2 dated
      { row: 2, col: 4, value: { kind: 'date', iso: '2026-11-04' } }, // E3 empty, in a text-date column
      { row: 1, col: 5, value: { kind: 'text', text: '999' } }, // F2 formula
      { row: 2, col: 6, value: { kind: 'text', text: '要望' } }, // G3 under a merge
      { row: 3, col: 2, value: { kind: 'empty' } }, // C4 cleared
    ]);
    expect(written).toEqual(['C2', 'D3', 'D2', 'E3', 'C4']);
    expect(skipped.map((s) => s.ref)).toEqual(['F2', 'G3']);

    const a = readWorkbook(before, 'a.xlsx').grid('WBS');
    const b = readWorkbook(Buffer.from(data), 'b.xlsx').grid('WBS');
    expect(b[1][2]).toBe('完了');
    expect(b[1][3]).toEqual({ date: '2026-11-05' });
    expect(b[2][3]).toEqual({ date: '2026-11-20' });
    expect(b[2][4]).toBe('2026/11/04');
    expect(b[1][5]).toBe(329);
    expect(b[3][2] ?? null).toBeNull();

    // Every other cell is unchanged.
    const changed = new Set(['1,2', '1,3', '2,3', '2,4', '3,2']);
    for (let r = 0; r < Math.max(a.length, b.length); r++) {
      for (let c = 0; c < 7; c++) {
        if (changed.has(`${r},${c}`)) continue;
        expect([r, c, b[r]?.[c] ?? null]).toEqual([r, c, a[r]?.[c] ?? null]);
      }
    }
    // Every other file inside the workbook is byte for byte the same.
    const za = unzipSync(before);
    const zb = unzipSync(data);
    expect(Object.keys(zb).sort()).toEqual(Object.keys(za).sort());
    for (const name of Object.keys(za)) {
      if (name === 'xl/worksheets/sheet2.xml') continue;
      expect([
        name,
        Buffer.from(zb[name]).equals(Buffer.from(za[name])),
      ]).toEqual([name, true]);
    }
    // The formula and the date cells keep their style.
    const sheet = strFromU8(zb['xl/worksheets/sheet2.xml']);
    expect(sheet).toContain('<f>D2-46000</f>');
    const style = strFromU8(za['xl/worksheets/sheet2.xml']).match(
      /<c r="D2"[^>]*\bs="(\d+)"/,
    )?.[1];
    expect(style).toBeDefined();
    expect(sheet).toMatch(
      new RegExp(`<c r="D3" s="${style}"><v>46346</v></c>`),
    );
  });

  it('refuses a sheet that is not in the workbook', () => {
    expect(() => editCells(workbook(), 'Nope', [])).toThrow('was not found');
  });
});
