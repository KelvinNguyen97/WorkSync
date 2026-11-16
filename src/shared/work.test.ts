import { describe, expect, it } from 'vitest';
import {
  startedStatus,
  tickedStatus,
  parseQuickAdd,
  readQuickDate,
  tagOf,
  type Member,
} from './work';

const m = (id: string, name: string, me = false): Member => ({
  id,
  name,
  tag: tagOf(id),
  account: '',
  pc: '',
  color: '',
  me,
});
const members = [
  m('a', 'Hoang', true),
  m('b', 'Suzuki'),
  m('c', 'Sato'),
  m('d', 'Satoh'),
];
const tickets = [{ id: 't25', no: '025' }];

describe('quick add', () => {
  it('reads who, when and which ticket from one line', () => {
    expect(
      parseQuickAdd('Test streaming on Stg @Suzuki 11/21 #025', {
        members,
        tickets,
        today: '2026-11-16',
      }),
    ).toEqual({
      title: 'Test streaming on Stg',
      assignee: 'b',
      dueDate: '2026-11-21',
      ticketNo: '025',
      ticketId: 't25',
      discussionId: null,
    });
  });
  it('keeps names that are not members and unknown numbers in the title', () => {
    const r = parseQuickAdd('Ask @Tanaka about #999', {
      members,
      tickets,
      today: '2026-11-16',
    });
    expect(r.title).toBe('Ask @Tanaka about #999');
    expect(r.assignee).toBe('');
    expect(r.ticketId).toBeNull();
  });
  it('needs an unambiguous name; @me is you', () => {
    expect(
      parseQuickAdd('x @Sat', { members, tickets, today: '2026-11-16' })
        .assignee,
    ).toBe('');
    expect(
      parseQuickAdd('x @sato', { members, tickets, today: '2026-11-16' })
        .assignee,
    ).toBe('c');
    expect(
      parseQuickAdd('x @me', { members, tickets, today: '2026-11-16' })
        .assignee,
    ).toBe('a');
  });
  it('links to a discussion when only a discussion has the number', () => {
    const r = parseQuickAdd('x #031', {
      members,
      tickets,
      discussions: [{ id: 'd31', no: '031' }],
      today: '2026-11-16',
    });
    expect([r.ticketId, r.discussionId]).toEqual([null, 'd31']);
  });
});

describe('dates and status', () => {
  it('reads short and full dates, and a past month as next year', () => {
    expect(readQuickDate('2026/12/03', '2026-11-16')).toBe('2026-12-03');
    expect(readQuickDate('tomorrow', '2026-11-30')).toBe('2026-12-01');
    expect(readQuickDate('1/10', '2026-11-16')).toBe('2027-01-10');
    expect(readQuickDate('11/01', '2026-11-16')).toBe('2026-11-01');
    expect(readQuickDate('13/01', '2026-11-16')).toBeNull();
  });
  it('ticks a task Done in one click, and the word switches To do and Doing', () => {
    expect(tickedStatus('todo')).toBe('done');
    expect(tickedStatus('doing')).toBe('done');
    expect(tickedStatus('done')).toBe('todo');
    expect(startedStatus('todo')).toBe('doing');
    expect(startedStatus('doing')).toBe('todo');
  });
});
