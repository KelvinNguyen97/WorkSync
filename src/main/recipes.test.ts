import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './db';
import { Store } from './store';
import { Work, meAsMember } from './work';
import { Discussions } from './discussions';
import { Recipes } from './recipes';
import { EMPTY_TASK_INPUT } from '../shared/model';
import { STARTERS, type RecipeInput } from '../shared/recipes';

let db: DatabaseSync;
let store: Store;
let dis: Discussions;
let rs: Recipes;
let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 27, 9, 0, clock++)).toISOString();

beforeEach(() => {
  clock = 0;
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  store = new Store(db, now);
  const work = new Work(db, () => [meAsMember(db)], now);
  dis = new Discussions(db, store, work, now);
  rs = new Recipes(db, store, dis, now);
});

const input = (o: Partial<RecipeInput> = {}): RecipeInput => ({
  projectId: null,
  name: 'Mine',
  description: '',
  instructions: 'Say {{what}} to {{who}}',
  blanks: [],
  sections: [],
  followups: [],
  ...o,
});

describe('Recipes', () => {
  it('adds the starters once, even after they are deleted', () => {
    expect(
      rs
        .list()
        .map((r) => r.name)
        .sort(),
    ).toEqual(STARTERS.map((s) => s.name).sort());
    for (const r of rs.list()) rs.delete(r.id);
    expect(rs.list()).toEqual([]);
  });

  it('saves the blanks the instructions name, and remembers values', () => {
    rs.list();
    const r = rs.save(input());
    expect(r.blanks.map((b) => b.key)).toEqual(['what', 'who']);
    const r2 = rs.save(
      {
        ...input({ instructions: 'Say {{what}} to {{who}} by {{when}}' }),
        blanks: r.blanks.map((b) =>
          b.key === 'who' ? { ...b, remember: true } : b,
        ),
      },
      r.id,
    );
    expect(r2.blanks.map((b) => [b.key, b.remember])).toEqual([
      ['what', false],
      ['who', true],
      ['when', false],
    ]);
    rs.remember(r.id, { what: 'hi', who: 'Tanaka' });
    expect(rs.get(r.id).blanks.map((b) => b.last)).toEqual(['', 'Tanaka', '']);
    expect(() => rs.save(input({ name: ' ' }))).toThrow(/needs a name/);
  });

  it('keeps the last 5 runs of each recipe', () => {
    const r = rs.save(input());
    for (let i = 1; i <= 7; i++)
      rs.addRun({
        recipeId: r.id,
        values: { what: `v${i}` },
        link: null,
        request: 'Q',
        answer: `A${i}`,
        provider: 'Claude Code',
      });
    expect(rs.runs(r.id).map((x) => x.answer)).toEqual([
      'A7',
      'A6',
      'A5',
      'A4',
      'A3',
    ]);
    rs.delete(r.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM recipe_runs').get()).toEqual({
      n: 0,
    });
  });

  it('a project recipe stays, under No project, when its project is deleted', () => {
    const p = store.createProject({
      name: 'P',
      customer: '',
      originalLanguages: ['ja'],
      workingLanguage: 'en',
    });
    const r = rs.save(input({ projectId: p.id }));
    expect(r.projectId).toBe(p.id);
    store.deleteProject(p.id);
    expect(rs.get(r.id).projectId).toBeNull();
  });

  it('fills blanks from a linked ticket and its discussion', () => {
    const p = store.createProject({
      name: 'P',
      customer: '',
      originalLanguages: ['ja'],
      workingLanguage: 'en',
    });
    const t = store.createTask(p.id, {
      ...EMPTY_TASK_INPUT,
      customerId: '016',
      titleOriginal: 'CSV取込で日付がずれる',
      summary: 'Dates shift by one day.',
    });
    const d = dis.save(p.id, { title: 'Dates', no: '' });
    dis.link(d.id, t.id);
    dis.addComment(d.id, { body: 'First' });
    dis.addComment(d.id, { body: '進捗はいかがでしょうか。' });
    const f = rs.fill({ kind: 'ticket', id: t.id, projectId: p.id, label: '' });
    expect(f).toMatchObject({
      title: 'CSV取込で日付がずれる',
      summary: 'Dates shift by one day.',
      comment: '進捗はいかがでしょうか。',
    });
    expect(
      rs.fill({ kind: 'discussion', id: d.id, projectId: p.id, label: '' }),
    ).toMatchObject({ title: 'Dates', summary: 'Dates shift by one day.' });
  });
});
