import { describe, expect, it } from 'vitest';
import {
  columnFree,
  columnLetter,
  compareVersions,
  distinctValues,
  excelSerialToDate,
  headerNames,
  parseDate,
  proposeLevel,
  proposeStatus,
  readRows,
  suggestHeaderRow,
  suggestHeaderRows,
  suggestMapping,
  type FileFormat,
  type Grid,
  type ImportedRow,
} from './importRules';

const READ = '2026-11-03';

describe('parseDate', () => {
  it.each([
    ['2026/11/03', '2026-11-03'],
    ['2026-11-3', '2026-11-03'],
    ['2026.11.3', '2026-11-03'],
    ['2026年11月3日', '2026-11-03'],
    ['２０２６／１１／０３', '2026-11-03'],
    ['令和8年11月3日', '2026-11-03'],
    ['R8.11.3', '2026-11-03'],
    ['r8/11/3', '2026-11-03'],
    ['H31.4.30', '2019-04-30'],
    ['令和元年5月1日', '2019-05-01'],
    ['2026/11/03(火)', '2026-11-03'],
    ['11/3', '2026-11-03'],
    ['11月3日', '2026-11-03'],
  ])('reads %s', (text, iso) => {
    expect(parseDate(text, READ)).toBe(iso);
  });

  it('picks the year closest to the day the file was read for dates without a year', () => {
    expect(parseDate('1/10', '2026-12-20')).toBe('2027-01-10');
    expect(parseDate('12/20', '2027-01-05')).toBe('2026-12-20');
  });

  it('reads Excel serial numbers and rejects nonsense', () => {
    expect(excelSerialToDate(46329)).toBe('2026-11-03');
    expect(parseDate(46329, READ)).toBe('2026-11-03');
    expect(parseDate({ date: '2026-11-03' }, READ)).toBe('2026-11-03');
    expect(parseDate('2026/2/30', READ)).toBeNull();
    expect(parseDate('未定', READ)).toBeNull();
    expect(parseDate('', READ)).toBeNull();
  });
});

/** A typical WBS: a title block, two header rows, a section title, tasks and a total. */
const WBS: Grid = [
  ['プロジェクト：物流ポータル刷新', null, null, null, null, null, null, null],
  ['更新日', '2026/11/01', null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  [
    'No.',
    '件名',
    '担当者',
    '予定',
    null,
    '実績',
    null,
    '状態',
    '優先度',
    '備考',
    '進捗率',
  ],
  [null, null, null, '開始', '終了', '開始', '終了', null, null, null, null],
  [null, '■ 認証', null, null, null, null, null, null, null, null, null],
  [
    '12',
    'ログイン画面のタイムアウト',
    '山田',
    '2026/10/28',
    '2026/11/05',
    '2026/10/29',
    null,
    '対応中',
    '至急',
    '',
    '60%',
  ],
  [
    '18',
    '出荷データCSV取込時の文字化け',
    '田中',
    45958,
    45962,
    45958,
    null,
    '確認中',
    '高',
    '再現待ち',
    '90%',
  ],
  [
    '22',
    '夜間バッチ処理が途中で停止する',
    '佐藤',
    'R8.10.24',
    'R8.11.12',
    null,
    null,
    '保留',
    '中',
    '',
    '0%',
  ],
  [
    '9',
    '結合テスト計画書の作成',
    '鈴木',
    '10/20',
    '10/30',
    '10/21',
    '10/30',
    '完了',
    '中',
    '',
    '100%',
  ],
  [null, '合計', null, null, null, null, null, null, null, null, null],
];

describe('headers', () => {
  it('finds the header row and joins two header rows', () => {
    expect(suggestHeaderRow(WBS)).toBe(3);
    const names = headerNames(WBS, [3, 4]);
    expect(names.slice(0, 8)).toEqual([
      'No.',
      '件名',
      '担当者',
      '予定 開始',
      '予定 終了',
      '実績 開始',
      '実績 終了',
      '状態',
    ]);
  });

  it('suggests the second header row, with or without merged cells filled in', () => {
    expect(suggestHeaderRows(WBS)).toEqual([3, 4]);
    // The reader fills merged cells, so 予定 also sits over 終了 and No. over the row under it.
    const filled = WBS.map((r) => [...r]);
    filled[3][4] = '予定';
    filled[3][6] = '実績';
    filled[4][0] = 'No.';
    expect(suggestHeaderRows(filled)).toEqual([3, 4]);
    expect(headerNames(filled, [3, 4]).slice(0, 5)).toEqual([
      'No.',
      '件名',
      '担当者',
      '予定 開始',
      '予定 終了',
    ]);
    // A single header row followed by task rows stays one row.
    expect(
      suggestHeaderRows([
        ['No.', '件名', '状態'],
        ['1', 'ログイン', '完了'],
        ['2', '出荷', '未着手'],
      ]),
    ).toEqual([0]);
  });

  it('suggests a column for each field from the usual headers', () => {
    const m = suggestMapping(headerNames(WBS, [3, 4]));
    expect(m).toMatchObject({
      customerId: 0,
      title: 1,
      assignee: 2,
      plannedStart: 3,
      plannedEnd: 4,
      actualStart: 5,
      actualEnd: 6,
      status: 7,
      priority: 8,
      remarks: 9,
    });
    expect(m.description).toBeUndefined();
  });

  it('matches English and Vietnamese headers too', () => {
    expect(
      suggestMapping(['No', 'Title', 'Status', 'Due date', 'Priority']),
    ).toMatchObject({
      customerId: 0,
      title: 1,
      status: 2,
      plannedEnd: 3,
      priority: 4,
    });
    expect(
      suggestMapping(['STT', 'Công việc', 'Trạng thái', 'Hạn']),
    ).toMatchObject({ customerId: 0, title: 1, status: 2, plannedEnd: 3 });
  });

  it('names columns like Excel', () => {
    expect([0, 25, 26, 27, 701].map(columnLetter)).toEqual([
      'A',
      'Z',
      'AA',
      'AB',
      'ZZ',
    ]);
  });
});

describe('values', () => {
  it('proposes statuses and levels for common words and symbols', () => {
    expect(proposeStatus('対応中')).toBe('In progress');
    expect(proposeStatus('○')).toBe('Done');
    expect(proposeStatus(' Done ')).toBe('Done');
    expect(proposeStatus('謎')).toBeUndefined();
    expect(proposeLevel('至急')).toBe('U');
    expect(proposeLevel('A')).toBe('H');
    expect(distinctValues(WBS, 7, 5)).toEqual([
      '対応中',
      '確認中',
      '保留',
      '完了',
    ]);
  });
});

const format = (o: Partial<FileFormat> = {}): FileFormat => ({
  name: 'WBS',
  sheet: 'WBS',
  headerRows: [3, 4],
  columns: suggestMapping(headerNames(WBS, [3, 4])),
  statusWords: {
    対応中: 'In progress',
    確認中: 'In review',
    保留: 'On hold',
    完了: 'Done',
  },
  priorityWords: { 至急: 'U', 高: 'H', 中: 'N' },
  ...o,
});

describe('readRows', () => {
  it('turns rows with an ID into tasks and lists what it skipped', () => {
    const r = readRows(WBS, format(), READ);
    expect(r.rows.map((x) => x.customerId)).toEqual(['12', '18', '22', '9']);
    expect(r.skipped.map((s) => [s.row, s.text])).toEqual([
      [6, '■ 認証'],
      [11, '合計'],
    ]);
    const first = r.rows[0];
    expect(first).toMatchObject({
      row: 7,
      title: 'ログイン画面のタイムアウト',
      assignee: '山田',
      plannedStart: '2026-10-28',
      plannedEnd: '2026-11-05',
      actualStart: '2026-10-29',
      status: 'In progress',
      statusWord: '対応中',
      priority: 'U',
    });
    expect(first.extra).toEqual({ 進捗率: '60%' });
    expect(r.rows[1].plannedStart).toBe('2025-10-28');
    expect(r.rows[2].plannedEnd).toBe('2026-11-12');
    expect(r.rows[3]).toMatchObject({
      plannedStart: '2026-10-20',
      actualEnd: '2026-10-30',
      status: 'Done',
    });
  });

  it('lists words the format does not map yet', () => {
    const r = readRows(
      WBS,
      format({ statusWords: { 対応中: 'In progress' }, priorityWords: {} }),
      READ,
    );
    expect(r.unmappedStatus).toEqual(['確認中', '保留', '完了']);
    expect(r.unmappedPriority).toEqual(['至急', '高', '中']);
  });

  it('takes the status from the actual dates when there is no status column', () => {
    const cols = { ...format().columns };
    delete cols.status;
    const r = readRows(WBS, format({ columns: cols }), READ);
    expect(r.rows.map((x) => x.status)).toEqual([
      'In progress',
      'In progress',
      'Not started',
      'Done',
    ]);
  });
});

const row = (o: Partial<ImportedRow>): ImportedRow => ({
  row: 1,
  customerId: '',
  title: '',
  description: '',
  assignee: '',
  plannedStart: null,
  plannedEnd: null,
  actualStart: null,
  actualEnd: null,
  statusWord: '',
  status: 'Not started',
  priorityWord: '',
  priority: 'N',
  category: '',
  remarks: '',
  extra: {},
  ...o,
});

describe('compareVersions', () => {
  it('lists new, changed and removed rows, matched by ID', () => {
    const before = [
      row({ customerId: '1', title: 'A' }),
      row({ customerId: '2', title: 'B', statusWord: '対応中' }),
      row({ customerId: '3', title: 'C' }),
    ];
    const after = [
      row({ customerId: '1', title: 'A' }),
      row({
        customerId: '2',
        title: 'B',
        statusWord: '完了',
        extra: { 進捗率: '100%' },
      }),
      row({ customerId: '4', title: 'D' }),
    ];
    const c = compareVersions(before, after);
    expect(c.unchanged).toBe(1);
    expect(c.added.map((r) => r.customerId)).toEqual(['4']);
    expect(c.removed.map((r) => r.customerId)).toEqual(['3']);
    expect(c.changed[0].changes).toEqual([
      { field: 'statusWord', from: '対応中', to: '完了' },
      { field: 'extra:進捗率', from: '', to: '100%' },
    ]);
  });

  it('matches rows without an ID, or with an ID used twice, by exact title', () => {
    const before = [
      row({ title: 'X', remarks: 'a' }),
      row({ customerId: '5', title: 'Y' }),
      row({ customerId: '5', title: 'Z' }),
    ];
    const after = [
      row({ title: 'X', remarks: 'b' }),
      row({ customerId: '5', title: 'Y' }),
      row({ customerId: '5', title: 'Z' }),
    ];
    const c = compareVersions(before, after);
    expect(c.added).toHaveLength(0);
    expect(c.removed).toHaveLength(0);
    expect(c.changed[0].changes).toEqual([
      { field: 'remarks', from: 'a', to: 'b' },
    ]);
  });

  it('notices a renumbered file and can match by title instead', () => {
    const titles = ['A', 'B', 'C', 'D'];
    const before = titles.map((t, i) =>
      row({ customerId: String(i + 1), title: t }),
    );
    const after = titles.map((t, i) =>
      row({ customerId: String(i + 101), title: t }),
    );
    const c = compareVersions(before, after);
    expect(c.looksRenumbered).toBe(true);
    const t = compareVersions(before, after, true);
    expect(t.added).toHaveLength(0);
    expect(t.changed).toHaveLength(0);
    expect(t.unchanged).toBe(4);
  });
});

describe('the ID as the title', () => {
  it('lets the title share the ID column, and no other pair', () => {
    expect(columnFree({ customerId: 0 }, 'title', 0)).toBe(true);
    expect(columnFree({ title: 0 }, 'customerId', 0)).toBe(true);
    expect(columnFree({ customerId: 0 }, 'assignee', 0)).toBe(false);
    expect(columnFree({ customerId: 0, title: 0 }, 'status', 0)).toBe(false);
    expect(columnFree({ customerId: 0 }, 'title', 1)).toBe(true);
  });

  it('imports the ID as both the number and the title', () => {
    const grid = [
      ['ID', '件名', '状態'],
      ['LOGIN-01', 'ログイン画面のタイムアウト', '対応中'],
      ['CSV-02', '', '未着手'],
    ];
    const r = readRows(
      grid,
      {
        name: 'x',
        sheet: 'x',
        headerRows: [0],
        columns: { customerId: 0, title: 0, status: 2 },
        statusWords: { 対応中: 'In progress' },
        priorityWords: {},
      },
      '2026-11-04',
    );
    expect(r.rows.map((x) => [x.customerId, x.title])).toEqual([
      ['LOGIN-01', 'LOGIN-01'],
      ['CSV-02', 'CSV-02'],
    ]);
    // The old title column is kept as a field from the file.
    expect(r.rows[0].extra).toEqual({ 件名: 'ログイン画面のタイムアウト' });
  });
});

describe('day-first dates', () => {
  it('reads 3/11 and 3/11/2026 month first by default, day first when the format says', () => {
    expect(parseDate('3/11', '2026-03-01')).toBe('2026-03-11');
    expect(parseDate('3/11', '2026-11-01', true)).toBe('2026-11-03');
    expect(parseDate('03/11/2026', '2026-11-01')).toBe('2026-03-11');
    expect(parseDate('03/11/2026', '2026-11-01', true)).toBe('2026-11-03');
    // 11月3日 says which is the month.
    expect(parseDate('11月3日', '2026-11-01', true)).toBe('2026-11-03');
    expect(parseDate('2026/11/03', '2026-11-01', true)).toBe('2026-11-03');
  });
});
