import { describe, expect, it } from 'vitest';
import {
  glossSegments,
  assigneeText,
  personFor,
  personName,
  EMPTY_SITUATION,
  addDays,
  brief,
  byPriority,
  daysBetween,
  deadline,
  detectLanguage,
  flags,
  inFocus,
  matchesSearch,
  translationStateFor,
  type Task,
} from './model';

const TODAY = '2026-11-03';

const task = (o: Partial<Task> = {}): Task => ({
  id: 't1',
  projectId: 'p1',
  customerId: '012',
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
  titleOriginal: 'ログイン画面のタイムアウト',
  titleTranslation: 'Login screen times out',
  descriptionOriginal: '',
  descriptionTranslation: '',
  translationState: 'Translated',
  summary: 'Sessions expire too early.',
  notes: '',
  status: 'In progress',
  priority: 'N',
  priorityOverride: null,
  labels: ['Auth'],
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
  situation: { ...EMPTY_SITUATION, asOf: '2026-11-01' },
  difficulties: [],
  createdAt: '',
  updatedAt: '',
  ...o,
});

describe('dates', () => {
  it('counts days across months and years', () => {
    expect(daysBetween('2026-10-30', '2026-11-03')).toBe(4);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(addDays('2026-11-03', -5)).toBe('2026-10-29');
  });
});

describe('flags', () => {
  it('marks overdue only while the task is open', () => {
    expect(flags(task({ plannedEnd: '2026-11-01' }), TODAY).overdue).toBe(true);
    expect(
      flags(task({ plannedEnd: '2026-11-01', status: 'Done' }), TODAY).overdue,
    ).toBe(false);
  });

  it('counts due soon within the project setting, including today', () => {
    expect(flags(task({ plannedEnd: TODAY }), TODAY).dueSoon).toBe(true);
    expect(flags(task({ plannedEnd: '2026-11-10' }), TODAY, 7).dueSoon).toBe(
      true,
    );
    expect(flags(task({ plannedEnd: '2026-11-11' }), TODAY, 7).dueSoon).toBe(
      false,
    );
    expect(flags(task({ plannedEnd: '2026-11-11' }), TODAY, 10).dueSoon).toBe(
      true,
    );
  });

  it('marks late to start only for Not started tasks', () => {
    expect(
      flags(task({ plannedStart: '2026-11-01', status: 'Not started' }), TODAY)
        .lateToStart,
    ).toBe(true);
    expect(flags(task({ plannedStart: '2026-11-01' }), TODAY).lateToStart).toBe(
      false,
    );
  });

  it('needs my action when my next action is due', () => {
    expect(flags(task(), TODAY).needsMyAction).toBe(false);
    expect(flags(task({ nextActionDate: TODAY }), TODAY).needsMyAction).toBe(
      true,
    );
    expect(
      flags(task({ nextActionDate: '2026-11-04' }), TODAY).needsMyAction,
    ).toBe(false);
  });

  it('marks the next step overdue until the situation is updated after its date', () => {
    const s = {
      ...EMPTY_SITUATION,
      nextStep: 'Demo',
      nextDate: '2026-11-01',
      asOf: '2026-10-30',
    };
    expect(flags(task({ situation: s }), TODAY).nextStepOverdue).toBe(true);
    expect(
      flags(task({ situation: { ...s, asOf: '2026-11-02' } }), TODAY)
        .nextStepOverdue,
    ).toBe(false);
  });

  it('uses the override for urgency', () => {
    expect(
      flags(task({ priority: 'N', priorityOverride: 'U' }), TODAY).urgent,
    ).toBe(true);
  });

  it('marks the brief incomplete without a summary or a situation update', () => {
    expect(flags(task({ summary: '' }), TODAY).briefIncomplete).toBe(true);
    expect(
      flags(task({ situation: EMPTY_SITUATION }), TODAY).briefIncomplete,
    ).toBe(true);
    expect(flags(task(), TODAY).briefIncomplete).toBe(false);
  });
});

describe('focus list', () => {
  it('includes pinned and urgent tasks and leaves out closed ones', () => {
    expect(inFocus(task(), TODAY)).toBe(false);
    expect(inFocus(task({ pinned: true }), TODAY)).toBe(true);
    expect(inFocus(task({ priority: 'U' }), TODAY)).toBe(true);
    expect(inFocus(task({ priority: 'U', status: 'Cancelled' }), TODAY)).toBe(
      false,
    );
  });

  it('sorts by priority, then planned end, with undated tasks last', () => {
    const a = task({
      customerId: 'a',
      priority: 'H',
      plannedEnd: '2026-11-09',
    });
    const b = task({
      customerId: 'b',
      priority: 'U',
      plannedEnd: '2026-11-20',
    });
    const c = task({ customerId: 'c', priority: 'H', plannedEnd: null });
    const d = task({
      customerId: 'd',
      priority: 'H',
      plannedEnd: '2026-11-05',
    });
    expect([a, b, c, d].sort(byPriority).map((t) => t.customerId)).toEqual([
      'b',
      'd',
      'a',
      'c',
    ]);
  });
});

describe('deadline', () => {
  it('reads in words', () => {
    expect(deadline(task({ plannedEnd: '2026-11-01' }), TODAY)?.text).toBe(
      'Overdue by 2 days',
    );
    expect(deadline(task({ plannedEnd: '2026-11-02' }), TODAY)?.text).toBe(
      'Overdue by 1 day',
    );
    expect(deadline(task({ plannedEnd: TODAY }), TODAY)?.text).toBe(
      'Due today',
    );
    expect(deadline(task({ plannedEnd: '2026-11-04' }), TODAY)?.text).toBe(
      'Due in 1 day',
    );
    expect(deadline(task({ plannedEnd: '2026-11-30' }), TODAY)?.text).toBe(
      'Due 30 Nov',
    );
    expect(
      deadline(task({ plannedEnd: '2026-11-01', status: 'Done' }), TODAY),
    ).toBeNull();
  });
});

describe('languages', () => {
  it('reads Japanese from kana and kanji, even with English terms', () => {
    expect(detectLanguage('CSV取込時の文字化け', ['ja', 'en'])).toBe('ja');
  });
  it('tells Vietnamese from English by its letters', () => {
    expect(detectLanguage('Quét mã vạch chậm', ['en', 'vi'])).toBe('vi');
    expect(detectLanguage('Gateway firmware update', ['ja', 'en', 'vi'])).toBe(
      'en',
    );
  });
  it('needs no translation for text already in the working language', () => {
    expect(
      translationStateFor(
        {
          language: 'en',
          titleTranslation: '',
          translationState: 'Not translated',
        },
        'en',
      ),
    ).toBe('Not needed');
    expect(
      translationStateFor(
        {
          language: 'ja',
          titleTranslation: '',
          translationState: 'Translated',
        },
        'en',
      ),
    ).toBe('Not translated');
    expect(
      translationStateFor(
        {
          language: 'ja',
          titleTranslation: 'x',
          translationState: 'Not translated',
        },
        'en',
      ),
    ).toBe('Translated');
  });
});

describe('search and brief', () => {
  it('finds a task by number, with or without No.', () => {
    expect(matchesSearch(task(), 'No. 012')).toBe(true);
    expect(matchesSearch(task(), 'auth')).toBe(true);
    expect(matchesSearch(task(), 'タイムアウト')).toBe(true);
    expect(matchesSearch(task(), 'invoice')).toBe(false);
  });

  it('builds the three parts of the brief', () => {
    const b = brief(
      task({
        situation: {
          handledBy: 'Yamada',
          doingNow: 'Reproducing it',
          nextStep: 'Send logs',
          nextDate: '2026-11-05',
          asOf: '2026-11-02',
        },
        difficulties: [
          {
            id: 'd',
            text: 'No staging access',
            raisedOn: TODAY,
            resolver: '',
            open: true,
          },
        ],
      }),
    );
    expect(b.where).toBe(
      'In progress · Yamada: reproducing it · 1 open difficulty: no staging access · as of 2 Nov',
    );
    expect(b.next).toBe('Send logs by 5 Nov');
    expect(b.text.split('\n')[0]).toBe(
      'No. 012  Login screen times out (ログイン画面のタイムアウト)',
    );
  });
});

describe('people', () => {
  const people = [
    {
      id: 'a',
      projectId: 'p',
      name: '田中',
      displayName: 'Tanaka',
      side: 'customer' as const,
      spellings: ['田中太郎', 'Ｔａｎａｋａ'],
    },
  ];
  it('finds a person by any spelling, ignoring spaces and width', () => {
    expect(personFor(people, 'p', '田中 太郎')?.id).toBe('a');
    expect(personFor(people, 'p', 'tanaka')?.id).toBe('a');
    expect(personFor(people, 'q', '田中')).toBeUndefined();
  });
  it('shows names in the working language, keeping unknown ones', () => {
    expect(personName(people, 'p', '田中、佐藤')).toBe('Tanaka, 佐藤');
    expect(
      assigneeText(people, { projectId: 'p', assignee: '田中' }, 'both'),
    ).toBe('Tanaka (田中)');
    expect(
      assigneeText(people, { projectId: 'p', assignee: '田中' }, 'original'),
    ).toBe('田中');
  });
});

describe('glossary marks', () => {
  const g = (term: string, translation = 'x') => ({
    term,
    translation,
    note: '',
  });
  it('marks the longest term, and Latin terms as whole words', () => {
    const parts = glossSegments('受入テスト環境でAPIを確認。rapid', [
      g('テスト'),
      g('受入テスト', 'acceptance test'),
      g('api', 'API'),
      g('API'),
    ]);
    expect(parts.filter((p) => p.term).map((p) => p.text)).toEqual([
      '受入テスト',
      'API',
    ]);
    expect(parts.map((p) => p.text).join('')).toBe(
      '受入テスト環境でAPIを確認。rapid',
    );
  });
  it('leaves text without terms alone', () => {
    expect(glossSegments('abc', [])).toEqual([{ text: 'abc' }]);
  });
});
