import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { FileFormat } from '../shared/importRules';
import { CopyWriter } from './copyWriter';
import { migrate } from './db';
import { FileLinks } from './fileLinks';
import { Sources } from './sources';
import { Store } from './store';
import { readWorkbook } from './workbook';

const FORMAT: FileFormat = {
  name: 'WBS',
  sheet: 'WBS',
  headerRows: [0],
  columns: {
    customerId: 0,
    title: 1,
    status: 2,
    priority: 3,
    plannedEnd: 4,
    remarks: 5,
  },
  statusWords: { 未着手: 'Not started', 対応中: 'In progress', 完了: 'Done' },
  priorityWords: { 高: 'H', 中: 'N' },
};

let dir: string;
let store: Store;
let sources: Sources;
let writer: CopyWriter;
let file: string;
let sourceId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worksync-copy-'));
  const ws = XLSX.utils.aoa_to_sheet([
    ['No.', '件名', '状態', '優先度', '期限', '備考'],
    ['1', 'ログイン', '対応中', '高', null, ''],
    ['2', '出荷CSV', '未着手', '中', null, ''],
  ]);
  ws['E2'] = { t: 'n', v: 46336, z: 'yyyy/mm/dd' };
  ws['E3'] = { t: 'n', v: 46346, z: 'yyyy/mm/dd' };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'WBS');
  fs.mkdirSync(path.join(dir, 'box'));
  file = path.join(dir, 'box', 'WBS.xlsx');
  fs.writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  store = new Store(db);
  sources = new Sources(db, store);
  const links = new FileLinks(sources, path.join(dir, 'snapshots'));
  writer = new CopyWriter(db, store, sources, links, path.join(dir, 'copies'));
  const projectId = store.createProject({
    name: 'P',
    customer: '',
    originalLanguages: ['ja', 'en'],
    workingLanguage: 'en',
  }).id;
  sourceId = 'src1';
  const v = links.readVersion(
    {
      id: sourceId,
      path: file,
      pattern: null,
      currentFile: file,
      format: FORMAT,
    },
    file,
  );
  sources.link(
    { projectId, file, pattern: null, format: FORMAT, mainLanguage: 'ja' },
    v,
    sourceId,
  );
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const task = (id: string) =>
  store.listTasks().find((t) => t.customerId === id)!;

describe('CopyWriter', () => {
  it('lists the owner’s changes as cells, in the file’s own words', () => {
    store.updateTask(task('1').id, {
      status: 'Done',
      plannedEnd: '2026-11-12',
      remarks: 'Fixed in v2',
    });
    const [plan] = writer.plans();
    expect(plan.blocked).toBeNull();
    expect(
      plan.changes.map((c) => [
        c.cell,
        c.label,
        c.from,
        c.to,
        !!c.languageWarning,
      ]),
    ).toEqual([
      ['E2', 'Planned end', '2026/11/10', '2026/11/12', false],
      ['C2', 'Status', '対応中', '完了', false],
      ['F2', 'Remarks', '', 'Fixed in v2', true],
    ]);
  });

  it('writes a checked copy outside the linked folder, and the changes stop being pending', () => {
    const t = task('1');
    store.updateTask(t.id, { status: 'Done', plannedEnd: '2026-11-12' });
    const plan = writer.plans()[0];
    const r = writer.write(
      sourceId,
      plan.changes.map((c) => `${c.taskId}:${c.field}`),
      path.join(dir, 'copies'),
    );
    expect(r.written).toBe(2);
    expect(r.skipped).toEqual([]);
    expect(path.basename(r.file)).toMatch(/^WBS_\d{8}_WorkSync\.xlsx$/);
    const g = readWorkbook(fs.readFileSync(r.file), r.file).grid('WBS');
    expect(g[1].slice(0, 5)).toEqual([
      '1',
      'ログイン',
      '完了',
      '高',
      { date: '2026-11-12' },
    ]);
    expect(g[2].slice(0, 5)).toEqual([
      '2',
      '出荷CSV',
      '未着手',
      '中',
      { date: '2026-11-20' },
    ]);
    // The customer's file is untouched.
    expect(readWorkbook(fs.readFileSync(file), file).grid('WBS')[1][2]).toBe(
      '対応中',
    );
    expect(writer.plans()).toEqual([]);
    expect(store.listActivity(t.id)[0]).toMatchObject({ kind: 'Write-back' });
    expect(store.listActivity(t.id)[0].text).toContain('Status 対応中 → 完了');
    // A second copy the same day gets its own name.
    store.updateTask(t.id, { plannedEnd: '2026-11-13' });
    const r2 = writer.write(
      sourceId,
      writer.plans()[0].changes.map((c) => `${c.taskId}:${c.field}`),
      path.join(dir, 'copies'),
    );
    expect(path.basename(r2.file)).toMatch(/_WorkSync-2\.xlsx$/);
  });

  it('refuses to write into the linked file’s folder or Box', () => {
    store.updateTask(task('1').id, { status: 'Done' });
    const keys = writer.plans()[0].changes.map((c) => `${c.taskId}:${c.field}`);
    expect(() => writer.write(sourceId, keys, path.join(dir, 'box'))).toThrow(
      'linked customer file',
    );
    expect(() =>
      writer.write(sourceId, keys, path.join(dir, 'Box', 'x')),
    ).toThrow('inside Box');
  });

  it('waits for a new version to be reviewed first', () => {
    store.updateTask(task('1').id, { status: 'Done' });
    const ws = XLSX.utils.aoa_to_sheet([
      ['No.', '件名', '状態'],
      ['1', 'ログイン', '完了'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'WBS');
    fs.writeFileSync(
      file,
      XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }),
    );
    expect(writer.plans()[0].blocked).toContain('Review it first');
    expect(() =>
      writer.write(sourceId, ['x'], path.join(dir, 'copies')),
    ).toThrow('Review it first');
  });

  it('flags a status the format has no word for', () => {
    store.updateTask(task('2').id, { status: 'On hold' });
    expect(writer.plans()[0].changes[0].problem).toContain(
      'no word for On hold',
    );
  });
});
