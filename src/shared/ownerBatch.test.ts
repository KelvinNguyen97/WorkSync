import { describe, expect, it } from 'vitest';
import { EMPTY_SITUATION, formatDate, type Task } from './model';
import {
  buildOwnerBatches,
  ownerParts,
  readOwnerAnswer,
  translationMap,
  untranslated,
} from './ownerBatch';
import { briefInFileLanguage, ownerText } from './reports';

const task = (o: Partial<Task> = {}): Task => ({
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
  summary: 'Users are logged out after 5 minutes.',
  notes: '',
  status: 'In progress',
  priority: 'N',
  priorityOverride: null,
  labels: [],
  assignee: '',
  category: '',
  remarks: '',
  plannedStart: null,
  plannedEnd: '2026-11-05',
  actualStart: null,
  actualEnd: null,
  pinned: false,
  nextAction: '',
  nextActionDate: null,
  situation: {
    ...EMPTY_SITUATION,
    handledBy: 'Yamada',
    doingNow: 'Testing the fix',
    nextStep: 'Redeploy',
    nextDate: '2026-11-04',
  },
  difficulties: [
    {
      id: 'd1',
      text: 'No staging access',
      raisedOn: '',
      resolver: '',
      open: true,
    },
  ],
  createdAt: '',
  updatedAt: '',
  ...o,
});

describe('owner translations', () => {
  it('asks only for the notes without a current translation', () => {
    const t = task();
    expect(ownerParts(t).map((p) => p.label)).toEqual([
      'SUMMARY',
      'DOING NOW',
      'NEXT STEP',
      'DIFFICULTY 1',
    ]);
    const done = [
      {
        taskId: 't1',
        field: 'summary',
        language: 'ja' as const,
        source: t.summary,
        text: '5分でログアウト。',
      },
      {
        taskId: 't1',
        field: 'doingNow',
        language: 'ja' as const,
        source: 'old text',
        text: '古い',
      },
    ];
    expect(untranslated(t, done, 'ja').map((p) => p.field)).toEqual([
      'doingNow',
      'nextStep',
      'difficulty:d1',
    ]);
    expect(translationMap([t], done, 'ja')).toEqual({
      [t.summary]: '5分でログアウト。',
    });
  });

  it('builds a request and reads the answer back', () => {
    const t = task();
    const [b] = buildOwnerBatches(
      [{ task: t, parts: ownerParts(t) }],
      'en',
      'ja',
      [{ term: '受入テスト', translation: 'staging', note: '' }],
    );
    expect(b.text).toContain('=== TASK 012 ===\nSUMMARY: Users are logged out');
    expect(b.text).toContain('- staging = 受入テスト');
    const r = readOwnerAnswer(
      b,
      '```\n=== TASK 012 ===\n**SUMMARY:** 5分でログアウトされる。\nDOING NOW: 修正を確認中\nNEXT STEP: 再デプロイ\n=== END ===\n```',
    );
    expect(r.translations.map((x) => [x.field, x.text])).toEqual([
      ['summary', '5分でログアウトされる。'],
      ['doingNow', '修正を確認中'],
      ['nextStep', '再デプロイ'],
    ]);
    expect(r.incomplete).toEqual(['012 DIFFICULTY 1']);
    expect(r.missing).toEqual([]);
  });

  it('uses translations in reports and briefs, and marks the rest', () => {
    const t = task();
    const tr = {
      [t.summary]: '5分でログアウトされる。',
      Redeploy: '再デプロイ',
    };
    expect(
      ownerText(t.summary, { language: 'original', translations: tr }, true),
    ).toBe('5分でログアウトされる。');
    expect(
      ownerText(t.summary, { language: 'both', translations: tr }, true),
    ).toBe(`${t.summary}\n5分でログアウトされる。`);
    const b = briefInFileLanguage(t, tr, '2026-11-03', 7, 'YYYY年M月D日');
    expect(b.missing).toBe(2);
    expect(b.text).toContain('概要: 5分でログアウトされる。');
    expect(b.text).toContain(
      '現状: 対応中 · Yamada: （未翻訳）Testing the fix · 期限 2026年11月5日',
    );
    expect(b.text).toContain('今後の予定: 再デプロイ（2026年11月4日まで）');
  });

  it('writes dates in the project format', () => {
    expect(formatDate('2026-11-03', 'YYYY/MM/DD')).toBe('2026/11/03');
    expect(formatDate('2026-11-03', 'DD/MM/YYYY')).toBe('03/11/2026');
    expect(formatDate('2026-11-03', 'YYYY年M月D日')).toBe('2026年11月3日');
    expect(formatDate(null)).toBe('');
  });
});
