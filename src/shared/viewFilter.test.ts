import { describe, expect, it } from 'vitest';
import { EMPTY_SITUATION, type Task } from './model';
import { NO_FILTER, filterChoices, matchesFilter } from './viewFilter';

const task = (o: Partial<Task>): Task =>
  ({
    id: 't',
    projectId: 'p',
    customerId: '1',
    status: 'In progress',
    priority: 'N',
    priorityOverride: null,
    labels: [],
    assignee: '',
    situation: { ...EMPTY_SITUATION },
    ...o,
  }) as Task;

const people = [
  {
    id: 'a',
    projectId: 'p',
    name: '田中',
    displayName: 'Tanaka',
    side: 'customer' as const,
    spellings: [],
  },
];

describe('the view filter', () => {
  const a = task({
    id: 'a',
    assignee: '田中',
    labels: ['Auth'],
    status: 'Done',
  });
  const b = task({
    id: 'b',
    labels: ['UI'],
    priorityOverride: 'U',
    situation: { ...EMPTY_SITUATION, handledBy: 'Yamada (our team)' },
  });
  const all = [a, b];
  const ids = (f: Partial<typeof NO_FILTER>) =>
    all
      .filter((t) => matchesFilter(t, { ...NO_FILTER, ...f }, people))
      .map((t) => t.id);

  it('matches every group, and any choice within one', () => {
    expect(ids({})).toEqual(['a', 'b']);
    expect(ids({ statuses: ['Done'] })).toEqual(['a']);
    expect(ids({ levels: ['U'] })).toEqual(['b']);
    expect(ids({ labels: ['auth', 'UI'] })).toEqual(['a', 'b']);
    expect(ids({ labels: ['UI'], statuses: ['Done'] })).toEqual([]);
  });

  it('finds people by the name shown, as assignee or handler', () => {
    expect(ids({ people: ['Tanaka'] })).toEqual(['a']);
    expect(ids({ people: ['Yamada'] })).toEqual(['b']);
    expect(filterChoices(all, people).people.sort()).toEqual([
      'Tanaka',
      'Yamada',
    ]);
  });
});
