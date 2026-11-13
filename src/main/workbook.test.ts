import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { readWorkbook, UnreadableFileError } from './workbook';

function xlsx(
  build: (ws: XLSX.WorkSheet) => void,
  rows: unknown[][],
  bookType: XLSX.BookType = 'xlsx',
): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  build(ws);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'WBS');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['memo']]), 'メモ');
  return XLSX.write(wb, { type: 'buffer', bookType });
}

describe('readWorkbook', () => {
  it('reads date-formatted numbers as dates and fills merged cells', () => {
    const data = xlsx(
      (ws) => {
        ws['D3'] = { t: 'n', v: 46329, z: 'yyyy/mm/dd' };
        ws['E3'] = { t: 'n', v: 46329 };
        ws['!merges'] = [
          { s: { r: 0, c: 2 }, e: { r: 0, c: 3 } },
          { s: { r: 2, c: 5 }, e: { r: 3, c: 5 } },
        ];
      },
      [
        ['No.', '件名', '予定', null, '工数', '分類'],
        [null, null, '開始', '終了', null, null],
        ['1', 'ログイン', null, null, null, 'バグ'],
        ['2', '出荷', null, null, null, null],
      ],
    );
    const wb = readWorkbook(data, 'wbs.xlsx');
    expect(wb.sheetNames).toEqual(['WBS', 'メモ']);
    const g = wb.grid('WBS');
    expect(g[0]).toEqual(['No.', '件名', '予定', '予定', '工数', '分類']);
    expect(g[2][3]).toEqual({ date: '2026-11-03' });
    expect(g[2][4]).toBe(46329);
    expect(g[3][5]).toBe('バグ');
  });

  it('reads the older .xls format', () => {
    const data = xlsx(
      () => {},
      [
        ['No.', '件名'],
        ['1', '帳票の不具合'],
      ],
      'biff8',
    );
    expect(readWorkbook(data, 'old.xls').grid('WBS')).toEqual([
      ['No.', '件名'],
      ['1', '帳票の不具合'],
    ]);
  });

  it('reads CSV in UTF-8 and in Shift-JIS', () => {
    const utf8 = Buffer.from('﻿No.,件名\n1,テスト\n', 'utf8');
    expect(readWorkbook(utf8, 'a.csv').grid('Sheet1')).toEqual([
      ['No.', '件名'],
      ['1', 'テスト'],
    ]);
    // 件名 in Shift-JIS is 8C 8F 96 BC.
    const sjis = Buffer.concat([
      Buffer.from('No.,'),
      Buffer.from([0x8c, 0x8f, 0x96, 0xbc]),
      Buffer.from('\n1,x\n'),
    ]);
    expect(readWorkbook(sjis, 'b.csv').grid('Sheet1')[0]).toEqual([
      'No.',
      '件名',
    ]);
  });

  it('explains files it cannot read', () => {
    expect(() => readWorkbook(Buffer.from('not a workbook'), 'x.xlsx')).toThrow(
      UnreadableFileError,
    );
  });
});
