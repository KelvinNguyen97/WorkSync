import * as XLSX from 'xlsx';
import { cellRef, type CellEdit, type SkippedCell } from './xlsxCells';

/**
 * Edits single cells inside an Excel 97-2003 .xls file (spec 04, Writing to
 * the owner's copy), the way the .xlsx writer does: only the records of the
 * cells written change, and every other record is copied byte for byte, so
 * formatting, formulas, merged cells, macros and other sheets stay as they
 * are. Changing a record's length moves the records after it, so the
 * positions the file keeps of its own parts (sheet starts, row indexes and
 * the string table index) are moved with them.
 */

const T = {
  BOF: 0x0809,
  EOF: 0x000a,
  FILEPASS: 0x002f,
  DATE1904: 0x0022,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  CONTINUE: 0x003c,
  EXTSST: 0x00ff,
  INDEX: 0x020b,
  DBCELL: 0x00d7,
  ROW: 0x0208,
  MERGECELLS: 0x00e5,
  FORMULA: 0x0006,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  RSTRING: 0x00d6,
  NUMBER: 0x0203,
  RK: 0x027e,
  BOOLERR: 0x0205,
  BLANK: 0x0201,
  MULRK: 0x00bd,
  MULBLANK: 0x00be,
} as const;

const SINGLE_CELLS = new Set<number>([
  T.LABELSST,
  T.LABEL,
  T.RSTRING,
  T.NUMBER,
  T.RK,
  T.BOOLERR,
  T.BLANK,
  T.FORMULA,
]);
const MAX_RECORD = 8224;

interface Rec {
  type: number;
  data: Buffer;
  /** Where the record started in the original stream; null for a new record. */
  at: number | null;
}

export class XlsWriteError extends Error {}

function records(stream: Buffer): Rec[] {
  const out: Rec[] = [];
  let p = 0;
  while (p + 4 <= stream.length) {
    const type = stream.readUInt16LE(p);
    const len = stream.readUInt16LE(p + 2);
    if (p + 4 + len > stream.length) break;
    out.push({ type, data: stream.subarray(p + 4, p + 4 + len), at: p });
    p += 4 + len;
  }
  return out;
}

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};

/** The shared strings, with where each one starts, so new ones can be added after them. */
interface SstInfo {
  /** Record indexes of the SST and its CONTINUE records. */
  recs: number[];
  strings: { text: string; plain: boolean }[];
  /** Absolute stream position and offset within its record, for the EXTSST index. */
  pos: { ib: number; cb: number }[];
  total: number;
}

function readSst(recs: Rec[], first: number): SstInfo {
  const chain = [first];
  for (let i = first + 1; i < recs.length && recs[i].type === T.CONTINUE; i++)
    chain.push(i);
  // Each segment is the data of one record; the SST's own data starts after its two counts.
  const segs = chain.map((i, k) => ({
    data: k === 0 ? recs[i].data.subarray(8) : recs[i].data,
    start: recs[i].at! + 4 + (k === 0 ? 8 : 0),
    head: k === 0 ? 12 : 4,
  }));
  const total = recs[first].data.readUInt32LE(0);
  const unique = recs[first].data.readUInt32LE(4);
  let s = 0;
  let o = 0;
  const next = () => {
    s++;
    o = 0;
    if (s >= segs.length)
      throw new XlsWriteError('The string table ends early.');
  };
  const take = (n: number) => {
    let left = n;
    while (left > 0) {
      if (o >= segs[s].data.length) next();
      const k = Math.min(left, segs[s].data.length - o);
      o += k;
      left -= k;
    }
  };
  const strings: SstInfo['strings'] = [];
  const pos: SstInfo['pos'] = [];
  for (let n = 0; n < unique; n++) {
    if (o >= segs[s].data.length) next();
    pos.push({ ib: segs[s].start + o, cb: segs[s].head + o });
    const d = segs[s].data;
    const cch = d.readUInt16LE(o);
    let flags = d.readUInt8(o + 2);
    o += 3;
    const rich = (flags & 0x08) !== 0;
    const ext = (flags & 0x04) !== 0;
    let runs = 0;
    let extLen = 0;
    if (rich) {
      runs = segs[s].data.readUInt16LE(o);
      o += 2;
    }
    if (ext) {
      extLen = segs[s].data.readUInt32LE(o);
      o += 4;
    }
    let text = '';
    let left = cch;
    while (left > 0) {
      if (o >= segs[s].data.length) {
        next();
        flags = segs[s].data.readUInt8(0);
        o = 1;
      }
      const wide = (flags & 0x01) !== 0;
      const per = wide ? 2 : 1;
      const k = Math.min(left, Math.floor((segs[s].data.length - o) / per));
      const bytes = segs[s].data.subarray(o, o + k * per);
      text += wide ? bytes.toString('utf16le') : bytes.toString('latin1');
      o += k * per;
      left -= k;
      if (k === 0 && left > 0) o = segs[s].data.length;
    }
    take(runs * 4);
    take(extLen);
    strings.push({ text, plain: !rich && !ext });
  }
  return { recs: chain, strings, pos, total };
}

/** Days since the workbook's date base, as Excel stores dates. */
const serial = (iso: string, base1904: boolean) => {
  const [y, m, d] = iso.split('-').map(Number);
  const days = Math.round(
    (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000,
  );
  return base1904 ? days - 1462 : days;
};

function numberRecord(row: number, col: number, xf: number, v: number): Rec {
  if (Number.isInteger(v) && v >= 0 && v < 2 ** 29) {
    const d = Buffer.alloc(10);
    d.writeUInt16LE(row, 0);
    d.writeUInt16LE(col, 2);
    d.writeUInt16LE(xf, 4);
    d.writeUInt32LE(((v << 2) | 0x2) >>> 0, 6);
    return { type: T.RK, data: d, at: null };
  }
  const d = Buffer.alloc(14);
  d.writeUInt16LE(row, 0);
  d.writeUInt16LE(col, 2);
  d.writeUInt16LE(xf, 4);
  d.writeDoubleLE(v, 6);
  return { type: T.NUMBER, data: d, at: null };
}

function cellRecord(
  type: number,
  row: number,
  col: number,
  xf: number,
  rest: Buffer,
): Rec {
  const d = Buffer.alloc(6 + rest.length);
  d.writeUInt16LE(row, 0);
  d.writeUInt16LE(col, 2);
  d.writeUInt16LE(xf, 4);
  rest.copy(d, 6);
  return { type, data: d, at: null };
}

/** Splits a MULRK or MULBLANK around one column into the records before, the cell, and after. */
function splitMul(
  rec: Rec,
  col: number,
): { before: Rec[]; xf: number; after: Rec[] } {
  const d = rec.data;
  const row = d.readUInt16LE(0);
  const first = d.readUInt16LE(2);
  const last = d.readUInt16LE(d.length - 2);
  const size = rec.type === T.MULRK ? 6 : 2;
  const item = (c: number) =>
    d.subarray(4 + (c - first) * size, 4 + (c - first + 1) * size);
  const group = (from: number, to: number): Rec[] => {
    if (from > to) return [];
    if (from === to) {
      const it = item(from);
      return rec.type === T.MULRK
        ? [cellRecord(T.RK, row, from, it.readUInt16LE(0), it.subarray(2))]
        : [cellRecord(T.BLANK, row, from, it.readUInt16LE(0), Buffer.alloc(0))];
    }
    const parts: Buffer[] = [u16(row), u16(from)];
    for (let c = from; c <= to; c++) parts.push(Buffer.from(item(c)));
    parts.push(u16(to));
    return [{ type: rec.type, data: Buffer.concat(parts), at: null }];
  };
  return {
    before: group(first, col - 1),
    xf: item(col).readUInt16LE(0),
    after: group(col + 1, last),
  };
}

export function editXlsCells(
  data: Uint8Array,
  sheet: string,
  edits: CellEdit[],
): { data: Uint8Array; skipped: SkippedCell[]; written: string[] } {
  const cfb = XLSX.CFB.read(Buffer.from(data), { type: 'buffer' });
  const entry = XLSX.CFB.find(cfb, 'Workbook') ?? XLSX.CFB.find(cfb, 'Book');
  if (!entry || entry.name !== 'Workbook')
    throw new XlsWriteError(
      'This .xls file is in a format older than Excel 97. Save it as .xlsx in Excel and link that.',
    );
  const stream = Buffer.from(entry.content as Uint8Array);
  const recs = records(stream);
  if (recs[0]?.type !== T.BOF || recs[0].data.readUInt16LE(0) !== 0x0600)
    throw new XlsWriteError(
      'This .xls file is not in the Excel 97-2003 format.',
    );

  // The workbook part: sheet positions, the string table and the date base.
  let base1904 = false;
  let sstAt = -1;
  let extsstAt = -1;
  const sheets: { rec: number; name: string; at: number }[] = [];
  let i = 0;
  for (; i < recs.length && recs[i].type !== T.EOF; i++) {
    const r = recs[i];
    if (r.type === T.FILEPASS)
      throw new XlsWriteError('This .xls file is protected with a password.');
    if (r.type === T.DATE1904) base1904 = r.data.readUInt16LE(0) === 1;
    if (r.type === T.SST && sstAt < 0) sstAt = i;
    if (r.type === T.EXTSST) extsstAt = i;
    if (r.type === T.BOUNDSHEET) {
      const cch = r.data.readUInt8(6);
      const wide = r.data.readUInt8(7) & 1;
      const name = wide
        ? r.data.subarray(8, 8 + cch * 2).toString('utf16le')
        : r.data.subarray(8, 8 + cch).toString('latin1');
      sheets.push({ rec: i, name, at: r.data.readUInt32LE(0) });
    }
  }
  const target = sheets.find((s) => s.name === sheet);
  if (!target)
    throw new XlsWriteError(`The sheet ${sheet} is not in the file.`);
  const sheetStart = recs.findIndex((r) => r.at === target.at);
  if (sheetStart < 0 || recs[sheetStart].type !== T.BOF)
    throw new XlsWriteError('The sheet could not be found inside the file.');
  let sheetEnd = sheetStart + 1;
  while (sheetEnd < recs.length && recs[sheetEnd].type !== T.EOF) sheetEnd++;

  const sst = sstAt >= 0 ? readSst(recs, sstAt) : null;

  // The cells of the sheet, merged areas and the rows of each index block.
  const single = new Map<string, number>();
  const multi = new Map<number, number[]>();
  const rowCells = new Map<number, number[]>();
  const rowRec = new Map<number, number>();
  const merges: { r1: number; r2: number; c1: number; c2: number }[] = [];
  for (let k = sheetStart + 1; k < sheetEnd; k++) {
    const r = recs[k];
    if (r.type === T.ROW) rowRec.set(r.data.readUInt16LE(0), k);
    if (r.type === T.MERGECELLS) {
      const n = r.data.readUInt16LE(0);
      for (let m = 0; m < n; m++) {
        const o = 2 + m * 8;
        merges.push({
          r1: r.data.readUInt16LE(o),
          r2: r.data.readUInt16LE(o + 2),
          c1: r.data.readUInt16LE(o + 4),
          c2: r.data.readUInt16LE(o + 6),
        });
      }
    }
    if (
      SINGLE_CELLS.has(r.type) ||
      r.type === T.MULRK ||
      r.type === T.MULBLANK
    ) {
      const row = r.data.readUInt16LE(0);
      rowCells.set(row, [...(rowCells.get(row) ?? []), k]);
      if (SINGLE_CELLS.has(r.type))
        single.set(`${row},${r.data.readUInt16LE(2)}`, k);
      else multi.set(row, [...(multi.get(row) ?? []), k]);
    }
  }
  const xfAt = (row: number, col: number): number | null => {
    const k = single.get(`${row},${col}`);
    if (k !== undefined) return recs[k].data.readUInt16LE(4);
    for (const m of multi.get(row) ?? []) {
      const d = recs[m].data;
      const first = d.readUInt16LE(2);
      const last = d.readUInt16LE(d.length - 2);
      if (col >= first && col <= last) {
        const size = recs[m].type === T.MULRK ? 6 : 2;
        return d.readUInt16LE(4 + (col - first) * size);
      }
    }
    return null;
  };

  // New strings go at the end of the string table.
  const added: string[] = [];
  let refDelta = 0;
  const isst = (text: string): number => {
    const known =
      sst?.strings.findIndex((s) => s.plain && s.text === text) ?? -1;
    if (known >= 0) return known;
    const mine = added.indexOf(text);
    if (mine >= 0) return (sst?.strings.length ?? 0) + mine;
    added.push(text);
    return (sst?.strings.length ?? 0) + added.length - 1;
  };

  // Replacements: record index → the records that take its place; insertions after a record.
  const replaced = new Map<number, Rec[]>();
  const inserted = new Map<number, Rec[]>();
  const skipped: SkippedCell[] = [];
  const written: string[] = [];
  const done = new Set<string>();
  for (const e of [...edits].sort((a, b) => a.row - b.row || a.col - b.col)) {
    const ref = cellRef(e.row, e.col);
    if (done.has(ref)) continue;
    done.add(ref);
    if (
      merges.some(
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
    const make = (xf: number): Rec | null => {
      if (e.value.kind === 'text') {
        if (e.value.text.length > 2000) return null;
        refDelta++;
        const d = Buffer.alloc(4);
        d.writeUInt32LE(isst(e.value.text));
        return cellRecord(T.LABELSST, e.row, e.col, xf, d);
      }
      if (e.value.kind === 'date')
        return numberRecord(e.row, e.col, xf, serial(e.value.iso, base1904));
      return cellRecord(T.BLANK, e.row, e.col, xf, Buffer.alloc(0));
    };
    const k = single.get(`${e.row},${e.col}`);
    if (k !== undefined) {
      const r = recs[k];
      if (r.type === T.FORMULA) {
        skipped.push({
          ref,
          reason: 'The cell has a formula. Update it in Excel.',
        });
        continue;
      }
      // A cell added before this one in the row may already sit in its place.
      const list = replaced.get(k) ?? [r];
      const at = list.indexOf(r);
      if (at < 0) continue;
      const rec = make(r.data.readUInt16LE(4));
      if (!rec) {
        skipped.push({
          ref,
          reason: 'The text is too long for this file. Update it in Excel.',
        });
        continue;
      }
      if (r.type === T.LABELSST) refDelta--;
      list[at] = rec;
      replaced.set(k, list);
      written.push(ref);
      continue;
    }
    const m = (multi.get(e.row) ?? []).find((x) => {
      const d = recs[x].data;
      return (
        e.col >= d.readUInt16LE(2) && e.col <= d.readUInt16LE(d.length - 2)
      );
    });
    if (m !== undefined) {
      // Several edits in one MULRK or MULBLANK: split it again around each, from what is there so far.
      const current = replaced.get(m) ?? [recs[m]];
      const out: Rec[] = [];
      let ok = false;
      for (const part of current) {
        const d = part.data;
        const isMul = part.type === T.MULRK || part.type === T.MULBLANK;
        const first = isMul ? d.readUInt16LE(2) : d.readUInt16LE(2);
        const last = isMul ? d.readUInt16LE(d.length - 2) : first;
        if (!ok && e.col >= first && e.col <= last) {
          if (isMul) {
            const sp = splitMul(part, e.col);
            const rec = make(sp.xf);
            if (!rec) break;
            out.push(...sp.before, rec, ...sp.after);
          } else {
            const rec = make(d.readUInt16LE(4));
            if (!rec) break;
            out.push(rec);
          }
          ok = true;
        } else out.push(part);
      }
      if (!ok) {
        skipped.push({
          ref,
          reason: 'The text is too long for this file. Update it in Excel.',
        });
        continue;
      }
      replaced.set(m, out);
      written.push(ref);
      continue;
    }
    // No record for the cell: add one inside the row, if the row is there and spans the column.
    const rowK = rowRec.get(e.row);
    const cells = rowCells.get(e.row) ?? [];
    const rowData = rowK !== undefined ? recs[rowK].data : null;
    if (
      !rowData ||
      !cells.length ||
      e.col < rowData.readUInt16LE(2) ||
      e.col >= rowData.readUInt16LE(4)
    ) {
      skipped.push({
        ref,
        reason:
          'The cell has never been used in this .xls file. Update it in Excel, or save the file as .xlsx and link that.',
      });
      continue;
    }
    const xf = xfAt(e.row - 1, e.col) ?? xfAt(e.row, e.col - 1) ?? 0x0f;
    const rec = make(xf);
    if (!rec) {
      skipped.push({
        ref,
        reason: 'The text is too long for this file. Update it in Excel.',
      });
      continue;
    }
    // After the last cell record of the row that comes before the column.
    const colOf = (x: number) => recs[x].data.readUInt16LE(2);
    const before = cells.filter((x) => colOf(x) < e.col);
    if (before.length) {
      const after = before[before.length - 1];
      inserted.set(after, [...(inserted.get(after) ?? []), rec]);
    } else {
      // Before the row's first cell: it takes the place of that record, followed by it.
      const first = cells[0];
      replaced.set(first, [rec, ...(replaced.get(first) ?? [recs[first]])]);
    }
    written.push(ref);
  }

  // The string table: new strings appended and its counts updated.
  const newStrings: { rec: Rec; offset: number }[] = [];
  if (added.length) {
    if (!sst)
      throw new XlsWriteError(
        'This .xls file has no string table to add text to.',
      );
    const chain = sst.recs;
    const head = Buffer.from(recs[chain[0]].data);
    head.writeUInt32LE(Math.max(0, sst.total + refDelta) >>> 0, 0);
    head.writeUInt32LE(sst.strings.length + added.length, 4);
    const out: Rec[] = chain.map((k, n) => ({
      type: recs[k].type,
      data: n === 0 ? head : Buffer.from(recs[k].data),
      at: recs[k].at,
    }));
    for (const text of added) {
      const str = Buffer.concat([
        u16(text.length),
        Buffer.from([0x01]),
        Buffer.from(text, 'utf16le'),
      ]);
      let last = out[out.length - 1];
      if (last.data.length + str.length > MAX_RECORD) {
        last = { type: T.CONTINUE, data: Buffer.alloc(0), at: null };
        out.push(last);
      }
      newStrings.push({ rec: last, offset: last.data.length });
      last.data = Buffer.concat([last.data, str]);
    }
    for (let n = 0; n < chain.length; n++) replaced.set(chain[n], [out[n]]);
    if (out.length > chain.length)
      inserted.set(chain[chain.length - 1], [
        ...(inserted.get(chain[chain.length - 1]) ?? []),
        ...out.slice(chain.length),
      ]);
  } else if (sst && refDelta) {
    const head = Buffer.from(recs[sst.recs[0]].data);
    head.writeUInt32LE(Math.max(0, sst.total + refDelta) >>> 0, 0);
    replaced.set(sst.recs[0], [
      { type: T.SST, data: head, at: recs[sst.recs[0]].at },
    ]);
  }

  // The new stream, record by record, and where each original record now starts.
  const out: Rec[][] = recs.map((r, k) => [
    ...(replaced.get(k) ?? [{ ...r }]),
    ...(inserted.get(k) ?? []),
  ]);
  const size = (list: Rec[]) => list.reduce((n, x) => n + 4 + x.data.length, 0);
  const newAt = new Map<number, number>();
  const recAt = new Map<Rec, number>();
  const place = () => {
    let p = 0;
    out.forEach((list, k) => {
      newAt.set(recs[k].at!, p);
      for (const x of list) {
        recAt.set(x, p);
        p += 4 + x.data.length;
      }
    });
  };
  place();
  const move = (old: number): number => {
    const v = newAt.get(old);
    if (v === undefined)
      throw new XlsWriteError('A position inside the file could not be moved.');
    return v;
  };

  // The string index: one entry per bucket of strings, extended for new buckets.
  if (newStrings.length && extsstAt >= 0 && sst) {
    const old = recs[extsstAt].data;
    const dsst = old.readUInt16LE(0) || 8;
    const have = Math.floor((old.length - 2) / 8);
    const total = sst.strings.length + added.length;
    const buckets = Math.ceil(total / dsst);
    // Whether this file counts the offset from the record header or from its data.
    const conv =
      have && sst.pos.length ? old.readUInt16LE(6) - sst.pos[0].cb : 0;
    if (buckets > have && buckets <= 128) {
      const entries: Buffer[] = [old];
      for (let b = have; b < buckets; b++) {
        const n = b * dsst;
        const e8 = Buffer.alloc(8);
        if (n < sst.strings.length) {
          const known = sst.pos[n];
          const chainStart = recs[sst.recs[0]].at!;
          e8.writeUInt32LE(move(chainStart) + (known.ib - chainStart), 0);
          e8.writeUInt16LE(known.cb + conv, 4);
        } else {
          const ns = newStrings[n - sst.strings.length];
          e8.writeUInt32LE(recAt.get(ns.rec)! + 4 + ns.offset, 0);
          e8.writeUInt16LE(4 + ns.offset + conv, 4);
        }
        entries.push(e8);
      }
      out[extsstAt] = [
        { type: T.EXTSST, data: Buffer.concat(entries), at: recs[extsstAt].at },
      ];
      place();
    }
  }

  const setData = (k: number, d: Buffer) => {
    out[k][0] = { ...out[k][0], data: d };
  };
  // Sheet starts.
  for (const sh of sheets) {
    const d = Buffer.from(recs[sh.rec].data);
    d.writeUInt32LE(move(d.readUInt32LE(0)), 0);
    setData(sh.rec, d);
  }
  // Row index blocks in every sheet: each DBCELL's offsets, and the INDEX positions.
  let blockRows: number[] = [];
  const rowDelta = new Map<number, number>();
  for (let k = 0; k < recs.length; k++) {
    const r = recs[k];
    const delta = size(out[k]) - (4 + r.data.length);
    if (r.type === T.BOF) {
      blockRows = [];
      rowDelta.clear();
    } else if (r.type === T.ROW) blockRows.push(r.data.readUInt16LE(0));
    else if (
      delta &&
      (SINGLE_CELLS.has(r.type) || r.type === T.MULRK || r.type === T.MULBLANK)
    ) {
      const row = r.data.readUInt16LE(0);
      rowDelta.set(row, (rowDelta.get(row) ?? 0) + delta);
    } else if (r.type === T.DBCELL) {
      const d = Buffer.from(r.data);
      const at = r.at!;
      d.writeUInt32LE(move(at) - move(at - r.data.readUInt32LE(0)), 0);
      // Each offset runs from the first cell of the row before; it grows by what that row grew.
      for (let j = 1; j < blockRows.length && 4 + j * 2 + 2 <= d.length; j++) {
        const grew = rowDelta.get(blockRows[j - 1]) ?? 0;
        if (grew) d.writeUInt16LE(d.readUInt16LE(4 + j * 2) + grew, 4 + j * 2);
      }
      setData(k, d);
      blockRows = [];
      rowDelta.clear();
    }
  }
  for (let k = 0; k < recs.length; k++) {
    if (recs[k].type !== T.INDEX) continue;
    const d = Buffer.from(recs[k].data);
    for (let j = 16; j + 4 <= d.length; j += 4) {
      const v = d.readUInt32LE(j);
      if (v && newAt.has(v)) d.writeUInt32LE(move(v), j);
    }
    const xfPos = d.readUInt32LE(12);
    if (xfPos && newAt.has(xfPos)) d.writeUInt32LE(move(xfPos), 12);
    setData(k, d);
  }
  const flat = out.flat();

  const parts: Buffer[] = [];
  for (const r of flat) {
    if (r.data.length > MAX_RECORD + 4)
      throw new XlsWriteError('A record became too large.');
    const h = Buffer.alloc(4);
    h.writeUInt16LE(r.type, 0);
    h.writeUInt16LE(r.data.length, 2);
    parts.push(h, r.data);
  }
  // Anything after the last record, such as padding, stays.
  const tail = stream.subarray(
    recs.length
      ? recs[recs.length - 1].at! + 4 + recs[recs.length - 1].data.length
      : 0,
  );
  const result = Buffer.concat([...parts, tail]);
  entry.content = result;
  entry.size = result.length;
  const file = XLSX.CFB.write(cfb, {
    type: 'buffer',
    fileType: 'cfb',
  }) as Buffer;
  return { data: new Uint8Array(file), skipped, written };
}
