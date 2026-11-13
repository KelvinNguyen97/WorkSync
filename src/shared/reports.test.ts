import { describe, expect, it } from 'vitest';
import { EMPTY_SITUATION, type Project, type Task } from './model';
import {
  COLUMNS,
  briefParts,
  heading,
  ownerText,
  periodOverview,
  reportFileName,
  reportTasks,
  reportTitle,
  thisWeek,
  type ReportOptions,
} from './reports';

const project: Project = {
  id: 'p',
  name: 'Sample: Portal',
  customer: '',
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

const task = (o: Partial<Task>): Task => ({
  id: 't',
  projectId: 'p',
  customerId: '1',
  source: 'hand',
  sourceFileId: null,
  links: [],
  languageSet: false,
  boardColumn: null,
  sheetRow: null,
  fileState: 'hand',
  statusWord: '',
  priorityWord: '',
  extra: {},
  language: 'ja',
  titleOriginal: 'ログイン',
  titleTranslation: 'Login',
  descriptionOriginal: '',
  descriptionTranslation: '',
  translationState: 'Translated',
  summary: 'Sessions expire.',
  notes: 'secret',
  status: 'In progress',
  priority: 'N',
  priorityOverride: null,
  labels: ['Auth'],
  assignee: '山田',
  category: '',
  remarks: '',
  plannedStart: null,
  plannedEnd: null,
  actualStart: null,
  actualEnd: null,
  pinned: false,
  nextAction: '',
  nextActionDate: null,
  situation: { ...EMPTY_SITUATION },
  difficulties: [],
  createdAt: '',
  updatedAt: '2026-11-02T10:00:00Z',
  ...o,
});

const opts = (o: Partial<ReportOptions> = {}): ReportOptions => ({
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
  preparedBy: '',
  ...o,
});

describe('reports', () => {
  it('uses Monday to Sunday as the default period', () => {
    expect(thisWeek('2026-11-03')).toEqual({
      from: '2026-11-02',
      to: '2026-11-08',
    });
    expect(thisWeek('2026-11-08')).toEqual({
      from: '2026-11-02',
      to: '2026-11-08',
    });
  });

  it('covers open tasks plus tasks closed during the period, and applies the filters', () => {
    const all = [
      task({ id: 'a', customerId: '1' }),
      task({
        id: 'b',
        customerId: '2',
        status: 'Done',
        updatedAt: '2026-11-03T09:00:00Z',
      }),
      task({
        id: 'c',
        customerId: '3',
        status: 'Done',
        updatedAt: '2026-10-20T09:00:00Z',
      }),
      task({ id: 'd', customerId: '4', fileState: 'removed' }),
      task({ id: 'e', customerId: '5', priority: 'U', labels: [] }),
    ];
    expect(reportTasks(all, opts()).map((t) => t.id)).toEqual(['e', 'a', 'b']);
    expect(
      reportTasks(all, opts({ kind: 'taskList' })).map((t) => t.id),
    ).toEqual(['e', 'a', 'b', 'c']);
    expect(reportTasks(all, opts({ label: 'auth' })).map((t) => t.id)).toEqual([
      'a',
      'b',
    ]);
    expect(reportTasks(all, opts({ levels: ['U'] })).map((t) => t.id)).toEqual([
      'e',
    ]);
    expect(
      reportTasks(
        all,
        opts({ person: '山田', statuses: ['Done'], kind: 'taskList' }),
      ).map((t) => t.id),
    ).toEqual(['b', 'c']);
  });

  it('summarizes the period', () => {
    const all = [
      task({ actualStart: '2026-11-03' }),
      task({ status: 'Done', actualEnd: '2026-11-04' }),
      task({
        plannedEnd: '2026-11-01',
      }),
    ];
    expect(periodOverview(all, project, opts(), '2026-11-03')).toMatchObject({
      open: 2,
      finished: 1,
      started: 1,
      overdue: 1,
    });
  });

  it('writes titles and owner text in the chosen language', () => {
    const t = task({});
    expect(reportTitle(t, 'working')).toBe('Login');
    expect(reportTitle(t, 'original')).toBe('ログイン');
    expect(reportTitle(t, 'both')).toBe('ログイン\nLogin');
    expect(reportTitle(task({ titleTranslation: '' }), 'working')).toBe(
      'ログイン',
    );
    expect(ownerText('Sessions expire.', { language: 'original' }, true)).toBe(
      '（未翻訳）Sessions expire.',
    );
    expect(ownerText('Sessions expire.', { language: 'both' }, true)).toBe(
      'Sessions expire.',
    );
    expect(heading({ label: 'Status', ja: '状態' }, 'both', true)).toBe(
      '状態 Status',
    );
  });

  it('leaves notes out unless chosen', () => {
    const notes = COLUMNS.find((c) => c.key === 'notes')!;
    expect(notes.value(task({}), opts())).toBe('');
    expect(notes.value(task({}), opts({ includeNotes: true }))).toBe('secret');
  });

  it('builds the brief parts in report words', () => {
    const t = task({
      plannedEnd: '2026-11-01',
      situation: {
        handledBy: 'Yamada',
        doingNow: 'Testing the fix',
        nextStep: 'Customer confirms',
        nextDate: '2026-11-05',
        asOf: '2026-11-02',
      },
      difficulties: [
        {
          id: 'x',
          text: 'No staging access',
          raisedOn: '',
          resolver: 'Customer IT',
          open: true,
        },
      ],
    });
    expect(briefParts(t, opts(), '2026-11-03', 7)).toMatchObject({
      doingNow: 'In progress · Yamada: testing the fix',
      difficulties: ['No staging access (Customer IT)'],
      next: 'Customer confirms by 2026/11/05',
      due: 'Overdue, was due 2026/11/01',
      asOf: '2026/11/02',
    });
  });

  it('names report files', () => {
    expect(
      reportFileName(
        project,
        { kind: 'progress', format: 'docx' },
        '2026-11-03',
      ),
    ).toBe('Portal progress report 20261103.docx');
  });
});

describe('report scope', () => {
  it('covers only the selected tasks when there are some', () => {
    const all = [task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })];
    expect(
      reportTasks(all, opts({ kind: 'taskList', taskIds: ['c', 'a'] })).map(
        (t) => t.id,
      ),
    ).toEqual(['a', 'c']);
  });
});
