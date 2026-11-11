import { describe, expect, it } from 'vitest';
import {
  mergeLines,
  mergeProject,
  resolveLines,
  type Row,
  type Tables,
} from './merge';

const project: Row = {
  id: 'p',
  name: 'Portal',
  customer: 'Hoshizora',
  original_languages: '["ja"]',
  working_language: 'en',
  due_soon_days: 7,
  date_format: 'YYYY/MM/DD',
  show_numbers: 1,
  board: null,
};
const task = (id: string, o: Row = {}): Row => ({
  id,
  project_id: 'p',
  customer_id: id.replace('t', ''),
  title_original: `Task ${id}`,
  title_translation: '',
  status: 'In progress',
  priority: 'N',
  summary: '',
  labels: '[]',
  planned_end: null,
  notes: '',
  updated_at: '2026-11-02T00:00:00Z',
  handled_by: '',
  doing_now: '',
  next_step: '',
  next_date: null,
  as_of: null,
  waiting_on: 'Nobody',
  ...o,
});
const upd = (id: string, task: string, at: string, doing: string): Row => ({
  id,
  task_id: task,
  at,
  handled_by: 'You',
  doing_now: doing,
  waiting_on: 'Nobody',
  next_step: '',
  next_date: null,
  as_of: at.slice(0, 10),
});
const side = (o: Partial<Tables>): Tables => ({
  projects: [project],
  tasks: [],
  situation_updates: [],
  difficulties: [],
  activity: [],
  glossary_terms: [],
  people: [],
  notes: [],
  owner_translations: [],
  source_files: [],
  file_versions: [],
  deleted_rows: [],
  ...o,
});

describe('merging the lines of a note', () => {
  const base =
    '- Back up the production database\n- Run the migration on staging\n- Tell the warehouse about the downtime';
  const mine =
    '- Back up the production database\n- Run the migration on staging\n- Check the SSL certificate dates\n- Tell the warehouse about the downtime';
  const theirs =
    '- Back up the production database\n- Run the migration on staging\n- Freeze the nightly batch window\n- Tell the warehouse about the downtime';
  it('keeps both added lines once each: 5 lines, not 8', () => {
    const c = mergeLines(base, mine, theirs);
    expect(c.filter((x) => x.kind === 'conflict')).toHaveLength(1);
    expect(resolveLines(c, 'both').split('\n')).toEqual([
      '- Back up the production database',
      '- Run the migration on staging',
      '- Check the SSL certificate dates',
      '- Freeze the nightly batch window',
      '- Tell the warehouse about the downtime',
    ]);
    expect(resolveLines(c, 'mine')).toBe(mine);
    expect(resolveLines(c, 'theirs')).toBe(theirs);
  });
  it('takes changes made in different places without a conflict', () => {
    const c = mergeLines('a\nb\nc', 'A\nb\nc', 'a\nb\nC');
    expect(c.every((x) => x.kind === 'same')).toBe(true);
    expect(resolveLines(c, 'mine')).toBe('A\nb\nC');
  });
  it('works without a starting point, from the lines both share', () => {
    const c = mergeLines(null, mine, theirs);
    expect(resolveLines(c, 'both').split('\n')).toHaveLength(5);
  });
});

describe('merging a project', () => {
  it('takes what only they changed, and asks where both changed a field', () => {
    const base = side({ tasks: [task('t1')] });
    const mine = side({
      tasks: [
        task('t1', { status: 'In review', updated_at: '2026-11-20T09:00:00Z' }),
      ],
    });
    const theirs = side({
      tasks: [
        task('t1', {
          status: 'On hold',
          summary: 'Fix on staging',
          updated_at: '2026-11-15T09:00:00Z',
        }),
      ],
    });
    const r = mergeProject({ mine, theirs, base, theirsHasNotes: true });
    expect(r.auto.map((a) => [a.id, a.fields])).toEqual([
      ['chg:tasks:t1', ['Summary']],
    ]);
    expect(r.questions).toHaveLength(1);
    expect(r.questions[0]).toMatchObject({
      kind: 'field',
      field: 'Status',
      mine: 'In review',
      theirs: 'On hold',
      suggest: 'mine',
    });
    expect(r.tables.tasks[0]).toMatchObject({
      status: 'In review',
      summary: 'Fix on staging',
    });
    const q = r.questions[0].id;
    const r2 = mergeProject(
      { mine, theirs, base, theirsHasNotes: true },
      { answers: { [q]: 'theirs' }, off: ['chg:tasks:t1'] },
    );
    expect(r2.tables.tasks[0]).toMatchObject({
      status: 'On hold',
      summary: '',
    });
  });

  it('puts their update between yours, and the newest kept is the situation', () => {
    const base = side({
      tasks: [task('t1')],
      situation_updates: [
        upd('u0', 't1', '2026-11-02T10:00:00Z', 'Collecting'),
      ],
    });
    const mine = side({
      tasks: [task('t1')],
      situation_updates: [
        upd('u0', 't1', '2026-11-02T10:00:00Z', 'Collecting'),
        upd('u1', 't1', '2026-11-10T10:00:00Z', 'Reproducing'),
        upd('u3', 't1', '2026-11-20T10:00:00Z', 'Checking the fix'),
      ],
    });
    const theirs = side({
      tasks: [task('t1')],
      situation_updates: [
        upd('u0', 't1', '2026-11-02T10:00:00Z', 'Collecting'),
        upd('u2', 't1', '2026-11-15T10:00:00Z', 'Waiting for data'),
      ],
    });
    const input = { mine, theirs, base, theirsHasNotes: true };
    const r = mergeProject(input);
    const q = r.questions.find((x) => x.kind === 'timeline');
    expect(
      q && q.kind === 'timeline' && q.updates.map((u) => [u.id, u.side]),
    ).toEqual([
      ['u0', 'both'],
      ['u1', 'mine'],
      ['u2', 'theirs'],
      ['u3', 'mine'],
    ]);
    expect(r.tables.situation_updates.map((u) => u.id).sort()).toEqual([
      'u0',
      'u1',
      'u2',
      'u3',
    ]);
    expect(r.tables.tasks[0].doing_now).toBe('Checking the fix');
    // Leaving out your newest makes theirs the current situation.
    const r2 = mergeProject(input, { off: ['upd:u3'] });
    expect(r2.tables.tasks[0].doing_now).toBe('Waiting for data');
    // Leaving out theirs keeps it out.
    const r3 = mergeProject(input, { off: ['upd:u2'] });
    expect(r3.tables.situation_updates.map((u) => u.id)).not.toContain('u2');
  });

  it('adds tasks only they have, unless left out', () => {
    const base = side({ tasks: [task('t1')] });
    const mine = side({ tasks: [task('t1')] });
    const theirs = side({
      tasks: [task('t1'), task('t9')],
      situation_updates: [upd('u9', 't9', '2026-11-12T00:00:00Z', 'New')],
    });
    const input = { mine, theirs, base, theirsHasNotes: true };
    const r = mergeProject(input);
    expect(r.auto.map((a) => a.id)).toEqual(['add:tasks:t9']);
    expect(r.tables.tasks.map((t) => t.id)).toEqual(['t1', 't9']);
    expect(r.tables.situation_updates).toHaveLength(1);
    const r2 = mergeProject(input, { off: ['add:tasks:t9'] });
    expect(r2.tables.tasks.map((t) => t.id)).toEqual(['t1']);
    expect(r2.tables.situation_updates).toHaveLength(0);
  });

  it('deletes what they deleted, but asks when you changed it since', () => {
    const base = side({ tasks: [task('t1'), task('t2')] });
    const mine = side({
      tasks: [task('t1'), task('t2', { summary: 'Mine now' })],
    });
    const theirs = side({ tasks: [] });
    const r = mergeProject({ mine, theirs, base, theirsHasNotes: true });
    expect(r.auto.map((a) => a.id)).toEqual(['del:tasks:t1']);
    expect(
      r.questions.map((q) => [q.kind, q.kind === 'deleted' && q.by]),
    ).toEqual([['deleted', 'theirs']]);
    expect(r.tables.tasks.map((t) => t.id)).toEqual(['t2']);
  });

  it('without a starting point, asks about every difference', () => {
    const mine = side({ tasks: [task('t1', { status: 'Done' })] });
    const theirs = side({
      tasks: [task('t1', { status: 'On hold' }), task('t2')],
    });
    const r = mergeProject({ mine, theirs, base: null, theirsHasNotes: true });
    expect(r.questions.map((q) => q.kind === 'field' && q.field)).toEqual([
      'Status',
    ]);
    expect(r.auto.map((a) => a.id)).toEqual(['add:tasks:t2']);
  });

  it('merges a note both edited, and asks only where lines clash', () => {
    const note = (body: string, at: string): Row => ({
      id: 'n1',
      project_id: 'p',
      title: 'Checklist',
      body,
      tags: '[]',
      updated_at: at,
    });
    const base = side({ notes: [note('a\nb', '2026-11-01T00:00:00Z')] });
    const mine = side({ notes: [note('a\nb\nmine', '2026-11-19T00:00:00Z')] });
    const theirs = side({
      notes: [note('a\nb\ntheirs', '2026-11-21T00:00:00Z')],
    });
    const r = mergeProject({ mine, theirs, base, theirsHasNotes: true });
    const q = r.questions[0];
    expect(q.kind).toBe('note');
    expect(q.suggest).toBe('theirs');
    const r2 = mergeProject(
      { mine, theirs, base, theirsHasNotes: true },
      { answers: { [q.id]: 'both' } },
    );
    expect(r2.tables.notes[0].body).toBe('a\nb\nmine\ntheirs');
    // A file without notes leaves yours as they are.
    const r3 = mergeProject({ mine, theirs, base, theirsHasNotes: false });
    expect(r3.questions).toHaveLength(0);
    expect(r3.tables.notes[0].body).toBe('a\nb\nmine');
  });
});
