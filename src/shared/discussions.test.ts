import { describe, expect, it } from 'vitest';
import {
  buildSummaryBatches,
  mentions,
  readActionItem,
  readSummaryAnswer,
  type SummaryItem,
} from './discussions';

const item = (key: string, n = 3): SummaryItem => ({
  key,
  progress: {
    title: 'Batch stops halfway',
    status: 'In progress',
    doingNow: 'Looking at the logs',
    nextStep: '',
    nextDate: null,
    difficulties: ['Memory runs out'],
  },
  discussion: {
    title: 'Batch stops',
    description: 'At 60%.',
    lastSummary: '',
    comments: Array.from({ length: n }, (_, i) => ({
      n: i + 1,
      author: 'Yamada',
      at: '2026-11-15T10:00:00Z',
      body: `Comment ${i + 1} ${'x'.repeat(200)}`,
      decision: i === 1,
      reply: false,
    })),
    leftOut: 0,
  },
});

describe('Summarize request', () => {
  it('writes one block per ticket with decisions marked', () => {
    const [b] = buildSummaryBatches([item('025')], 'en');
    expect(b.keys).toEqual(['025']);
    expect(b.text).toContain('=== TICKET 025 ===');
    expect(b.text).toContain('[DECISION]');
    expect(b.text).toContain('in English');
    expect(b.text).toContain('- Memory runs out');
  });
  it('splits into batches and keeps the newest comments of a long discussion', () => {
    const bs = buildSummaryBatches(
      [item('1', 40), item('2', 40), item('3', 2)],
      'ja',
      6000,
    );
    expect(bs.length).toBeGreaterThan(1);
    for (const b of bs) expect(b.text.length).toBeLessThanOrEqual(6000);
    expect(bs.flatMap((b) => b.keys)).toEqual(['1', '2', '3']);
    expect(bs[0].text).toMatch(/older comments are left out/);
    expect(bs[0].text).toContain('Comment 40');
  });
});

describe('Summarize answer', () => {
  it('reads every part, tolerating chat formatting and old TASK blocks', () => {
    const r = readSummaryAnswer(
      `Here you go:
**=== TICKET 025 ===**
**DOING NOW:** Yamada changes the batch to read the CSV as a stream.
SITUATION: Yamada
DIFFICULTIES:
- Stg has less memory than Prod
RESOLVED:
- Memory runs out
NEXT STEP: Suzuki tests on Stg
NEXT DATE: 2026/11/21
STATUS: In progress
ACTION ITEMS:
- Suzuki: test streaming on Stg by 2026/11/21
=== END ===
=== TASK 031 ===
DOING NOW: none
STATUS: (keep)
NEXT DATE: none
=== END ===
=== TICKET 999 ===
DOING NOW: other
=== END ===`,
      ['025', '031', '040'],
    );
    expect(r.answers[0]).toEqual({
      key: '025',
      doingNow: 'Yamada changes the batch to read the CSV as a stream.',
      situation: 'Yamada',
      difficulties: ['Stg has less memory than Prod'],
      resolved: ['Memory runs out'],
      nextStep: 'Suzuki tests on Stg',
      nextDate: '2026-11-21',
      status: 'In progress',
      actionItems: ['Suzuki: test streaming on Stg by 2026/11/21'],
    });
    expect(r.answers[1]).toMatchObject({
      key: '031',
      doingNow: '',
      status: null,
      nextDate: null,
    });
    expect(r.missing).toEqual(['040']);
    expect(r.unreadable.map((u) => u.key)).toEqual(['999']);
  });
  it('turns an action item into a task for the member it names', () => {
    expect(
      readActionItem('Suzuki: test streaming on Stg by 2026/11/21', [
        { id: 's', name: 'Suzuki' },
      ]),
    ).toEqual({
      title: 'test streaming on Stg',
      assignee: 's',
      dueDate: '2026-11-21',
    });
    expect(readActionItem('Call the customer', [])).toEqual({
      title: 'Call the customer',
      assignee: '',
      dueDate: null,
    });
  });
  it('finds mentions of members only', () => {
    expect(
      mentions('@Suzuki please check, cc @nobody', [
        { id: 's', name: 'Suzuki' },
        { id: 't', name: 'Tanaka' },
      ]),
    ).toEqual(['s']);
  });
});
