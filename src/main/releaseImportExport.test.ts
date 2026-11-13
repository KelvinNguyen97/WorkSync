import { DatabaseSync } from 'node:sqlite';
import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './db';
import { Releases } from './releases';
import { releaseWorkbook } from './releaseExcel';
import { releaseHtml } from './releaseHtml';
import {
  applyReleaseImport,
  importSheet,
  parseDate,
  readReleaseImport,
} from './releaseImport';
import {
  defaultTemplate,
  describeTemplate,
  fillTemplate,
} from './releaseTemplate';
import { Store } from './store';
import { EMPTY_MODULE, fileInfo, type ReleaseInput } from '../shared/releases';
import { aiInstructions, columnOf } from '../shared/releaseFormat';

let db: DatabaseSync;
let rel: Releases;
let projectId: string;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
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

async function book(rows: unknown[][], name = 'Sheet1'): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(name);
  for (const r of rows) ws.addRow(r);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
const load = async (data: Uint8Array) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data.buffer as ArrayBuffer);
  return wb;
};

describe('release files', () => {
  it('keeps module ids and per-file text when a release is saved again', () => {
    const r = rel.save(
      projectId,
      release({
        purpose: 'Release purpose',
        modules: [
          mod({
            module: 'X',
            version: '1',
            changes: 'Own change',
            extra: { ticket_no: 'T-1' },
          }),
          mod({ module: 'Y', version: '1' }),
        ],
      }),
    );
    const again = rel.save(
      projectId,
      { ...release({}), modules: [{ ...r.modules[0], version: '2' }] },
      r.id,
    );
    expect(again.modules).toHaveLength(1);
    expect(again.modules[0].id).toBe(r.modules[0].id);
    expect(again.modules[0].extra).toEqual({ ticket_no: 'T-1' });
    const info = fileInfo(r, r.modules[1]);
    expect(info.purpose).toBe('Release purpose');
    expect(info.fromRelease.purpose).toBe(true);
    expect(fileInfo(r, r.modules[0]).changes).toBe('Own change');
  });
});

describe('release import', () => {
  it('finds columns by heading in English or Japanese', () => {
    expect(columnOf('リリース日')).toBe('date');
    expect(columnOf('Release  Version')).toBe('version');
    expect(columnOf('内容（改善点／変更点等）')).toBe('changes');
    expect(columnOf('ﾌｧｲﾙ名')).toBe('fileName');
    expect(columnOf('Ticket No.')).toBeNull();
    expect(aiInstructions()).toContain(
      'Release version (or リリースバージョン)',
    );
  });

  it('reads dates written in several ways', () => {
    expect(parseDate('2026/8/21').date).toBe('2026-08-21');
    expect(parseDate('2026年8月21日').date).toBe('2026-08-21');
    expect(parseDate(new Date(Date.UTC(2026, 7, 21))).date).toBe('2026-08-21');
    expect(parseDate(46255).date).toBe('2026-08-21');
    expect(parseDate('2026/13/02').bad).toBe(true);
    expect(parseDate('').date).toBeNull();
  });

  it('groups rows into releases, reports problems and finds matches', async () => {
    rel.save(
      projectId,
      release({
        releasedOn: '2026-06-07',
        version: '5.4.2',
        modules: [
          mod({ module: 'Module X', environment: 'Prod', version: '1' }),
        ],
      }),
    );
    const data = await book([
      ['Title row'],
      [
        'リリース日',
        '製品',
        'リリースバージョン',
        'ファイル名',
        'モジュール',
        '環境',
        'ファイルバージョン',
        '内容',
        'Ticket No.',
      ],
      [
        '2026/08/21',
        'EMVCon',
        '5.5.0',
        'A.dll',
        'Module X',
        'Prod',
        '7300',
        'Added',
        'T-9',
      ],
      [
        '2026/08/21',
        'EMVCon',
        '5.5.0',
        'B.exe',
        'Module W',
        'Prod',
        '2.4.0',
        '',
        '',
      ],
      [
        '2026/06/07',
        'EMVCon',
        '5.4.2',
        '',
        'Module X',
        'Prod',
        '2',
        'Fixed',
        '',
      ],
      ['2026/13/02', 'EMVCon', '5.6.0', 'C.dll', '', '', '1', '', ''],
      ['2026/09/01', 'EMVCon', '5.7.0', '', '', 'Prod', '1', '', ''],
      [],
    ]);
    const plan = await readReleaseImport(
      data,
      'x.xlsx',
      rel.list(projectId),
      rel.getLists(projectId),
    );
    expect(plan.rows).toBe(5);
    expect(
      plan.releases.map((r) => [r.version, r.files.length, !!r.match]),
    ).toEqual([
      ['5.4.2', 1, true],
      ['5.5.0', 2, false],
      // No file name or module: still a file, shown as No info.
      ['5.7.0', 1, false],
    ]);
    expect(plan.releases[2].files[0]).toMatchObject({
      fileName: '',
      module: '',
      environment: 'Prod',
      version: '1',
    });
    expect(plan.problems.map((p) => [p.row, p.code])).toEqual([[6, 'date']]);
    expect(plan.unknown).toEqual([
      { name: 'Ticket No.', key: 'ticket_no', known: false },
    ]);

    const out = applyReleaseImport(rel, projectId, plan, {
      mode: 'update',
      fields: ['ticket_no'],
    });
    expect(out).toEqual({ added: 2, updated: 1, skipped: 0 });
    const list = rel.list(projectId);
    const old = list.find((r) => r.version === '5.4.2')!;
    expect(old.modules).toHaveLength(1);
    expect(old.modules[0]).toMatchObject({ version: '2', changes: 'Fixed' });
    const added = list.find((r) => r.version === '5.5.0')!;
    expect(added.modules[0].extra).toEqual({ ticket_no: 'T-9' });
    expect(rel.getLists(projectId).fields).toEqual([
      { key: 'ticket_no', name: 'Ticket No.' },
    ]);
  });

  it('merges a file repeated in the same release, keeping both texts', async () => {
    const data = await book([
      [
        'リリース日',
        '製品',
        'リリースバージョン',
        'ファイル名',
        '環境',
        'ファイルバージョン',
        '内容',
        '目的',
      ],
      [
        '2021/07/15',
        'EMVCon',
        '1.0.13',
        'A.dll',
        'Prod',
        '1.0',
        'JCN text',
        'Same',
      ],
      [
        '2021/07/15',
        'EMVCon',
        '1.0.13',
        'A.dll',
        'Prod',
        '1.0',
        '出光 text',
        'Same',
      ],
      ['2021/07/15', 'EMVCon', '1.0.13', 'A.dll', 'Stg', '1.0', '', ''],
      [
        '2021/07/15',
        'EMVCon',
        '1.0.13',
        'a.DLL',
        'Prod',
        '1.0',
        'JCN text',
        '',
      ],
    ]);
    const plan = await readReleaseImport(
      data,
      'x.xlsx',
      [],
      rel.getLists(projectId),
    );
    expect(plan.merged).toBe(2);
    expect(plan.releases).toHaveLength(1);
    const files = plan.releases[0].files;
    expect(files.map((f) => f.environment)).toEqual(['Prod', 'Stg']);
    expect(files[0]).toMatchObject({
      changes: 'JCN text\n出光 text',
      purpose: 'Same',
    });
  });

  it('skips or replaces what the project has', async () => {
    rel.save(projectId, release({ version: '1.0.0' }));
    rel.save(
      projectId,
      release({ version: '0.9.0', releasedOn: '2025-01-01' }),
    );
    const data = await book([
      ['Release date', 'Product', 'Release version', 'Summary'],
      ['2026/01/10', 'EMVCon', '1.0.0', 'Again'],
      ['', 'EMVCon', '2.0.0', 'Next'],
    ]);
    const plan = await readReleaseImport(
      data,
      'x.xlsx',
      rel.list(projectId),
      rel.getLists(projectId),
    );
    expect(plan.releases.map((r) => r.status)).toEqual(['released', 'planned']);
    expect(
      applyReleaseImport(rel, projectId, plan, { mode: 'skip', fields: [] }),
    ).toEqual({ added: 1, updated: 0, skipped: 1 });
    expect(rel.list(projectId)).toHaveLength(3);
    applyReleaseImport(rel, projectId, plan, { mode: 'replace', fields: [] });
    expect(
      rel
        .list(projectId)
        .map((r) => r.version)
        .sort(),
    ).toEqual(['1.0.0', '2.0.0']);
  });

  it('reads its own Excel export back', async () => {
    rel.save(
      projectId,
      release({
        purpose: 'Why',
        modules: [
          mod({
            module: 'X',
            fileName: 'X.dll',
            environment: 'Prod',
            version: '1',
            verification: 'Checked',
          }),
        ],
      }),
    );
    rel.save(
      projectId,
      release({
        version: '2.0.0',
        status: 'planned',
        releasedOn: null,
        summary: 'Later',
      }),
    );
    const data = await releaseWorkbook({
      project: 'POS',
      customer: '',
      releases: rel.list(projectId),
      lists: rel.getLists(projectId),
      language: 'ja',
    });
    const wb = await load(data);
    expect(wb.getWorksheet('取込用データ')?.state).toBe('hidden');
    const plan = await readReleaseImport(
      data,
      'x.xlsx',
      [],
      rel.getLists(projectId),
    );
    expect(plan.ownExport).toBe(true);
    expect(plan.problems).toEqual([]);
    expect(plan.releases).toHaveLength(2);
    expect(plan.releases[0]).toMatchObject({
      purpose: 'Why',
      version: '1.0.0',
    });
    expect(plan.releases[0].files[0]).toMatchObject({
      fileName: 'X.dll',
      verification: 'Checked',
    });
    expect(plan.releases[1]).toMatchObject({
      status: 'planned',
      summary: 'Later',
    });
  });

  it('writes an empty import sheet that reads back', async () => {
    const wb = await load(await importSheet('ja'));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['リリース', '記入例']);
    const plan = await readReleaseImport(
      await importSheet('en'),
      'x.xlsx',
      [],
      rel.getLists(projectId),
    );
    // The example sheet is found and read.
    expect(plan.releases.map((r) => r.version)).toEqual(['5.5.0', '6.0.0']);
  });
});

describe('files without a name', () => {
  it('show as No info in the version table and the latest list', async () => {
    rel.save(
      projectId,
      release({
        modules: [mod({ destination: 'D', environment: 'Prod', version: '1' })],
      }),
    );
    const data = await releaseWorkbook({
      project: 'POS',
      customer: '',
      releases: rel.list(projectId),
      lists: rel.getLists(projectId),
      language: 'ja',
    });
    const wb = await load(data);
    const m = wb.worksheets[0];
    expect([
      m.getCell('A5').text,
      m.getCell('C5').text,
      m.getCell('E5').text,
    ]).toEqual(['D', '情報なし', '1']);
    expect(wb.worksheets[1].getCell('D4').text).toBe('情報なし');
  });
});

describe('release templates', () => {
  beforeEach(() => {
    rel.saveLists(projectId, {
      ...rel.getLists(projectId),
      fields: [{ key: 'ticket_no', name: 'Ticket No.' }],
    });
    rel.save(
      projectId,
      release({
        summary: 'One',
        modules: [
          mod({
            destination: 'D',
            category: 'C',
            module: 'X',
            environment: 'Prod',
            version: '1',
            extra: { ticket_no: 'T-1' },
          }),
        ],
      }),
    );
    rel.save(
      projectId,
      release({
        releasedOn: '2026-02-01',
        version: '1.1.0',
        summary: 'Two',
        modules: [
          mod({
            destination: 'D',
            category: 'C',
            module: 'X',
            environment: 'Prod',
            version: '2',
            changes: 'Faster',
          }),
          mod({
            destination: 'D',
            category: 'C',
            module: 'Y',
            environment: 'Prod',
            version: '1',
          }),
        ],
      }),
    );
    rel.save(
      projectId,
      release({ product: 'OCX', releasedOn: '2026-03-01', version: '3.0' }),
    );
  });
  const data = (o: Partial<Parameters<typeof fillTemplate>[1]> = {}) => ({
    project: 'POS',
    customer: 'ステアリテール',
    today: '2026/11/12',
    releases: rel.list(projectId),
    lists: rel.getLists(projectId),
    language: 'ja' as const,
    includePlanned: false,
    onlyChanged: false,
    ...o,
  });

  it('repeats rows per release and file, keeping their style and merges', async () => {
    const t = new ExcelJS.Workbook();
    const ws = t.addWorksheet('Sheet A');
    ws.getCell('A1').value = 'For {{project.customer}} on {{today}}';
    ws.getCell('A2').value = '{{#releases}}{{release.no}}';
    ws.getCell('B2').value = '{{release.version}}';
    ws.getCell('C2').value = '{{release.summary}}';
    ws.getCell('A3').value = '';
    ws.getCell('B3').value =
      '{{#files}}{{file.name}} {{file.previous}}→{{file.version}}';
    ws.getCell('C3').value = '{{file.ticket_no}}{{/files}}{{/releases}}';
    ws.getCell('B2').font = { bold: true, color: { argb: 'FFFF0000' } };
    ws.mergeCells('C2:D2');
    ws.getCell('A5').value = 'End';
    const out = await fillTemplate(
      new Uint8Array(await t.xlsx.writeBuffer()),
      data(),
    );
    expect(out.unknown).toEqual([]);
    const o = (await load(out.data)).getWorksheet('Sheet A')!;
    const col = (c: string) =>
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((r) => o.getCell(`${c}${r}`).text);
    expect(col('A')).toEqual([
      'For ステアリテール on 2026/11/12',
      '1',
      '',
      '2',
      '',
      '',
      '3',
      '',
      'End',
    ]);
    expect(col('B').slice(1, 7)).toEqual([
      '1.0.0',
      'X →1',
      '1.1.0',
      'X 1→2',
      'Y →1',
      '3.0',
    ]);
    expect(col('C').slice(1, 4)).toEqual(['One', 'T-1', 'Two']);
    expect(o.getCell('B4').font?.bold).toBe(true);
    expect(o.getCell('A2').value).toBe(1);
    expect(o.getCell('C4').isMerged).toBe(true);
  });

  it('makes a sheet per product and the matrix', async () => {
    const t = await load(await defaultTemplate('ja', rel.getLists(projectId)));
    expect(t.worksheets.map((w) => w.name)).toContain('#使い方');
    const info = await describeTemplate(
      new Uint8Array(await t.xlsx.writeBuffer()),
    );
    expect(info.sheets).toBe(4);
    const out = await fillTemplate(
      new Uint8Array(await t.xlsx.writeBuffer()),
      data({ onlyChanged: true }),
    );
    const wb = await load(out.data);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'モジュールバージョン一覧',
      'リリースモジュール一覧',
      'リリース履歴一覧(EMVCon)',
      'リリース履歴一覧(OCX)',
      'ファイル別リリース内容',
    ]);
    const m = wb.worksheets[0];
    expect(m.getCell('A1').text).toBe(
      'モジュールバージョン一覧（ステアリテール様 提出用）',
    );
    expect(m.getCell('A3').text).toBe('仕向け先');
    expect(m.getCell('E4').text).toBe('2026/01/10');
    // X: 1 then 2; Y: only from the second date. Only changed versions shown.
    expect([m.getCell('E5').text, m.getCell('F5').text]).toEqual(['1', '2']);
    expect([m.getCell('E6').text, m.getCell('F6').text]).toEqual(['', '1']);
    const f = wb.worksheets[4];
    expect(f.getRow(3).getCell(13).text).toBe('Ticket No.');
    expect(f.getRow(4).getCell(13).text).toBe('T-1');
    expect(f.getRow(5).getCell(10).text).toBe('Faster');
  });

  it('refuses a workbook without markers, or a block not closed', async () => {
    await expect(describeTemplate(await book([['Plain']]))).rejects.toThrow(
      /no markers/,
    );
    await expect(
      describeTemplate(await book([['{{#releases}}']])),
    ).rejects.toThrow(/without closing/);
  });
});

describe('release HTML page', () => {
  it('is one file with the data inside, safe from what the text holds', () => {
    rel.save(
      projectId,
      release({
        summary: '</script><b>x</b>',
        modules: [mod({ module: 'X', version: '1' })],
      }),
    );
    rel.save(
      projectId,
      release({ version: '2.0', status: 'planned', releasedOn: null }),
    );
    const html = releaseHtml({
      project: 'POS <1>',
      customer: 'A&B',
      today: '2026/11/12',
      releases: rel.list(projectId),
      lists: rel.getLists(projectId),
      language: 'en',
      theme: 'dark',
      includePlanned: false,
    });
    expect(html).toContain('<title>POS &lt;1&gt; — Releases</title>');
    expect(html).toContain('data-theme="dark"');
    expect(html).not.toContain('</script><b>');
    expect(html).not.toMatch(/src="http|href="http/);
    const json =
      /<script type="application\/json" id="data">(.*?)<\/script>/s.exec(
        html,
      )![1];
    const d = JSON.parse(json);
    expect(d.releases).toHaveLength(1);
    expect(d.releases[0].summary).toBe('</script><b>x</b>');
  });
});
