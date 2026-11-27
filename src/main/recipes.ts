/**
 * Recipes (doc 12): kept on this PC only, never synced or exported. A recipe
 * is personal (no project) or belongs to one project, like a note; when its
 * project is deleted it stays, under No project.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  RUNS_KEPT,
  STARTERS,
  syncBlanks,
  type Blank,
  type FillFrom,
  type Recipe,
  type RecipeInput,
  type RecipeLink,
  type RecipeRun,
} from '../shared/recipes';
import type { Discussions } from './discussions';
import type { Store } from './store';

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const json = <T>(v: unknown, fallback: T): T => {
  try {
    return JSON.parse(str(v)) as T;
  } catch {
    return fallback;
  }
};

/** Set once the starters were added, so deleting them all keeps them gone. */
const SEEDED = 'recipesSeeded';

export class Recipes {
  constructor(
    private db: DatabaseSync,
    private store: Store,
    private discussions: Discussions,
    private now: () => string = () => new Date().toISOString(),
  ) {}

  private toRecipe(r: Row): Recipe {
    return {
      id: str(r.id),
      projectId: r.project_id == null ? null : str(r.project_id),
      name: str(r.name),
      description: str(r.description),
      instructions: str(r.instructions),
      blanks: json<Blank[]>(r.blanks, []),
      sections: json<string[]>(r.sections, []),
      followups: json<string[]>(r.followups, []),
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
    };
  }

  /** Every recipe, personal and of every project. Adds the starters the first time. */
  list(): Recipe[] {
    this.seed();
    return (
      this.db
        .prepare('SELECT * FROM recipes ORDER BY name COLLATE NOCASE')
        .all() as Row[]
    ).map((r) => this.toRecipe(r));
  }

  get(id: string): Recipe {
    const r = this.db.prepare('SELECT * FROM recipes WHERE id = ?').get(id) as
      | Row
      | undefined;
    if (!r) throw new Error('This recipe no longer exists.');
    return this.toRecipe(r);
  }

  private seed(): void {
    if (this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(SEEDED))
      return;
    for (const s of STARTERS) this.save(s);
    this.db
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(SEEDED, 'true');
  }

  /** Adds a recipe, or changes one. The blanks follow the instructions. */
  save(input: RecipeInput, id?: string): Recipe {
    const name = input.name.trim();
    if (!name) throw new Error('A recipe needs a name.');
    if (
      input.projectId &&
      !this.db
        .prepare('SELECT 1 FROM projects WHERE id = ?')
        .get(input.projectId)
    )
      throw new Error('That project no longer exists.');
    const blanks = syncBlanks(input.instructions, input.blanks).map((b) => ({
      ...b,
      label: b.label.trim() || b.key,
      choices: b.choices.map((c) => c.trim()).filter(Boolean),
    }));
    const clean = (xs: string[]) => [
      ...new Set(xs.map((x) => x.trim()).filter(Boolean)),
    ];
    const v = [
      input.projectId ?? null,
      name,
      input.description.trim(),
      input.instructions,
      JSON.stringify(blanks),
      JSON.stringify(clean(input.sections)),
      JSON.stringify(clean(input.followups)),
    ];
    const now = this.now();
    if (id) {
      this.get(id);
      this.db
        .prepare(
          'UPDATE recipes SET project_id = ?, name = ?, description = ?, instructions = ?, blanks = ?, sections = ?, followups = ?, updated_at = ? WHERE id = ?',
        )
        .run(...(v as never[]), now, id);
      return this.get(id);
    }
    const newId = randomUUID();
    this.db
      .prepare(
        'INSERT INTO recipes (id, project_id, name, description, instructions, blanks, sections, followups, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(newId, ...(v as never[]), now, now);
    return this.get(newId);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM recipes WHERE id = ?').run(id);
  }

  /** Keeps the values of blanks that remember them, for next time. */
  remember(id: string, values: Record<string, string>): void {
    const r = this.get(id);
    let changed = false;
    const blanks = r.blanks.map((b) => {
      const v = values[b.key];
      if (!b.remember || v === undefined || v === b.last) return b;
      changed = true;
      return { ...b, last: v };
    });
    if (changed)
      this.db
        .prepare('UPDATE recipes SET blanks = ? WHERE id = ?')
        .run(JSON.stringify(blanks), id);
  }

  runs(recipeId: string): RecipeRun[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM recipe_runs WHERE recipe_id = ? ORDER BY at DESC, rowid DESC',
        )
        .all(recipeId) as Row[]
    ).map((r) => ({
      id: str(r.id),
      recipeId: str(r.recipe_id),
      at: str(r.at),
      values: json<Record<string, string>>(r.vals, {}),
      link: json<RecipeLink | null>(r.link, null),
      request: str(r.request),
      answer: str(r.answer),
      provider: str(r.provider),
    }));
  }

  /** Records a run; only the last few of each recipe are kept. */
  addRun(run: Omit<RecipeRun, 'id' | 'at'>): RecipeRun {
    this.get(run.recipeId);
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO recipe_runs (id, recipe_id, at, vals, link, request, answer, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        run.recipeId,
        this.now(),
        JSON.stringify(run.values),
        run.link ? JSON.stringify(run.link) : null,
        run.request,
        run.answer,
        run.provider,
      );
    const old = this.runs(run.recipeId).slice(RUNS_KEPT);
    for (const r of old)
      this.db.prepare('DELETE FROM recipe_runs WHERE id = ?').run(r.id);
    return this.runs(run.recipeId).find((r) => r.id === id)!;
  }

  /** What a linked ticket or discussion offers to fill blanks with. */
  fill(link: RecipeLink): Record<Exclude<FillFrom, ''>, string> {
    const situation = (taskId: string | null) => {
      if (!taskId) return '';
      const s = this.store.getTask(taskId).situation;
      return [
        s.handledBy && `Handled by: ${s.handledBy}`,
        s.doingNow && `Doing now: ${s.doingNow}`,
        s.nextStep &&
          `Next: ${s.nextStep}${s.nextDate ? ` by ${s.nextDate}` : ''}`,
      ]
        .filter(Boolean)
        .join('\n');
    };
    const lastComment = (discussionId: string | null) => {
      if (!discussionId) return '';
      const c = this.discussions
        .comments(discussionId)
        .filter((x) => !x.deleted)
        .at(-1);
      return c?.body ?? '';
    };
    if (link.kind === 'discussion') {
      const d = this.discussions.get(link.id);
      const t = d.linkedTaskId ? this.store.getTask(d.linkedTaskId) : null;
      return {
        title: d.title,
        description: d.description,
        summary: t?.summary ?? '',
        situation: situation(d.linkedTaskId),
        comment: lastComment(d.id),
      };
    }
    const t = this.store.getTask(link.id);
    const d = (
      this.db
        .prepare('SELECT id FROM discussions WHERE linked_task_id = ?')
        .get(t.id) as Row | undefined
    )?.id;
    return {
      title: t.titleTranslation || t.titleOriginal,
      description: t.descriptionOriginal,
      summary: t.summary,
      situation: situation(t.id),
      comment: lastComment(d ? str(d) : null),
    };
  }
}
