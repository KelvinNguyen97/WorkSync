import { describe, expect, it } from 'vitest';
import { EMPTY_SITUATION, type Task } from './model';
import {
  DEFAULT_TABLE,
  columnByKey,
  passes,
  rangeIds,
  tableRows,
  tableSettings,
} from './taskTable';

const task = (o: Partial<Task>): Task => ({
  id: o.customerId ?? 't',
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
  summary: '',
  notes: '',
  status: 'In progress',
  priority: 'N',
  priorityOverride: null,
  labels: [],
  assignee: '',
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

const all = [
  task({ customerId: '10', priority: 'L', plannedEnd: '2026-11-20' }),
  task({ customerId: '2', priority: 'U', plannedEnd: null }),
  task({
    customerId: '3',
    priority: 'N',
    priorityOverride: 'H',
    plannedEnd: '2026-11-05',
    assignee: '山田',
  }),
  task({ customerId: '4', status: 'On hold', plannedEnd: '2026-10-30' }),
];
const ids = (ts: Task[]) => ts.map((t) => t.customerId);

describe('Tasks table', () => {
  it('sorts by the priority shown, with ties in number order', () => {
    expect(ids(tableRows(all, DEFAULT_TABLE, ''))).toEqual([
      '2',
      '3',
      '4',
      '10',
    ]);
  });

  it('sorts dates either way with empty dates last', () => {
    const s = {
      ...DEFAULT_TABLE,
      sort: { key: 'plannedEnd', dir: 'asc' as const },
    };
    expect(ids(tableRows(all, s, ''))).toEqual(['4', '3', '10', '2']);
    expect(
      ids(
        tableRows(all, { ...s, sort: { key: 'plannedEnd', dir: 'desc' } }, ''),
      ),
    ).toEqual(['10', '3', '4', '2']);
  });

  it('sorts numbers in the file as numbers', () => {
    const s = { ...DEFAULT_TABLE, sort: { key: 'id', dir: 'asc' as const } };
    expect(ids(tableRows(all, s, ''))).toEqual(['2', '3', '4', '10']);
  });

  it('filters by text, choice and date', () => {
    const f = (filters: Record<string, string>) =>
      ids(tableRows(all, { ...DEFAULT_TABLE, filters }, ''));
    expect(f({ assignee: '山' })).toEqual(['3']);
    expect(f({ status: 'On hold' })).toEqual(['4']);
    expect(f({ priority: 'H' })).toEqual(['3']);
    expect(f({ plannedEnd: '2026/11' })).toEqual(['3', '10']);
    expect(f({ plannedEnd: '2026/11/01-2026/11/10' })).toEqual(['3']);
    expect(f({ plannedEnd: '2026/11/05-' })).toEqual(['3', '10']);
    expect(f({ plannedEnd: '-2026/11/05' })).toEqual(['3', '4']);
    expect(f({ plannedEnd: 'none' })).toEqual(['2']);
    expect(f({ plannedEnd: '2026-11-05' })).toEqual(['3']);
  });

  it('treats a whole month as the end of a range', () => {
    const c = columnByKey('plannedEnd')!;
    expect(passes(c, all[0], '2026/10-2026/11')).toBe(true);
    expect(passes(c, all[0], '2026/10-2026/10')).toBe(false);
  });

  it('cleans saved settings', () => {
    expect(
      tableSettings({
        columns: ['id', 'gone'],
        sort: { key: 'gone', dir: 'asc' },
        filters: { gone: 'x', status: '', assignee: 'a' },
      }),
    ).toEqual({
      columns: ['id', 'title'],
      sort: DEFAULT_TABLE.sort,
      filters: { assignee: 'a' },
    });
  });

  it('selects a range in the order shown', () => {
    expect(rangeIds(['a', 'b', 'c', 'd'], 'c', 'a')).toEqual(['a', 'b', 'c']);
    expect(rangeIds(['a', 'b'], null, 'b')).toEqual(['b']);
  });
});
