/**
 * The Board's columns per project: the six statuses, any of which can be
 * hidden, and the owner's own columns. Each own column sits under one status,
 * so a card in it has that status, and the file and reports keep working.
 */
import { STATUSES, type Status, type Task } from './model';

export interface BoardColumn {
  id: string;
  name: string;
  status: Status;
}

export interface BoardSettings {
  hidden: Status[];
  columns: BoardColumn[];
}

export const DEFAULT_BOARD: BoardSettings = {
  hidden: ['Cancelled'],
  columns: [],
};

export type BoardSlot =
  | { kind: 'status'; key: string; status: Status; name: string }
  | { kind: 'own'; key: string; status: Status; name: string; id: string };

/**
 * The columns in order: for each status, its own columns, then the status
 * itself unless hidden. `showHidden` shows the hidden ones too.
 */
export function boardSlots(s: BoardSettings, showHidden = false): BoardSlot[] {
  return STATUSES.flatMap((status) => [
    ...s.columns
      .filter((c) => c.status === status)
      .map((c): BoardSlot => ({
        kind: 'own',
        key: `own:${c.id}`,
        status,
        name: c.name,
        id: c.id,
      })),
    ...(showHidden || !s.hidden.includes(status)
      ? [{ kind: 'status', key: status, status, name: status } as BoardSlot]
      : []),
  ]);
}

/**
 * The column a card sits in: its own column while the task still has that
 * column's status, otherwise the column of its status. A status change from
 * the file or elsewhere therefore moves the card out of an own column.
 */
export function slotOf(
  t: Pick<Task, 'status' | 'boardColumn'>,
  s: BoardSettings,
): string {
  const own = t.boardColumn
    ? s.columns.find((c) => c.id === t.boardColumn && c.status === t.status)
    : undefined;
  return own ? `own:${own.id}` : t.status;
}

/** Saved settings made safe: known statuses, named columns with unique ids. */
export function cleanBoard(s: Partial<BoardSettings> | null): BoardSettings {
  if (!s) return DEFAULT_BOARD;
  const seen = new Set<string>();
  return {
    hidden: (s.hidden ?? []).filter((x) => STATUSES.includes(x)),
    columns: (s.columns ?? [])
      .map((c) => ({ ...c, name: String(c.name ?? '').trim() }))
      .filter(
        (c) =>
          c.id &&
          c.name &&
          STATUSES.includes(c.status) &&
          !seen.has(c.id) &&
          seen.add(c.id),
      ),
  };
}
