import { describe, expect, it } from 'vitest';
import * as cptable from 'xlsx/dist/cpexcel.full.mjs';
import { editCsvCells } from './csvCells';

const sjis = (s: string) =>
  Uint8Array.from(
    (
      cptable as unknown as {
        utils: { encode: (c: number, s: string) => ArrayLike<number> };
      }
    ).utils.encode(932, s),
  );
const text = (b: Uint8Array, enc = 'utf-8') => new TextDecoder(enc).decode(b);

describe('writing fields into CSV files', () => {
  it('changes only the fields written, keeping quotes, line endings and the end of the file', () => {
    const src =
      'No.,件名,状態\r\n1,"ログイン, 画面",対応中\r\n2,"CSV",未着手\r\n';
    const r = editCsvCells(new TextEncoder().encode(src), [
      { row: 1, col: 2, value: { kind: 'text', text: '完了' } },
      { row: 2, col: 1, value: { kind: 'text', text: 'CSV "取込"' } },
    ]);
    expect(text(r.data)).toBe(
      'No.,件名,状態\r\n1,"ログイン, 画面",完了\r\n2,"CSV ""取込""",未着手\r\n',
    );
    expect(r.written).toEqual(['C2', 'B3']);
  });

  it('adds fields to a short row and writes dates like the column', () => {
    const src = 'a,b,c\n1,2026-11-01\n2\n';
    const r = editCsvCells(new TextEncoder().encode(src), [
      { row: 2, col: 1, value: { kind: 'date', iso: '2026-12-01' } },
      { row: 2, col: 2, value: { kind: 'text', text: 'x' } },
    ]);
    expect(text(r.data)).toBe('a,b,c\n1,2026-11-01\n2,2026-12-01,x\n');
  });

  it('keeps Shift-JIS and the byte order mark, and refuses what Shift-JIS cannot hold', () => {
    const src = 'No.,状態\r\n1,対応中\r\n';
    const r = editCsvCells(sjis(src), [
      { row: 1, col: 1, value: { kind: 'text', text: '完了' } },
    ]);
    expect(text(r.data, 'shift_jis')).toBe('No.,状態\r\n1,完了\r\n');
    const bad = editCsvCells(sjis(src), [
      { row: 1, col: 1, value: { kind: 'text', text: 'done 😀' } },
    ]);
    expect(bad.skipped[0].reason).toMatch(/Shift-JIS/);
    const bom = editCsvCells(
      new Uint8Array([
        0xef,
        0xbb,
        0xbf,
        ...new TextEncoder().encode('a\tb\n1\t2\n'),
      ]),
      [{ row: 1, col: 1, value: { kind: 'text', text: '3' } }],
    );
    expect(Array.from(bom.data.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(text(bom.data.slice(3))).toBe('a\tb\n1\t3\n');
    expect(
      editCsvCells(new TextEncoder().encode('a\n'), [
        { row: 5, col: 0, value: { kind: 'empty' } },
      ]).skipped[0].reason,
    ).toMatch(/not in the file/);
  });
});
