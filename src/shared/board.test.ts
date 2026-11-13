import { describe, expect, it } from 'vitest';
import { DEFAULT_BOARD, boardSlots, cleanBoard, slotOf } from './board';

const own = {
  hidden: ['On hold', 'Cancelled'] as const,
  columns: [
    { id: 'w', name: 'Waiting for test', status: 'In review' as const },
  ],
};
const b = { hidden: [...own.hidden], columns: own.columns };

describe('Board columns', () => {
  it('puts own columns before their status, and leaves hidden ones out', () => {
    expect(boardSlots(b).map((s) => s.name)).toEqual([
      'Not started',
      'In progress',
      'Waiting for test',
      'In review',
      'Done',
    ]);
    expect(boardSlots(b, true)).toHaveLength(7);
    expect(boardSlots(DEFAULT_BOARD).map((s) => s.name)).not.toContain(
      'Cancelled',
    );
  });

  it('keeps a card in its own column only while it has that status', () => {
    expect(slotOf({ status: 'In review', boardColumn: 'w' }, b)).toBe('own:w');
    expect(slotOf({ status: 'Done', boardColumn: 'w' }, b)).toBe('Done');
    expect(slotOf({ status: 'In review', boardColumn: 'gone' }, b)).toBe(
      'In review',
    );
  });

  it('cleans saved settings', () => {
    expect(
      cleanBoard({
        hidden: ['Done', 'Nope' as never],
        columns: [
          { id: 'a', name: ' A ', status: 'Done' },
          { id: 'a', name: 'dup', status: 'Done' },
          { id: 'b', name: '', status: 'Done' },
          { id: 'c', name: 'C', status: 'Bad' as never },
        ],
      }),
    ).toEqual({
      hidden: ['Done'],
      columns: [{ id: 'a', name: 'A', status: 'Done' }],
    });
    expect(cleanBoard(null)).toEqual(DEFAULT_BOARD);
  });
});
