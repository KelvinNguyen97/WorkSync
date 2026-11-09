import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  MyPriority,
  MyStatus,
  MyTask,
  MyTaskInput,
} from '../shared/myTasks';
import {
  imageType,
  MAX_IMAGE_BYTES,
  noteImageIds,
  parseTags,
  type Note,
  type NoteInput,
} from '../shared/notes';
import {
  baseName,
  pathKey,
  type CatalogEntry,
  type CatalogEntryInput,
  type EntryKind,
} from '../shared/catalog';

/**
 * The owner's own things, kept apart from projects: My tasks (and, next,
 * Notes and the Catalog).
 */

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? '' : String(v));
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export class Mine {
  constructor(
    private db: DatabaseSync,
    private now: () => string = () => new Date().toISOString(),
  ) {}

  // ------------------------------------------------------------ My tasks

  private toMyTask(r: Row): MyTask {
    return {
      id: str(r.id),
      title: str(r.title),
      description: str(r.description),
      status: str(r.status) as MyStatus,
      priority: str(r.priority) as MyPriority,
      dueDate: r.due_date == null ? null : str(r.due_date),
      reminders: Number(r.reminders) === 1,
      lastReminderKey:
        r.last_reminder_key == null ? null : str(r.last_reminder_key),
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
    };
  }

  listMyTasks(): MyTask[] {
    return (
      this.db
        .prepare('SELECT * FROM my_tasks ORDER BY created_at')
        .all() as Row[]
    ).map((r) => this.toMyTask(r));
  }

  getMyTask(id: string): MyTask {
    const r = this.db.prepare('SELECT * FROM my_tasks WHERE id = ?').get(id) as
      | Row
      | undefined;
    if (!r)
      throw new Error('This task was not found. It may have been completed.');
    return this.toMyTask(r);
  }

  private clean(input: Partial<MyTaskInput>, before?: MyTask): MyTaskInput {
    const v = {
      title: (input.title ?? before?.title ?? '').trim(),
      description: (input.description ?? before?.description ?? '').trim(),
      status: input.status ?? before?.status ?? 'todo',
      priority: input.priority ?? before?.priority ?? 'N',
      dueDate:
        input.dueDate === undefined
          ? (before?.dueDate ?? null)
          : input.dueDate || null,
      reminders: input.reminders ?? before?.reminders ?? true,
    };
    if (!v.title) throw new Error('A task needs a title.');
    if (!['todo', 'ongoing'].includes(v.status))
      throw new Error('The status must be Todo or On-going.');
    if (!['U', 'N', 'L'].includes(v.priority))
      throw new Error('The priority must be Urgent, Normal or Low.');
    if (v.dueDate && !ISO_DAY.test(v.dueDate))
      throw new Error('The due date is not a date.');
    return v;
  }

  /** Adds a task, or changes one when id is given. */
  saveMyTask(input: Partial<MyTaskInput>, id?: string): MyTask {
    const now = this.now();
    if (id) {
      const before = this.getMyTask(id);
      const v = this.clean(input, before);
      // A change of status or priority starts the reminders afresh.
      const resetKey =
        v.status !== before.status || v.priority !== before.priority;
      this.db
        .prepare(
          `UPDATE my_tasks SET title = ?, description = ?, status = ?, priority = ?, due_date = ?, reminders = ?,
             last_reminder_key = CASE WHEN ? THEN NULL ELSE last_reminder_key END, updated_at = ? WHERE id = ?`,
        )
        .run(
          v.title,
          v.description,
          v.status,
          v.priority,
          v.dueDate,
          v.reminders ? 1 : 0,
          resetKey ? 1 : 0,
          now,
          id,
        );
      return this.getMyTask(id);
    }
    const v = this.clean(input);
    const newId = randomUUID();
    this.db
      .prepare(
        'INSERT INTO my_tasks (id, title, description, status, priority, due_date, reminders, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        newId,
        v.title,
        v.description,
        v.status,
        v.priority,
        v.dueDate,
        v.reminders ? 1 : 0,
        now,
        now,
      );
    return this.getMyTask(newId);
  }

  /** Completing a task deletes it; the deleted task comes back for Undo. */
  deleteMyTask(id: string): MyTask {
    const t = this.getMyTask(id);
    this.db.prepare('DELETE FROM my_tasks WHERE id = ?').run(id);
    return t;
  }

  /** Puts back a task deleted a moment ago (Undo). */
  restoreMyTask(t: MyTask): MyTask {
    const v = this.clean(t);
    this.db
      .prepare(
        'INSERT OR REPLACE INTO my_tasks (id, title, description, status, priority, due_date, reminders, last_reminder_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        t.id,
        v.title,
        v.description,
        v.status,
        v.priority,
        v.dueDate,
        v.reminders ? 1 : 0,
        t.lastReminderKey,
        t.createdAt,
        this.now(),
      );
    return this.getMyTask(t.id);
  }

  /** Records that a reminder slot was shown. */
  setReminderKey(id: string, key: string): void {
    this.db
      .prepare('UPDATE my_tasks SET last_reminder_key = ? WHERE id = ?')
      .run(key, id);
  }

  // ------------------------------------------------------------ Notes

  private toNote(r: Row): Note {
    return {
      id: str(r.id),
      projectId: r.project_id == null ? null : str(r.project_id),
      title: str(r.title),
      body: str(r.body),
      tags: JSON.parse(str(r.tags) || '[]'),
      favorite: Number(r.favorite) === 1,
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
      viewedAt: r.viewed_at == null ? null : str(r.viewed_at),
    };
  }

  listNotes(): Note[] {
    return (
      this.db
        .prepare('SELECT * FROM notes ORDER BY updated_at DESC')
        .all() as Row[]
    ).map((r) => this.toNote(r));
  }

  getNote(id: string): Note {
    const r = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as
      | Row
      | undefined;
    if (!r)
      throw new Error('This note was not found. It may have been deleted.');
    return this.toNote(r);
  }

  private checkProject(projectId: string | null) {
    if (
      projectId &&
      !this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)
    )
      throw new Error('That project no longer exists.');
  }

  /** Adds a note, or changes one when id is given. Only the parts given change. */
  saveNote(input: Partial<NoteInput>, id?: string): Note {
    const now = this.now();
    const before = id ? this.getNote(id) : null;
    const v: NoteInput = {
      projectId:
        input.projectId === undefined
          ? (before?.projectId ?? null)
          : input.projectId,
      title: (input.title ?? before?.title ?? '').slice(0, 300),
      body: input.body ?? before?.body ?? '',
      tags: parseTags((input.tags ?? before?.tags ?? []).join(',')),
      favorite: input.favorite ?? before?.favorite ?? false,
    };
    this.checkProject(v.projectId);
    if (before && id) {
      this.db
        .prepare(
          'UPDATE notes SET project_id = ?, title = ?, body = ?, tags = ?, favorite = ?, updated_at = ? WHERE id = ?',
        )
        .run(
          v.projectId,
          v.title,
          v.body,
          JSON.stringify(v.tags),
          v.favorite ? 1 : 0,
          now,
          id,
        );
      return this.getNote(id);
    }
    const newId = randomUUID();
    this.db
      .prepare(
        'INSERT INTO notes (id, project_id, title, body, tags, favorite, created_at, updated_at, viewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        newId,
        v.projectId,
        v.title,
        v.body,
        JSON.stringify(v.tags),
        v.favorite ? 1 : 0,
        now,
        now,
        now,
      );
    return this.getNote(newId);
  }

  /** Records that a note was opened, for Recent; its change time stays. */
  viewNote(id: string): Note {
    this.db
      .prepare('UPDATE notes SET viewed_at = ? WHERE id = ?')
      .run(this.now(), id);
    return this.getNote(id);
  }

  deleteNote(id: string): Note {
    const n = this.getNote(id);
    this.db.prepare('DELETE FROM notes WHERE id = ?').run(id);
    return n;
  }

  /** Puts back a note deleted a moment ago (Undo). */
  /** Keeps an image pasted into a note; the note places it by the id returned. */
  addNoteImage(bytes: Uint8Array): string {
    if (!(bytes instanceof Uint8Array) || !bytes.length)
      throw new Error('This is not an image.');
    if (bytes.length > MAX_IMAGE_BYTES)
      throw new Error('This image is too large (20 MB at most).');
    const mime = imageType(bytes);
    if (!mime)
      throw new Error('Only PNG, JPEG, GIF, WebP and BMP images can be added.');
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO note_images (id, mime, data, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(id, mime, bytes, this.now());
    return id;
  }

  getNoteImage(id: string): { mime: string; data: Uint8Array } {
    const r = this.db
      .prepare('SELECT mime, data FROM note_images WHERE id = ?')
      .get(id) as Row | undefined;
    if (!r) throw new Error('This image is no longer there.');
    return { mime: str(r.mime), data: new Uint8Array(r.data as Uint8Array) };
  }

  /**
   * Removes images no note uses any more. Only images older than a day go,
   * so a note deleted and put back, or not yet saved, keeps its images.
   */
  dropUnusedNoteImages(): number {
    const used = new Set(
      (this.db.prepare('SELECT body FROM notes').all() as Row[]).flatMap((r) =>
        noteImageIds(str(r.body)),
      ),
    );
    const before = new Date(
      new Date(this.now()).getTime() - 86400000,
    ).toISOString();
    const old = this.db
      .prepare('SELECT id FROM note_images WHERE created_at < ?')
      .all(before) as Row[];
    const drop = this.db.prepare('DELETE FROM note_images WHERE id = ?');
    let n = 0;
    for (const r of old)
      if (!used.has(str(r.id))) {
        drop.run(str(r.id));
        n++;
      }
    return n;
  }

  restoreNote(n: Note): Note {
    const projectId =
      n.projectId &&
      this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(n.projectId)
        ? n.projectId
        : null;
    this.db
      .prepare(
        'INSERT OR REPLACE INTO notes (id, project_id, title, body, tags, favorite, created_at, updated_at, viewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        n.id,
        projectId,
        n.title,
        n.body,
        JSON.stringify(parseTags(n.tags.join(','))),
        n.favorite ? 1 : 0,
        n.createdAt,
        n.updatedAt,
        n.viewedAt,
      );
    return this.getNote(n.id);
  }

  // ------------------------------------------------------------ Catalog

  private toEntry(r: Row, exists: (p: string) => boolean): CatalogEntry {
    const path = str(r.path);
    return {
      id: str(r.id),
      kind: str(r.kind) as EntryKind,
      name: str(r.name),
      path,
      tags: JSON.parse(str(r.tags) || '[]'),
      note: str(r.note),
      favorite: Number(r.favorite) === 1,
      addedAt: str(r.added_at),
      lastOpened: r.last_opened == null ? null : str(r.last_opened),
      missing: !exists(path),
    };
  }

  /** Every entry, each checked for whether its path is still there. */
  listCatalog(exists: (p: string) => boolean): CatalogEntry[] {
    return (
      this.db
        .prepare('SELECT * FROM catalog_entries ORDER BY added_at')
        .all() as Row[]
    ).map((r) => this.toEntry(r, exists));
  }

  getEntry(id: string, exists: (p: string) => boolean): CatalogEntry {
    const r = this.db
      .prepare('SELECT * FROM catalog_entries WHERE id = ?')
      .get(id) as Row | undefined;
    if (!r) throw new Error('This entry was not found in the Catalog.');
    return this.toEntry(r, exists);
  }

  /** The entry with this path, if the Catalog has it. */
  findEntry(path: string): string | null {
    const key = pathKey(path);
    const rows = this.db
      .prepare('SELECT id, path FROM catalog_entries')
      .all() as Row[];
    return str(rows.find((r) => pathKey(str(r.path)) === key)?.id) || null;
  }

  /** Adds an entry, or changes one when id is given. A path is in the Catalog once. */
  saveEntry(
    input: Partial<CatalogEntryInput>,
    exists: (p: string) => boolean,
    id?: string,
  ): CatalogEntry {
    const before = id ? this.getEntry(id, exists) : null;
    const path = (input.path ?? before?.path ?? '').trim();
    if (!path) throw new Error('Choose a file or folder.');
    const kind = input.kind ?? before?.kind ?? 'file';
    if (kind !== 'file' && kind !== 'folder')
      throw new Error('An entry is a file or a folder.');
    const other = this.findEntry(path);
    if (other && other !== id)
      throw new Error(`${baseName(path)} is already in the Catalog.`);
    const v = {
      name: (input.name ?? before?.name ?? '').trim() || baseName(path),
      tags: parseTags((input.tags ?? before?.tags ?? []).join(',')),
      note: (input.note ?? before?.note ?? '').trim(),
      favorite: input.favorite ?? before?.favorite ?? false,
    };
    if (before && id) {
      this.db
        .prepare(
          'UPDATE catalog_entries SET kind = ?, name = ?, path = ?, tags = ?, note = ?, favorite = ? WHERE id = ?',
        )
        .run(
          kind,
          v.name,
          path,
          JSON.stringify(v.tags),
          v.note,
          v.favorite ? 1 : 0,
          id,
        );
      return this.getEntry(id, exists);
    }
    const newId = randomUUID();
    this.db
      .prepare(
        'INSERT INTO catalog_entries (id, kind, name, path, tags, note, favorite, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        newId,
        kind,
        v.name,
        path,
        JSON.stringify(v.tags),
        v.note,
        v.favorite ? 1 : 0,
        this.now(),
      );
    return this.getEntry(newId, exists);
  }

  /** Removes an entry from the Catalog; the file or folder itself stays. */
  deleteEntry(id: string, exists: (p: string) => boolean): CatalogEntry {
    const e = this.getEntry(id, exists);
    this.db.prepare('DELETE FROM catalog_entries WHERE id = ?').run(id);
    return e;
  }

  restoreEntry(e: CatalogEntry, exists: (p: string) => boolean): CatalogEntry {
    if (this.findEntry(e.path))
      throw new Error(`${baseName(e.path)} is already in the Catalog.`);
    this.db
      .prepare(
        'INSERT INTO catalog_entries (id, kind, name, path, tags, note, favorite, added_at, last_opened) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        e.id,
        e.kind,
        e.name,
        e.path,
        JSON.stringify(parseTags(e.tags.join(','))),
        e.note,
        e.favorite ? 1 : 0,
        e.addedAt,
        e.lastOpened,
      );
    return this.getEntry(e.id, exists);
  }

  markOpened(id: string): void {
    this.db
      .prepare('UPDATE catalog_entries SET last_opened = ? WHERE id = ?')
      .run(this.now(), id);
  }
}
