import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_RELEASE_LISTS,
  fieldKey,
  type Release,
  type ReleaseField,
  type ReleaseInput,
  type ReleaseLists,
  type ReleaseModule,
} from '../shared/releases';

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const clean = (v: unknown) => str(v).trim();
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A list without blanks or repeats, in the order given. */
const uniq = (list: unknown): string[] => {
  const out: string[] = [];
  for (const v of Array.isArray(list) ? list : []) {
    const t = clean(v);
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
};

/** Fields without blanks or repeated keys, in the order given. */
const uniqFields = (list: unknown): ReleaseField[] => {
  const out: ReleaseField[] = [];
  for (const f of Array.isArray(list) ? list : []) {
    const name = clean((f as ReleaseField)?.name);
    if (!name) continue;
    const key = clean((f as ReleaseField)?.key) || fieldKey(name);
    if (!out.some((x) => x.key === key)) out.push({ key, name });
  }
  return out;
};

const parseExtra = (v: unknown): Record<string, string> => {
  try {
    const o = JSON.parse(str(v) || '{}') as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(o ?? {}))
      if (clean(x)) out[k] = str(x).trim();
    return out;
  } catch {
    return {};
  }
};

/** Software releases of a project, and the lists they pick from. */
export class Releases {
  constructor(
    private db: DatabaseSync,
    private now: () => string = () => new Date().toISOString(),
  ) {}

  private project(projectId: string) {
    const r = this.db
      .prepare('SELECT id, release_lists FROM projects WHERE id = ?')
      .get(projectId) as Row | undefined;
    if (!r) throw new Error('That project no longer exists.');
    return r;
  }

  getLists(projectId: string): ReleaseLists {
    const raw = str(this.project(projectId).release_lists);
    let saved: Partial<ReleaseLists> = {};
    try {
      saved = raw ? JSON.parse(raw) : {};
    } catch {
      saved = {};
    }
    return {
      products: uniq(saved.products ?? DEFAULT_RELEASE_LISTS.products),
      editions: uniq(saved.editions ?? DEFAULT_RELEASE_LISTS.editions),
      destinations: uniq(
        saved.destinations ?? DEFAULT_RELEASE_LISTS.destinations,
      ),
      categories: uniq(saved.categories ?? DEFAULT_RELEASE_LISTS.categories),
      environments: uniq(
        saved.environments ?? DEFAULT_RELEASE_LISTS.environments,
      ),
      fields: uniqFields(saved.fields ?? DEFAULT_RELEASE_LISTS.fields),
    };
  }

  saveLists(projectId: string, lists: ReleaseLists): ReleaseLists {
    this.project(projectId);
    const next: ReleaseLists = {
      products: uniq(lists.products),
      editions: uniq(lists.editions),
      destinations: uniq(lists.destinations),
      categories: uniq(lists.categories),
      environments: uniq(lists.environments),
      fields: uniqFields(lists.fields),
    };
    this.db
      .prepare('UPDATE projects SET release_lists = ? WHERE id = ?')
      .run(JSON.stringify(next), projectId);
    return next;
  }

  private toRelease(r: Row): Release {
    const modules = (
      this.db
        .prepare(
          'SELECT * FROM release_modules WHERE release_id = ? ORDER BY position, rowid',
        )
        .all(str(r.id)) as Row[]
    ).map((m): ReleaseModule => ({
      id: str(m.id),
      destination: str(m.destination),
      category: str(m.category),
      type: str(m.type),
      module: str(m.module),
      fileName: str(m.file_name),
      environment: str(m.environment),
      version: str(m.version),
      changes: str(m.changes),
      purpose: str(m.purpose),
      verification: str(m.verification),
      extra: parseExtra(m.extra),
    }));
    return {
      id: str(r.id),
      projectId: str(r.project_id),
      product: str(r.product),
      target: str(r.target),
      releasedOn: r.released_on ? str(r.released_on) : null,
      version: str(r.version),
      status: str(r.status) === 'planned' ? 'planned' : 'released',
      summary: str(r.summary),
      purpose: str(r.purpose),
      changes: str(r.changes),
      verification: str(r.verification),
      modules,
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
    };
  }

  list(projectId: string): Release[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM releases WHERE project_id = ? ORDER BY released_on, created_at',
        )
        .all(projectId) as Row[]
    ).map((r) => this.toRelease(r));
  }

  get(id: string): Release {
    const r = this.db.prepare('SELECT * FROM releases WHERE id = ?').get(id) as
      | Row
      | undefined;
    if (!r) throw new Error('This release no longer exists.');
    return this.toRelease(r);
  }

  /** Adds a release, or changes the one with this id (its modules are replaced). */
  save(
    projectId: string,
    input: ReleaseInput,
    id?: string,
    /** False when the caller holds the transaction (an import). */
    own = true,
  ): Release {
    this.project(projectId);
    const v = {
      product: clean(input.product),
      target: clean(input.target),
      releasedOn: input.releasedOn ? clean(input.releasedOn) : null,
      version: clean(input.version),
      status: input.status === 'planned' ? 'planned' : 'released',
      summary: clean(input.summary),
      purpose: str(input.purpose).trim(),
      changes: str(input.changes).trim(),
      verification: str(input.verification).trim(),
    };
    if (!v.product) throw new Error('Choose the product the release is of.');
    if (!v.version) throw new Error('Write the release version.');
    if (v.releasedOn && !DATE.test(v.releasedOn))
      throw new Error('The release date is not a date.');
    if (v.status === 'released' && !v.releasedOn)
      throw new Error('A released version needs its release date.');
    const modules = (input.modules ?? [])
      .map((m) => ({
        id: m.id ? clean(m.id) : '',
        destination: clean(m.destination),
        category: clean(m.category),
        type: clean(m.type),
        module: clean(m.module),
        fileName: clean(m.fileName),
        environment: clean(m.environment),
        version: clean(m.version),
        changes: str(m.changes).trim(),
        purpose: str(m.purpose).trim(),
        verification: str(m.verification).trim(),
        extra: parseExtra(JSON.stringify(m.extra ?? {})),
      }))
      .filter(
        (m) =>
          m.module ||
          m.fileName ||
          m.version ||
          m.changes ||
          m.purpose ||
          m.verification,
      );
    if (modules.some((m) => !m.module && !m.fileName))
      throw new Error('Give each module a name or a file name.');
    const now = this.now();
    const releaseId = id ?? randomUUID();
    if (own) this.db.exec('BEGIN');
    try {
      if (id) {
        this.get(id);
        this.db
          .prepare(
            'UPDATE releases SET product = ?, target = ?, released_on = ?, version = ?, status = ?, summary = ?, purpose = ?, changes = ?, verification = ?, updated_at = ? WHERE id = ?',
          )
          .run(
            v.product,
            v.target,
            v.releasedOn,
            v.version,
            v.status,
            v.summary,
            v.purpose,
            v.changes,
            v.verification,
            now,
            id,
          );
      } else
        this.db
          .prepare(
            'INSERT INTO releases (id, project_id, product, target, released_on, version, status, summary, purpose, changes, verification, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            releaseId,
            projectId,
            v.product,
            v.target,
            v.releasedOn,
            v.version,
            v.status,
            v.summary,
            v.purpose,
            v.changes,
            v.verification,
            now,
            now,
          );
      // Modules keep their ids, so a change merges as a change, not a new row.
      const had = new Set(
        (
          this.db
            .prepare('SELECT id FROM release_modules WHERE release_id = ?')
            .all(releaseId) as Row[]
        ).map((r) => str(r.id)),
      );
      const kept = new Set<string>();
      const update = this.db.prepare(
        'UPDATE release_modules SET position = ?, destination = ?, category = ?, type = ?, module = ?, file_name = ?, environment = ?, version = ?, changes = ?, purpose = ?, verification = ?, extra = ? WHERE id = ?',
      );
      const add = this.db.prepare(
        'INSERT INTO release_modules (id, release_id, position, destination, category, type, module, file_name, environment, version, changes, purpose, verification, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      modules.forEach((m, i) => {
        const values = [
          m.destination,
          m.category,
          m.type,
          m.module,
          m.fileName,
          m.environment,
          m.version,
          m.changes,
          m.purpose,
          m.verification,
          JSON.stringify(m.extra),
        ] as const;
        if (m.id && had.has(m.id) && !kept.has(m.id)) {
          kept.add(m.id);
          update.run(i, ...values, m.id);
        } else add.run(randomUUID(), releaseId, i, ...values);
      });
      const drop = this.db.prepare('DELETE FROM release_modules WHERE id = ?');
      for (const id of had) if (!kept.has(id)) drop.run(id);
      // New names join the project's lists, so they can be picked next time.
      const lists = this.getLists(projectId);
      const join = (
        key: Exclude<keyof ReleaseLists, 'fields'>,
        values: string[],
      ) => {
        for (const x of values)
          if (x && !lists[key].some((y) => y.toLowerCase() === x.toLowerCase()))
            lists[key].push(x);
      };
      join('products', [v.product]);
      join('editions', [v.target, ...modules.map((m) => m.type)]);
      join(
        'destinations',
        modules.map((m) => m.destination),
      );
      join(
        'categories',
        modules.map((m) => m.category),
      );
      join(
        'environments',
        modules.map((m) => m.environment),
      );
      this.saveLists(projectId, lists);
      if (own) this.db.exec('COMMIT');
    } catch (error) {
      if (own) this.db.exec('ROLLBACK');
      throw error;
    }
    return this.get(releaseId);
  }

  /** Runs `fn` in one transaction: all of it is saved, or none. */
  inOne<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Removes every release of the project (an import that starts again). */
  deleteAll(projectId: string): number {
    return Number(
      this.db
        .prepare('DELETE FROM releases WHERE project_id = ?')
        .run(projectId).changes,
    );
  }

  /** The project's Excel template for the release export, if it has one. */
  getTemplate(
    projectId: string,
  ): { name: string; chosenAt: string; data: Uint8Array } | null {
    const r = this.db
      .prepare('SELECT * FROM release_templates WHERE project_id = ?')
      .get(projectId) as Row | undefined;
    return r
      ? {
          name: str(r.name),
          chosenAt: str(r.chosen_at),
          data: new Uint8Array(r.data as Uint8Array),
        }
      : null;
  }

  setTemplate(projectId: string, name: string, data: Uint8Array): void {
    this.project(projectId);
    this.db
      .prepare(
        'INSERT INTO release_templates (project_id, name, data, chosen_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET name = excluded.name, data = excluded.data, chosen_at = excluded.chosen_at',
      )
      .run(projectId, name, data, this.now());
  }

  clearTemplate(projectId: string): void {
    this.db
      .prepare('DELETE FROM release_templates WHERE project_id = ?')
      .run(projectId);
  }

  delete(id: string): Release {
    const r = this.get(id);
    this.db.prepare('DELETE FROM releases WHERE id = ?').run(id);
    return r;
  }
}
