/**
 * The filter in the top bar (spec 01: all views can be filtered by project,
 * assignee, status and label). It applies to every view together with the
 * search; the project comes from the view itself.
 */
import {
  personName,
  shownPriority,
  type Level,
  type Person,
  type Status,
  type Task,
} from './model';

export interface ViewFilter {
  /** People by the name shown; a task matches its assignee or who handles it. */
  people: string[];
  statuses: Status[];
  levels: Level[];
  labels: string[];
}

export const NO_FILTER: ViewFilter = {
  people: [],
  statuses: [],
  levels: [],
  labels: [],
};

export const filterCount = (f: ViewFilter) =>
  f.people.length + f.statuses.length + f.levels.length + f.labels.length;

const splitNames = (s: string) =>
  s
    .split(/\s*[,、，/／]\s*/)
    .map((x) => x.trim())
    .filter(Boolean);

/** The names a task is known by: its assignees as shown, and who handles it. */
export function taskPeople(t: Task, people: Person[]): string[] {
  const assignees = splitNames(personName(people, t.projectId, t.assignee));
  const handled = splitNames(
    t.situation.handledBy.replace(/\s*\([^)]*\)/g, ''),
  );
  return [...new Set([...assignees, ...handled])];
}

/**
 * Whether a task passes the filter. Within a group any choice matches, and
 * every group with choices must match.
 */
export function matchesFilter(
  t: Task,
  f: ViewFilter,
  people: Person[],
): boolean {
  if (f.statuses.length && !f.statuses.includes(t.status)) return false;
  if (f.levels.length && !f.levels.includes(shownPriority(t))) return false;
  if (
    f.labels.length &&
    !t.labels.some((l) =>
      f.labels.some((x) => x.toLowerCase() === l.toLowerCase()),
    )
  )
    return false;
  if (f.people.length) {
    const mine = taskPeople(t, people).map((x) => x.toLowerCase());
    if (!f.people.some((p) => mine.includes(p.toLowerCase()))) return false;
  }
  return true;
}

/** The choices to offer, from the tasks in sight, most used first. */
export function filterChoices(tasks: Task[], people: Person[]) {
  const count = (list: string[]) => {
    const m = new Map<string, number>();
    for (const x of list) m.set(x, (m.get(x) ?? 0) + 1);
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([v]) => v);
  };
  return {
    people: count(tasks.flatMap((t) => taskPeople(t, people))),
    labels: count(tasks.flatMap((t) => t.labels)),
  };
}
