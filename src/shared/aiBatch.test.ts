import { describe, expect, it } from 'vitest';
import { buildBatches, readAnswer, type BatchTask } from './aiBatch';

const task = (o: Partial<BatchTask>): BatchTask => ({
  taskId: 't',
  customerId: '1',
  language: 'ja',
  title: 'ログイン画面のタイムアウト',
  description: '',
  summary: '',
  ...o,
});

const GLOSSARY = [
  { term: '受入テスト', translation: 'acceptance test', note: '' },
  { term: '帳票', translation: 'form', note: 'printed business document' },
];

describe('buildBatches', () => {
  it('builds one request with the tasks, their language and the glossary terms they use', () => {
    const [b] = buildBatches(
      [
        task({
          taskId: 'a',
          customerId: '012',
          description: '受入テストを妨げている。\n\n至急対応が必要。',
        }),
        task({
          taskId: 'b',
          customerId: '018',
          title: 'CSV取込',
          language: 'ja',
        }),
        task({
          taskId: 'c',
          customerId: 'WM-08',
          title: 'Đồng bộ dữ liệu',
          language: 'vi',
        }),
      ],
      'en',
      GLOSSARY,
    );
    expect(b).toMatchObject({
      number: 1,
      of: 1,
      keys: { '012': 'a', '018': 'b', 'WM-08': 'c' },
    });
    expect(b.text).toContain('Translate each task below into English.');
    expect(b.text).toContain(
      '=== TASK 012 (Japanese) ===\nTITLE: ログイン画面のタイムアウト\nDESCRIPTION:\n受入テストを妨げている。\n\n至急対応が必要。\n=== END ===',
    );
    expect(b.text).toContain('=== TASK WM-08 (Vietnamese) ===');
    expect(b.text).toContain('- 受入テスト = acceptance test');
    expect(b.text).not.toContain('帳票'); // no task uses it
  });

  it('gives tasks with the same number their own keys', () => {
    const [b] = buildBatches(
      [
        task({ taskId: 'a', customerId: '5' }),
        task({ taskId: 'b', customerId: '5' }),
        task({ taskId: 'c', customerId: '' }),
      ],
      'en',
      [],
    );
    expect(b.keys).toEqual({ '5': 'a', '5#2': 'b', 'NO-ID': 'c' });
  });

  it('splits a large selection into batches under the size limit', () => {
    const tasks = Array.from({ length: 60 }, (_, i) =>
      task({
        taskId: `t${i}`,
        customerId: String(i + 1),
        description: '説明文。'.repeat(60),
      }),
    );
    const batches = buildBatches(tasks, 'en', [], 5000);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(b.text.length).toBeLessThanOrEqual(5000);
    expect(batches.every((b) => b.of === batches.length)).toBe(true);
    expect(batches.flatMap((b) => Object.values(b.keys))).toEqual(
      tasks.map((t) => t.taskId),
    );
  });
});

const KEYS = { keys: { '012': 'a', '018': 'b', '022': 'c' } };

describe('readAnswer', () => {
  it('reads the fixed format', () => {
    const r = readAnswer(
      KEYS,
      `=== TASK 012 ===
TITLE: Login screen times out
SUMMARY: Users are logged out after 5 minutes instead of 30.
DESCRIPTION:
It blocks the acceptance test.

It needs an urgent fix.
=== END ===

=== TASK 018 ===
TITLE: Garbled text when importing CSV
SUMMARY: Shift-JIS files are read as UTF-8.
=== END ===

=== TASK 022 ===
TITLE: Nightly batch stops
SUMMARY: Out of memory at month end.
=== END ===`,
    );
    expect(r.missing).toEqual([]);
    expect(r.items[0]).toEqual({
      key: '012',
      taskId: 'a',
      title: 'Login screen times out',
      summary: 'Users are logged out after 5 minutes instead of 30.',
      description: 'It blocks the acceptance test.\n\nIt needs an urgent fix.',
    });
    expect(r.items[1].description).toBe('');
  });

  it('copes with chat formatting and reports missing, unknown and incomplete tasks', () => {
    const r = readAnswer(
      KEYS,
      `Sure! Here are the translations:

\`\`\`
**=== TASK 018 (Japanese) ===**
**TITLE:** Garbled text when importing CSV
- SUMMARY: Shift-JIS files are read as UTF-8.
=== END ===
\`\`\`

=== TASK 999 ===
TITLE: Something else
=== END ===

===TASK 012===
SUMMARY: Only a summary.
===END===

Let me know if you need anything else.`,
    );
    expect(r.items.map((i) => [i.key, i.title, i.summary])).toEqual([
      [
        '018',
        'Garbled text when importing CSV',
        'Shift-JIS files are read as UTF-8.',
      ],
      ['012', '', 'Only a summary.'],
    ]);
    expect(r.missing).toEqual(['022']);
    expect(r.unknown).toEqual(['999']);
    expect(r.incomplete).toEqual(['012']);
  });

  it('reads nothing from an answer in another format', () => {
    const r = readAnswer(KEYS, '1. Login screen times out\n2. Garbled text');
    expect(r.items).toHaveLength(0);
    expect(r.missing).toEqual(['012', '018', '022']);
  });
});
