import { DatabaseSync } from 'node:sqlite';
import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './db';
import { Releases } from './releases';
import { releaseWorkbook } from './releaseExcel';
import { Store } from './store';
import {
  EMPTY_MODULE,
  latestModules,
  versionMatrix,
  type ReleaseInput,
} from '../shared/releases';

let rel: Releases;
let projectId: string;
beforeEach(() => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  projectId = new Store(db).createProject({
    name: 'POS',
    customer: 'ステアリテール',
    originalLanguages: ['ja'],
    workingLanguage: 'en',
  }).id;
  rel = new Releases(db);
});

const release = (o: Partial<ReleaseInput>): ReleaseInput => ({
  product: 'EMVCon',
  target: 'Target A',
  releasedOn: '2026-01-10',
  version: '1.0.0',
  status: 'released',
  summary: '',
  purpose: '',
  changes: '',
  verification: '',
  modules: [],
  ...o,
});
const mod = (o: Partial<typeof EMPTY_MODULE>) => ({ ...EMPTY_MODULE, ...o });

describe('releases', () => {
  it('keeps a release with its modules, and adds new names to the lists', () => {
    const r = rel.save(
      projectId,
      release({
        summary: 'First release',
        modules: [
          mod({
            destination: 'Destination C',
            category: 'Category 1',
            type: 'Target A',
            module: 'Module X',
            fileName: 'X.dll',
            environment: 'Prod',
            version: '1.0.0',
          }),
          mod({ version: '' }),
        ],
      }),
    );
    expect(r.modules).toHaveLength(1);
    expect(rel.list(projectId)[0].summary).toBe('First release');
    expect(rel.getLists(projectId)).toMatchObject({
      products: ['EMVCon'],
      editions: ['Target A'],
      destinations: ['Destination C'],
      categories: ['Category 1'],
      environments: ['Dev', 'Stg', 'Prod'],
    });
    const changed = rel.save(
      projectId,
      { ...release({ version: '1.0.1' }) },
      r.id,
    );
    expect(changed.version).toBe('1.0.1');
    expect(changed.modules).toHaveLength(0);
    rel.delete(r.id);
    expect(rel.list(projectId)).toHaveLength(0);
  });

  it('refuses a release without product, version or date', () => {
    expect(() => rel.save(projectId, release({ product: ' ' }))).toThrow(
      /product/,
    );
    expect(() => rel.save(projectId, release({ version: '' }))).toThrow(
      /version/,
    );
    expect(() => rel.save(projectId, release({ releasedOn: null }))).toThrow(
      /release date/,
    );
    // A planned one may wait for its date.
    expect(
      rel.save(projectId, release({ releasedOn: null, status: 'planned' }))
        .status,
    ).toBe('planned');
    // A file without a name is kept ("No info" where it is shown).
    expect(
      rel.save(projectId, release({ modules: [mod({ version: '1' })] }))
        .modules,
    ).toHaveLength(1);
  });

  it('shows the version in use on every release date, carried forward', () => {
    const a = rel.save(
      projectId,
      release({
        releasedOn: '2026-01-10',
        modules: [
          mod({
            destination: 'D',
            module: 'X',
            environment: 'Prod',
            version: '1',
          }),
          mod({
            destination: 'D',
            module: 'Y',
            environment: 'Prod',
            version: 'a',
          }),
        ],
      }),
    );
    rel.save(
      projectId,
      release({
        releasedOn: '2026-03-01',
        version: '1.1',
        modules: [
          mod({
            destination: 'D',
            module: 'X',
            environment: 'Prod',
            version: '2',
          }),
        ],
      }),
    );
    rel.save(
      projectId,
      release({ releasedOn: null, status: 'planned', version: '2.0' }),
    );
    const list = rel.list(projectId);
    const m = versionMatrix(list, rel.getLists(projectId));
    expect(m.dates).toEqual(['2026-01-10', '2026-03-01']);
    expect(m.rows.map((r) => [r.module, r.versions])).toEqual([
      ['X', ['1', '2']],
      ['Y', ['a', 'a']],
    ]);
    expect(
      latestModules(list, rel.getLists(projectId)).map((x) => [
        x.module,
        x.version,
      ]),
    ).toEqual([
      ['X', '2'],
      ['Y', 'a'],
    ]);
    expect(a.id).toBeTruthy();
  });

  it('writes the workbook in the customer’s layout', async () => {
    rel.save(
      projectId,
      release({
        product: 'OCX_DLL',
        releasedOn: '2026-02-01',
        version: '3.8.11',
        summary: '概要',
        purpose: '目的',
        changes: '内容',
        verification: '検証',
        modules: [
          mod({
            destination: 'Destination C',
            category: 'Category 1',
            module: 'Module X',
            environment: 'Prod',
            version: '7258_694835',
            type: 'Target A',
            fileName: 'FakeFile_21.dll',
          }),
        ],
      }),
    );
    rel.save(
      projectId,
      release({
        product: 'EMVCon',
        releasedOn: '2025-12-01',
        version: '5.4.2',
      }),
    );
    const data = await releaseWorkbook({
      project: 'POS',
      customer: 'ステアリテール',
      releases: rel.list(projectId),
      lists: rel.getLists(projectId),
      language: 'ja',
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(data.buffer as ArrayBuffer);
    expect(wb.worksheets.map((s) => s.name)).toEqual([
      'モジュールバージョン一覧',
      'リリースモジュール一覧',
      // In the order of the project's product list.
      'リリース履歴一覧(OCX_DLL)',
      'リリース履歴一覧(EMVCon)',
      // Hidden: the releases in the import format, to read the file back.
      '取込用データ',
    ]);
    const m = wb.worksheets[0];
    expect(m.getCell('A1').value).toBe(
      'モジュールバージョン一覧（ステアリテール様 提出用）',
    );
    expect(m.getCell('A3').value).toBe('仕向け先');
    expect(m.getCell('E3').value).toBe('ファイル名 / バージョン');
    expect(m.getCell('E4').value).toBe('2026/02/01');
    expect(m.getCell('C5').value).toBe('Module X');
    expect(m.getCell('E5').value).toBe('7258_694835');
    const l = wb.worksheets[1];
    expect([3, 4, 5, 6, 7].map((c) => l.getRow(4).getCell(c).value)).toEqual([
      'Target A',
      'FakeFile_21.dll',
      '2026/02/01',
      '7258_694835',
      'Prod',
    ]);
    const h = wb.worksheets[2];
    expect(
      [2, 3, 4, 5, 6, 7, 8, 9].map((c) => h.getRow(3).getCell(c).value),
    ).toEqual([
      'No.',
      '対象版',
      'リリース日',
      'リリースバージョン',
      '概要',
      '目的',
      '内容（改善点／変更点等）',
      '検証',
    ]);
    expect(h.getRow(4).getCell(5).value).toBe('3.8.11');
  });
});
