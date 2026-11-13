import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { EMPTY_SITUATION, type Project, type Task } from '../shared/model';
import type { ReportOptions } from '../shared/reports';
import { buildReport } from './reportFiles';

const project: Project = {
  id: 'p',
  name: 'Portal',
  customer: 'Hoshizora',
  originalLanguages: ['ja'],
  workingLanguage: 'en',
  views: {} as Project['views'],
  dueSoonDays: 7,
  createdAt: '',
  publishFolder: null,
  publishNotes: false,
  publishOnClose: false,
  board: { hidden: [], columns: [] },
  showNumbers: true,
  tableSettings: null,
  dateFormat: 'YYYY/MM/DD',
};
const base: Task = {
  id: 't1',
  projectId: 'p',
  customerId: '012',
  source: 'hand',
  sourceFileId: null,
  links: [],
  languageSet: false,
  boardColumn: null,
  sheetRow: null,
  fileState: 'hand',
  statusWord: '対応中',
  priorityWord: '',
  extra: {},
  language: 'ja',
  titleOriginal: 'ログイン画面のタイムアウト',
  titleTranslation: 'Login screen times out',
  descriptionOriginal: '',
  descriptionTranslation: '',
  translationState: 'Translated',
  summary: 'Sessions expire after 5 minutes.',
  notes: 'Private note',
  status: 'In progress',
  priority: 'U',
  priorityOverride: null,
  labels: ['Auth'],
  assignee: '山田',
  category: '',
  remarks: '',
  plannedStart: '2026-10-28',
  plannedEnd: '2026-11-05',
  actualStart: '2026-10-29',
  actualEnd: null,
  pinned: false,
  nextAction: 'Call Suzuki',
  nextActionDate: null,
  situation: {
    ...EMPTY_SITUATION,
    handledBy: 'Yamada',
    doingNow: 'Reproducing on staging',
    nextStep: 'Redeploy',
    nextDate: '2026-11-04',
    asOf: '2026-11-02',
  },
  difficulties: [
    {
      id: 'd',
      text: 'No access to staging logs',
      raisedOn: '',
      resolver: 'Customer IT',
      open: true,
    },
  ],
  createdAt: '',
  updatedAt: '2026-11-02T00:00:00Z',
};
const tasks = [
  base,
  {
    ...base,
    id: 't2',
    customerId: '018',
    titleTranslation: 'Garbled CSV',
    priority: 'N' as const,
    status: 'Done' as const,
    statusWord: '完了',
    updatedAt: '2026-11-03T00:00:00Z',
  },
];
const opts = (o: Partial<ReportOptions>): ReportOptions => ({
  kind: 'progress',
  format: 'docx',
  projectId: 'p',
  statuses: [],
  levels: [],
  label: '',
  person: '',
  from: '2026-11-02',
  to: '2026-11-08',
  language: 'working',
  columns: [],
  includeNotes: false,
  preparedBy: 'Hoang',
  ...o,
});

const docText = (b: Buffer) =>
  strFromU8(unzipSync(b)['word/document.xml'])
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
/** The row holding the table's headings, found by its first heading. */
const headRow = (ws: ExcelJS.Worksheet) => {
  for (let r = 1; r <= 30; r++)
    if (ws.getRow(r).getCell(1).value === 'No.') return r;
  throw new Error('No table heading found');
};
const sheet = async (b: Buffer, name: string) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(b as unknown as ArrayBuffer);
  return wb.getWorksheet(name)!;
};

describe('report files', () => {
  it('makes the progress report in Word with the brief parts, leaving notes and next actions out', async () => {
    const text = docText(
      await buildReport(project, tasks, opts({}), '2026-11-03'),
    );
    for (const s of [
      'Progress report',
      'Prepared by',
      'Hoang',
      'No. 012',
      'Login screen times out',
      'Urgent',
      '現状 Doing now',
      'Yamada: reproducing on staging',
      '課題 Difficulties',
      'No access to staging logs (Customer IT)',
      '今後の予定 Next step',
      'Redeploy by 2026/11/04',
      'Overview of the period',
    ])
      expect(text).toContain(s);
    expect(text).not.toContain('Private note');
    expect(text).not.toContain('Call Suzuki');
    const page = strFromU8(
      unzipSync(await buildReport(project, tasks, opts({}), '2026-11-03'))[
        'word/document.xml'
      ],
    );
    expect(page).toContain('w:w="11906"');
    expect(page).toContain('w:h="16838"');
  });

  it('makes the progress report in Excel with a frozen, filtered table for A4 landscape', async () => {
    const ws = await sheet(
      await buildReport(
        project,
        tasks,
        opts({ format: 'xlsx', language: 'both' }),
        '2026-11-03',
      ),
      'Tasks',
    );
    const h = headRow(ws);
    const header = ws.getRow(h).values as string[];
    expect(header.slice(1, 5)).toEqual([
      'No.',
      '件名 Title',
      '優先度 Priority',
      '状態 Status',
    ]);
    expect(ws.getRow(h + 1).getCell(2).value).toBe(
      'ログイン画面のタイムアウト\nLogin screen times out',
    );
    expect(ws.getRow(h + 1).getCell(3).fill).toMatchObject({
      fgColor: { argb: 'FFFCE1E0' },
    });
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: h });
    expect(ws.autoFilter).toBeTruthy();
    expect(ws.pageSetup).toMatchObject({
      paperSize: 9,
      orientation: 'landscape',
      fitToWidth: 1,
    });
  });

  it('leaves out the parts the owner unticks, in Word and Excel', async () => {
    const parts = ['doingNow', 'next'] as ReportOptions['parts'];
    const text = docText(
      await buildReport(project, tasks, opts({ parts }), '2026-11-03'),
    );
    expect(text).toContain('現状 Doing now');
    expect(text).toContain('今後の予定 Next step');
    expect(text).toContain('Tasks (現状・今後の予定)');
    for (const s of [
      '課題 Difficulties',
      'No access to staging logs',
      'What it is',
      'Sessions expire after 5 minutes.',
      'Overview of the period',
    ])
      expect(text).not.toContain(s);
    const briefs = docText(
      await buildReport(
        project,
        tasks,
        opts({ kind: 'briefs', parts: ['what'] }),
        '2026-11-03',
      ),
    );
    expect(briefs).toContain('Sessions expire after 5 minutes.');
    expect(briefs).not.toContain('現状 Doing now');
    const book = await buildReport(
      project,
      tasks,
      opts({ format: 'xlsx', parts }),
      '2026-11-03',
    );
    const ws = await sheet(book, 'Tasks');
    const header = (ws.getRow(headRow(ws)).values as string[]).slice(1);
    expect(header).toEqual([
      'No.',
      'Title',
      'Priority',
      'Status',
      '現状 (Doing now)',
      '今後の予定 (Next step)',
    ]);
    expect(await sheet(book, 'Overview')).toBeUndefined();
  });

  it('makes the task list with the chosen columns, and notes only when chosen', async () => {
    const ws = await sheet(
      await buildReport(
        project,
        tasks,
        opts({
          kind: 'taskList',
          format: 'xlsx',
          columns: ['id', 'title', 'notes'],
        }),
        '2026-11-03',
      ),
      'Tasks',
    );
    expect((ws.getRow(headRow(ws)).values as string[]).slice(1)).toEqual([
      'No.',
      'Title',
    ]);
    const withNotes = await sheet(
      await buildReport(
        project,
        tasks,
        opts({
          kind: 'taskList',
          format: 'xlsx',
          columns: ['id', 'notes'],
          includeNotes: true,
        }),
        '2026-11-03',
      ),
      'Tasks',
    );
    expect(withNotes.getRow(headRow(withNotes) + 1).getCell(2).value).toBe(
      'Private note',
    );
    const word = docText(
      await buildReport(
        project,
        tasks,
        opts({
          kind: 'taskList',
          format: 'docx',
          columns: ['id', 'title', 'status'],
        }),
        '2026-11-03',
      ),
    );
    expect(word).toContain('Garbled CSV');
  });

  it('draws the schedule as shaded plan and actual rows', async () => {
    const ws = await sheet(
      await buildReport(
        project,
        [base],
        opts({ kind: 'schedule', format: 'xlsx', language: 'original' }),
        '2026-11-03',
      ),
      'Schedule',
    );
    const h = headRow(ws);
    const plan = ws.getRow(h + 1);
    const act = ws.getRow(h + 2);
    expect(plan.getCell(5).value).toBe('予定');
    expect(act.getCell(5).value).toBe('実績');
    // The range starts on Monday 26 Oct; the plan runs from 28 Oct to 5 Nov.
    const fill = (r: ExcelJS.Row, i: number) =>
      (r.getCell(8 + i).fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb;
    expect(fill(plan, 1)).toBeUndefined();
    expect(fill(plan, 2)).toBe('FFE8615E');
    expect(fill(plan, 10)).toBe('FFE8615E');
    expect(fill(plan, 11)).toBeUndefined();
    expect(fill(act, 3)).toBe('FF4B5563');
    expect(fill(act, 8)).toBe('FF4B5563');
    expect(fill(act, 9)).toBeUndefined();
  });

  it('refuses a format a report is not made in', async () => {
    await expect(
      buildReport(
        project,
        tasks,
        opts({ kind: 'schedule', format: 'docx' }),
        '2026-11-03',
      ),
    ).rejects.toThrow('made as xlsx');
  });
});
