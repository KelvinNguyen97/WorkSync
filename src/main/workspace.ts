import { createHash, randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  Hlc,
  WORKSPACE_FORMAT,
  type JoinRequest,
  type WsConflict,
  type Notice,
  type NoticeKind,
  type WorkspaceInfo,
  type WsMember,
  type WsState,
} from '../shared/workspace';
import { colorOf, tagOf, type Member } from '../shared/work';
import {
  joinCode,
  lockKeyFor,
  lockWithPassword,
  makePcKeys,
  newWorkspaceKey,
  open,
  openWithPassword,
  pcIdOf,
  publicOf,
  seal,
  signText,
  unlockKey,
  UnreadableFile,
  verifyText,
  type PcKeys,
} from './wsCrypto';
import {
  columns,
  fromWire,
  SHARED_TABLES,
  sharedRows,
  TABLE,
  toWire,
} from './wsTables';

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** Keeps secrets with Windows' protection for the signed-in user (Electron safeStorage). */
export interface Protector {
  seal(plain: string): string;
  open(sealed: string): string;
}

export interface WorkspaceDeps {
  protector: Protector;
  now?: () => Date;
  account: () => string;
  pcName: () => string;
  myName: () => string;
  myMemberId: () => string;
  setMyMemberId: (id: string) => void;
  appVersion?: string;
  /** Folder work slower than this counts as unreachable (ms). */
  limit?: number;
  /** Called before a ticket is deleted because another member deleted it, to keep it in the Trash. */
  onTicketRemoved?: (ticketId: string, byName: string) => void;
  /** How old a change file must be before a snapshot lets it be removed (ms; 30 days). */
  keepChangeFilesMs?: number;
  /** How old the newest snapshot may get before this PC writes one (ms; a day). */
  snapshotEveryMs?: number;
}

/**
 * Fields where a change made on this PC and not yet sent, and a different
 * change by someone else, is put to the person to settle (doc 08, 3.4).
 */
const ASK: Record<string, string[]> = {
  tasks: [
    'customer_id',
    'title_translation',
    'summary',
    'status',
    'priority',
    'assignee',
    'category',
    'planned_start',
    'planned_end',
    'actual_start',
    'actual_end',
    'handled_by',
    'doing_now',
    'next_step',
    'next_date',
  ],
  project_tasks: [
    'title',
    'note',
    'assignee',
    'due_date',
    'priority',
    'status',
  ],
  discussions: ['title', 'description', 'state'],
  notes: ['title', 'body'],
};

interface SnapRow {
  t: string;
  id: string;
  d: Row;
  c: Record<string, string>;
  x: boolean;
}

/** What a member file says. */
interface MemberRec {
  pcId: string;
  memberId: string;
  name: string;
  account: string;
  pc: string;
  signPub: string;
  boxPub: string;
  approvedBy: string;
  at: string;
}

interface RequestRec {
  kind: 'join';
  workspaceId: string;
  pcId: string;
  memberId: string;
  name: string;
  account: string;
  pc: string;
  signPub: string;
  boxPub: string;
  at: string;
  sig: string;
}

interface Removal {
  target: string;
  by: string;
  at: string;
}

interface WorkspaceFile {
  kind: 'worksync-workspace';
  id: string;
  name: string;
  format: number;
  creator: MemberRec;
  createdAt: string;
  sig: string;
}

/** One change of one row (doc 08, 3.4). */
export interface Change {
  /** Table. */
  t: string;
  id: string;
  /** Fields and their values; absent for a removal. */
  f?: Row;
  del?: true;
  /** Hybrid clock of the change. */
  c: string;
}

interface Ctx {
  ws: Row;
  file: WorkspaceFile;
  keys: Record<string, string>;
  members: Map<string, MemberRec>;
  /** PCs removed, by PC id: when, and whether it took effect. */
  removals: Map<string, { at: string; by: string; effective: boolean }>;
  problems: string[];
}

class Pending extends Error {}

const DAY = 24 * 60 * 60 * 1000;

/** Folder work with a time limit, and a few retries when antivirus holds a file. */
async function limited<T>(p: () => Promise<T>, ms: number): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await Promise.race([
        p(),
        new Promise<never>((_, no) =>
          setTimeout(
            () => no(new Error('The workspace folder did not answer in time.')),
            ms,
          ),
        ),
      ]);
    } catch (e) {
      last = e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') throw e;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
  throw last;
}

/**
 * Shared workspaces (doc 08): a folder on the shared drive where each PC
 * writes only its own files, encrypted and signed; WorkSync syncs shared
 * projects through it.
 */
export class Workspaces {
  private hlc: Hlc | null = null;
  private ctxs = new Map<string, Ctx>();
  private status = new Map<
    string,
    {
      online: boolean;
      problem: string | null;
      waiting: number;
      update: WorkspaceInfo['update'];
    }
  >();
  private lastPresence = 0;
  /**
   * For each shared project, the database's change count when its rows were
   * last known to match what was sent; while the count stays there, nothing
   * needs comparing.
   */
  private cleanAt = new Map<string, number>();
  private quietDepth = 0;
  /** Changes made here and not sent yet, while changes that came in are applied. */
  private unsent: Map<string, unknown> | null = null;
  /** When each project's snapshots and old change files were last looked at. */
  private keptAt = new Map<string, number>();
  /** When each workspace last synced (written to the database now and then). */
  private syncedAt = new Map<string, { at: string; saved: number }>();
  /** When you last edited a shared field here, by table:id:field. */
  private editedHere = new Map<string, number>();
  viewing = '';

  constructor(
    private db: DatabaseSync,
    private d: WorkspaceDeps,
  ) {}

  private totalChanges(): number {
    return Number(
      (this.db.prepare('SELECT total_changes() AS n').get() as Row).n,
    );
  }
  /**
   * Runs the workspace's own bookkeeping writes (cursors, notices, changes
   * that came in): projects that had nothing to compare before still have
   * nothing to compare after.
   */
  private quiet<T>(fn: () => T): T {
    if (this.quietDepth) return fn();
    const before = this.totalChanges();
    this.quietDepth++;
    try {
      return fn();
    } finally {
      this.quietDepth--;
      const after = this.totalChanges();
      if (after !== before)
        for (const [p, n] of this.cleanAt)
          if (n === before) this.cleanAt.set(p, after);
    }
  }
  private now() {
    return this.d.now ? this.d.now() : new Date();
  }
  private iso() {
    return this.now().toISOString();
  }
  private get limit() {
    return this.d.limit ?? 8000;
  }

  // ------------------------------------------------------------ files

  private async read(file: string): Promise<string | null> {
    try {
      return await limited(() => fsp.readFile(file, 'utf8'), this.limit);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  /** Whether a file is there, without reading it (attachments can be large). */
  private async exists(file: string): Promise<boolean> {
    try {
      await limited(() => fsp.stat(file), this.limit);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }
  }
  /** Written under a temporary name, then renamed, so nobody reads half a file. */
  private async write(file: string, text: string): Promise<void> {
    await limited(
      () => fsp.mkdir(path.dirname(file), { recursive: true }),
      this.limit,
    );
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await limited(() => fsp.writeFile(tmp, text), this.limit);
      await limited(() => fsp.rename(tmp, file), this.limit);
    } catch (e) {
      void fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }
  private async ls(dir: string): Promise<string[]> {
    try {
      return (await limited(() => fsp.readdir(dir), this.limit)).filter(
        (f) => !f.endsWith('.tmp'),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  // ------------------------------------------------------------ this PC

  /** This PC's keys, made the first time a workspace is used, kept protected. */
  pcKeys(): PcKeys {
    const r = this.db
      .prepare("SELECT value FROM settings WHERE key = 'wsPcKeys'")
      .get() as Row | undefined;
    if (r) {
      try {
        return JSON.parse(
          this.d.protector.open(JSON.parse(str(r.value))),
        ) as PcKeys;
      } catch {
        throw new Error(
          'This PC’s workspace key cannot be opened under this Windows account. Join the workspace again from this PC.',
        );
      }
    }
    const k = makePcKeys();
    this.db
      .prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('wsPcKeys', ?)",
      )
      .run(JSON.stringify(this.d.protector.seal(JSON.stringify(k))));
    return k;
  }

  private clock(): Hlc {
    if (!this.hlc) {
      this.hlc = new Hlc(this.pcKeys().pcId, () => this.now().getTime());
      const r = this.db
        .prepare("SELECT value FROM settings WHERE key = 'wsClock'")
        .get() as Row | undefined;
      if (r) this.hlc.see(JSON.parse(str(r.value)));
    }
    return this.hlc;
  }
  private tick(): string {
    const c = this.clock().next();
    this.quiet(() =>
      this.db
        .prepare(
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('wsClock', ?)",
        )
        .run(JSON.stringify(c)),
    );
    return c;
  }

  private myRec(): MemberRec {
    const k = this.pcKeys();
    return {
      pcId: k.pcId,
      memberId: this.d.myMemberId(),
      name: this.d.myName(),
      account: this.d.account(),
      pc: this.d.pcName(),
      signPub: k.signPub,
      boxPub: k.boxPub,
      approvedBy: k.pcId,
      at: this.iso(),
    };
  }

  // ------------------------------------------------------------ local rows

  private rows(): Row[] {
    return this.db
      .prepare('SELECT * FROM workspaces ORDER BY joined_at')
      .all() as Row[];
  }
  private row(id: string): Row {
    const r = this.db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(id) as Row | undefined;
    if (!r) throw new Error('That workspace is not on this PC.');
    return r;
  }
  private keysOf(ws: Row): Record<string, string> {
    const o = JSON.parse(str(ws.keys) || '{}') as Record<string, string>;
    const out: Record<string, string> = {};
    for (const [e, v] of Object.entries(o)) out[e] = this.d.protector.open(v);
    return out;
  }
  private saveKeys(id: string, keys: Record<string, string>) {
    const o: Record<string, string> = {};
    for (const [e, v] of Object.entries(keys)) o[e] = this.d.protector.seal(v);
    this.quiet(() =>
      this.db
        .prepare('UPDATE workspaces SET keys = ? WHERE id = ?')
        .run(JSON.stringify(o), id),
    );
  }
  private currentEpoch(keys: Record<string, string>): number {
    return Math.max(0, ...Object.keys(keys).map(Number));
  }

  // ------------------------------------------------------------ notices

  private notice(
    workspaceId: string,
    kind: NoticeKind,
    text: string,
    projectId: string | null = null,
    itemId: string | null = null,
  ): void {
    this.quiet(() =>
      this.db
        .prepare(
          'INSERT INTO ws_notices (id, workspace_id, project_id, item_id, at, kind, text) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          randomUUID(),
          workspaceId,
          projectId,
          itemId,
          this.iso(),
          kind,
          text,
        ),
    );
  }

  notices(limit = 100): Notice[] {
    return (
      this.db
        .prepare('SELECT * FROM ws_notices ORDER BY at DESC LIMIT ?')
        .all(limit) as Row[]
    ).map((r) => ({
      id: str(r.id),
      workspaceId: str(r.workspace_id),
      projectId: r.project_id == null ? null : str(r.project_id),
      itemId: r.item_id == null ? null : str(r.item_id),
      at: str(r.at),
      kind: str(r.kind) as NoticeKind,
      text: str(r.text),
      read: Number(r.read) === 1,
    }));
  }

  markNoticesRead(ids?: string[]): void {
    if (!ids) this.db.prepare('UPDATE ws_notices SET read = 1').run();
    else
      for (const id of ids)
        this.db.prepare('UPDATE ws_notices SET read = 1 WHERE id = ?').run(id);
  }

  /** Notices since this time, for Windows notifications. */
  noticesSince(at: string): Notice[] {
    return this.notices(200).filter((n) => n.at > at && !n.read);
  }

  // ------------------------------------------------------------ the folder

  private async readWorkspaceFile(folder: string): Promise<WorkspaceFile> {
    const text = await this.read(path.join(folder, 'workspace.wsw'));
    if (!text)
      throw new Error(
        'This folder is not a WorkSync workspace. Choose the folder that has workspace.wsw in it.',
      );
    let f: WorkspaceFile;
    try {
      f = JSON.parse(text) as WorkspaceFile;
    } catch {
      throw new Error('The workspace file in this folder cannot be read.');
    }
    const body = JSON.stringify({ ...f, sig: undefined });
    if (
      f.kind !== 'worksync-workspace' ||
      pcIdOf(f.creator.signPub, f.creator.boxPub) !== f.creator.pcId ||
      !verifyText(f.creator.signPub, body, f.sig)
    )
      throw new Error(
        'The workspace file in this folder was changed by someone. Ask a member to recreate the workspace folder.',
      );
    return f;
  }

  /** Reads what the folder says about members, keys and removals. */
  private async load(ws: Row): Promise<Ctx> {
    const folder = str(ws.folder);
    const me = this.pcKeys();
    try {
      await limited(() => fsp.access(folder), this.limit);
    } catch {
      throw new Error(
        'The workspace folder cannot be reached. Your changes wait on this PC until it is back.',
      );
    }
    const file = await this.readWorkspaceFile(folder);
    const keys = this.keysOf(ws);
    let newKey = false;
    // My locked keys: new ones after a member is removed.
    for (const f of await this.ls(path.join(folder, 'keys'))) {
      const m = /^([0-9a-f]{16})\.(\d+)\.wsk$/.exec(f);
      if (!m || m[1] !== me.pcId || keys[m[2]]) continue;
      const text = await this.read(path.join(folder, 'keys', f));
      if (!text) continue;
      try {
        keys[m[2]] = unlockKey(text, me);
        newKey = true;
      } catch {
        // Not for this PC's key.
      }
    }
    if (newKey) this.saveKeys(str(ws.id), keys);
    const problems: string[] = [];
    const members = new Map<string, MemberRec>([
      [file.creator.pcId, file.creator],
    ]);
    const texts = new Map<string, string>();
    for (const f of await this.ls(path.join(folder, 'members'))) {
      const m = /^([0-9a-f]{16})\.wsm$/.exec(f);
      if (!m) continue;
      const t = await this.read(path.join(folder, 'members', f));
      if (t) texts.set(m[1], t);
    }
    // Trust grows from the creator: a member file counts when an earlier member signed it.
    let grew = true;
    while (grew) {
      grew = false;
      for (const [pcId, t] of texts) {
        if (members.has(pcId)) continue;
        try {
          const o = open<MemberRec>(
            t,
            'member',
            (e) => keys[e] ?? null,
            (pc) => members.get(pc)?.signPub ?? null,
          );
          if (
            o.data.pcId !== pcId ||
            pcIdOf(o.data.signPub, o.data.boxPub) !== pcId
          )
            continue;
          members.set(pcId, o.data);
          grew = true;
        } catch {
          // Not yet: its signer may come later in this loop.
        }
      }
    }
    for (const pcId of texts.keys())
      if (!members.has(pcId)) problems.push(`members/${pcId}.wsm`);
    // Removals take effect once a second member saw them, or after 24 hours.
    const removals = new Map<
      string,
      { at: string; by: string; effective: boolean }
    >();
    const acks = new Map<string, Set<string>>();
    for (const f of await this.ls(path.join(folder, 'acks'))) {
      const m = /^([0-9a-f]{16})\.([0-9a-f]{16})\.wsa$/.exec(f);
      if (!m) continue;
      const t = await this.read(path.join(folder, 'acks', f));
      if (!t) continue;
      try {
        // Signed but not encrypted, so a removed PC can see that its removal took effect.
        const o = JSON.parse(t) as {
          target: string;
          by: string;
          at: string;
          sig: string;
        };
        const signer = members.get(o.by)?.signPub;
        if (
          o.target !== m[1] ||
          o.by !== m[2] ||
          !signer ||
          !verifyText(signer, JSON.stringify({ ...o, sig: undefined }), o.sig)
        )
          throw new UnreadableFile('bad ack');
        if (!acks.has(m[1])) acks.set(m[1], new Set());
        acks.get(m[1])!.add(o.by);
      } catch {
        problems.push(`acks/${f}`);
      }
    }
    for (const f of await this.ls(path.join(folder, 'removals'))) {
      const m = /^([0-9a-f]{16})\.([0-9a-f]{16})\.wsx$/.exec(f);
      if (!m) continue;
      const t = await this.read(path.join(folder, 'removals', f));
      if (!t) continue;
      try {
        const o = open<Removal>(
          t,
          'removal',
          (e) => keys[e] ?? null,
          (pc) => members.get(pc)?.signPub ?? null,
        );
        if (o.data.target !== m[1] || o.pc !== m[2]) continue;
        const by = members.get(o.pc);
        const ackers = [...(acks.get(m[1]) ?? [])].map(
          (pc) => members.get(pc)?.memberId,
        );
        const self = m[1] === m[2];
        const effective =
          self ||
          ackers.some((x) => x && x !== by?.memberId) ||
          this.now().getTime() - Date.parse(o.data.at) > DAY;
        const prev = removals.get(m[1]);
        if (!prev || (effective && !prev.effective) || o.data.at < prev.at)
          removals.set(m[1], { at: o.data.at, by: o.pc, effective });
      } catch {
        problems.push(`removals/${f}`);
      }
    }
    // A PC that a removed PC let in afterwards is not trusted: only PCs this
    // PC already knew, or that a member still in the workspace let in.
    const known = this.knownPcs(str(ws.id));
    if (known) {
      let dropped = true;
      while (dropped) {
        dropped = false;
        for (const m of members.values()) {
          if (m.pcId === file.creator.pcId || known.has(m.pcId)) continue;
          if (
            !members.has(m.approvedBy) ||
            removals.get(m.approvedBy)?.effective
          ) {
            members.delete(m.pcId);
            problems.push(`members/${m.pcId}.wsm`);
            dropped = true;
          }
        }
      }
    }
    const ctx: Ctx = { ws, file, keys, members, removals, problems };
    this.ctxs.set(str(ws.id), ctx);
    this.rememberMembers(ctx);
    return ctx;
  }

  private knownPcs(workspaceId: string): Set<string> | null {
    const r = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(`wsKnown:${workspaceId}`) as Row | undefined;
    return r ? new Set(JSON.parse(str(r.value)) as string[]) : null;
  }

  /** The members as last read from the folder, kept for when it cannot be reached. */
  private rememberMembers(ctx: Ctx): void {
    const key = `wsMembers:${str(ctx.ws.id)}`;
    const list = this.memberList(ctx);
    const text = JSON.stringify(list);
    const r = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as Row | undefined;
    if (r && str(r.value) === text) return;
    this.quiet(() =>
      this.db
        .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .run(key, text),
    );
  }

  /** The members still in the workspace, one entry each. */
  private memberList(ctx: Ctx): Member[] {
    const me = this.pcKeys().pcId;
    const out = new Map<string, Member>();
    for (const m of ctx.members.values()) {
      if (
        m.memberId.startsWith('recovery-') ||
        ctx.removals.get(m.pcId)?.effective
      )
        continue;
      const x = out.get(m.memberId);
      if (x) {
        if (m.pcId === me) x.me = true;
        continue;
      }
      out.set(m.memberId, {
        id: m.memberId,
        name: m.name,
        tag: tagOf(m.memberId),
        account: m.account,
        pc: m.pc,
        color: colorOf(m.memberId),
        me: m.pcId === me,
      });
    }
    return [...out.values()];
  }

  private signer(ctx: Ctx) {
    return (pc: string) => ctx.members.get(pc)?.signPub ?? null;
  }
  private keyOf(ctx: Ctx) {
    return (e: number) => ctx.keys[String(e)] ?? null;
  }
  private sealFor(ctx: Ctx, kind: string, data: unknown): string {
    const epoch = this.currentEpoch(ctx.keys);
    return seal(this.pcKeys(), ctx.keys[String(epoch)], epoch, kind, data);
  }
  private readOnly(ctx: Ctx) {
    return ctx.file.format > WORKSPACE_FORMAT;
  }

  // ------------------------------------------------------------ create and join

  /** Creates a workspace in an empty folder on the shared drive (doc 08, 4.1). */
  async create(folder: string, name: string): Promise<WorkspaceInfo> {
    const n = name.trim();
    if (!n) throw new Error('Give the workspace a name.');
    if (await this.read(path.join(folder, 'workspace.wsw')))
      throw new Error(
        'This folder already is a workspace. Choose Join a workspace instead.',
      );
    const me = this.pcKeys();
    const id = randomUUID();
    const creator = this.myRec();
    const body: Omit<WorkspaceFile, 'sig'> & { sig?: string } = {
      kind: 'worksync-workspace',
      id,
      name: n,
      format: WORKSPACE_FORMAT,
      creator,
      createdAt: this.iso(),
    };
    const sig = signText(me, JSON.stringify({ ...body, sig: undefined }));
    const epoch = this.now().getTime();
    const key = newWorkspaceKey();
    await this.write(
      path.join(folder, 'workspace.wsw'),
      JSON.stringify({ ...body, sig }),
    );
    await this.write(
      path.join(folder, 'members', `${me.pcId}.wsm`),
      seal(me, key, epoch, 'member', creator),
    );
    await this.write(
      path.join(folder, 'keys', `${me.pcId}.${epoch}.wsk`),
      lockKeyFor(key, me),
    );
    this.db
      .prepare(
        "INSERT INTO workspaces (id, name, folder, pc_id, state, joined_at) VALUES (?, ?, ?, ?, 'member', ?)",
      )
      .run(id, n, folder, me.pcId, this.iso());
    this.saveKeys(id, { [epoch]: key });
    return (await this.info(id))!;
  }

  /** Asks to join: writes a request with this PC's public keys and shows a code (doc 08, 3.5). */
  async requestJoin(folder: string): Promise<WorkspaceInfo> {
    const file = await this.readWorkspaceFile(folder);
    const existing = this.db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(file.id) as Row | undefined;
    if (existing && str(existing.state) === 'member')
      throw new Error('This PC is already in that workspace.');
    const me = this.pcKeys();
    const rec = this.myRec();
    const req: Omit<RequestRec, 'sig'> = {
      kind: 'join',
      workspaceId: file.id,
      pcId: me.pcId,
      memberId: rec.memberId,
      name: rec.name,
      account: rec.account,
      pc: rec.pc,
      signPub: me.signPub,
      boxPub: me.boxPub,
      at: this.iso(),
    };
    const sig = signText(me, JSON.stringify(req));
    await this.write(
      path.join(folder, 'requests', `${me.pcId}.wsr`),
      JSON.stringify({ ...req, sig }),
    );
    this.db
      .prepare(
        "INSERT OR REPLACE INTO workspaces (id, name, folder, pc_id, state, keys, joined_at) VALUES (?, ?, ?, ?, 'pending', '{}', ?)",
      )
      .run(file.id, file.name, folder, me.pcId, this.iso());
    return (await this.info(file.id))!;
  }

  /** Join requests waiting in the member workspaces (doc 08, 3.5). */
  async requests(): Promise<JoinRequest[]> {
    const out: JoinRequest[] = [];
    for (const ws of this.rows().filter((w) => str(w.state) === 'member')) {
      let ctx: Ctx;
      try {
        ctx = this.ctxs.get(str(ws.id)) ?? (await this.load(ws));
      } catch {
        continue;
      }
      const folder = str(ws.folder);
      const declined = new Set(
        (await this.ls(path.join(folder, 'declines'))).map(
          (f) => f.split('.')[0],
        ),
      );
      for (const f of await this.ls(path.join(folder, 'requests'))) {
        const t = await this.read(path.join(folder, 'requests', f));
        if (!t) continue;
        let r: RequestRec;
        try {
          r = JSON.parse(t) as RequestRec;
        } catch {
          continue;
        }
        const body = JSON.stringify({ ...r, sig: undefined });
        if (
          r.kind !== 'join' ||
          r.workspaceId !== str(ws.id) ||
          pcIdOf(r.signPub, r.boxPub) !== r.pcId ||
          !verifyText(r.signPub, body, r.sig)
        )
          continue;
        if (ctx.members.has(r.pcId) || declined.has(r.pcId)) continue;
        if (this.now().getTime() - Date.parse(r.at) > 7 * DAY) continue;
        const looks = [...ctx.members.values()].filter(
          (m) =>
            !ctx.removals.get(m.pcId)?.effective &&
            ((m.account &&
              m.account.toLowerCase() === r.account.toLowerCase()) ||
              m.name.toLowerCase() === r.name.toLowerCase()),
        );
        out.push({
          workspaceId: str(ws.id),
          pcId: r.pcId,
          name: r.name,
          account: r.account,
          pc: r.pc,
          code: joinCode(r),
          at: r.at,
          looksLike: [
            ...new Map(looks.map((m) => [m.memberId, m])).values(),
          ].map((m) => ({
            memberId: m.memberId,
            name: m.name,
            account: m.account,
          })),
        });
      }
    }
    return out;
  }

  /**
   * Lets a PC in after the person checked the code: its member file, signed
   * by this PC, and the workspace key locked for it.
   */
  async approve(
    workspaceId: string,
    pcId: string,
    asMember?: string,
    signer?: PcKeys,
  ): Promise<void> {
    const ws = this.row(workspaceId);
    const ctx = await this.load(ws);
    if (this.readOnly(ctx))
      throw new Error(
        'This workspace needs a newer WorkSync. Update from the workspace folder first.',
      );
    const folder = str(ws.folder);
    const t = await this.read(path.join(folder, 'requests', `${pcId}.wsr`));
    if (!t) throw new Error('That join request is no longer there.');
    const r = JSON.parse(t) as RequestRec;
    if (
      pcIdOf(r.signPub, r.boxPub) !== pcId ||
      !verifyText(r.signPub, JSON.stringify({ ...r, sig: undefined }), r.sig)
    )
      throw new Error(
        'That join request was changed by someone. Ask the person to ask again.',
      );
    const by = signer ?? this.pcKeys();
    const rec: MemberRec = {
      pcId,
      memberId: asMember || r.memberId,
      name: r.name,
      account: r.account,
      pc: r.pc,
      signPub: r.signPub,
      boxPub: r.boxPub,
      approvedBy: by.pcId,
      at: this.iso(),
    };
    const epoch = this.currentEpoch(ctx.keys);
    await this.write(
      path.join(folder, 'members', `${pcId}.wsm`),
      seal(by, ctx.keys[String(epoch)], epoch, 'member', rec),
    );
    for (const [e, key] of Object.entries(ctx.keys))
      await this.write(
        path.join(folder, 'keys', `${pcId}.${e}.wsk`),
        lockKeyFor(key, r),
      );
    this.notice(
      workspaceId,
      'member',
      `You let ${r.name} (${r.account} · ${r.pc}) in.`,
    );
    await this.load(ws);
  }

  async decline(workspaceId: string, pcId: string): Promise<void> {
    const ws = this.row(workspaceId);
    const me = this.pcKeys();
    const body = { pcId, by: me.pcId, at: this.iso() };
    await this.write(
      path.join(str(ws.folder), 'declines', `${pcId}.${me.pcId}.wsd`),
      JSON.stringify({ ...body, sig: signText(me, JSON.stringify(body)) }),
    );
  }

  /** While waiting to be let in: checks whether a member let this PC in, or declined. */
  private async checkPending(ws: Row): Promise<boolean> {
    const folder = str(ws.folder);
    const me = this.pcKeys();
    const keys: Record<string, string> = {};
    for (const f of await this.ls(path.join(folder, 'keys'))) {
      const m = /^([0-9a-f]{16})\.(\d+)\.wsk$/.exec(f);
      if (!m || m[1] !== me.pcId) continue;
      const text = await this.read(path.join(folder, 'keys', f));
      if (!text) continue;
      try {
        keys[m[2]] = unlockKey(text, me);
      } catch {
        // not mine
      }
    }
    if (!Object.keys(keys).length) {
      const declined = (await this.ls(path.join(folder, 'declines'))).some(
        (f) => f.startsWith(`${me.pcId}.`),
      );
      if (declined)
        this.db
          .prepare("UPDATE workspaces SET state = 'declined' WHERE id = ?")
          .run(str(ws.id));
      return false;
    }
    this.saveKeys(str(ws.id), keys);
    const ctx = await this.load({ ...ws, keys: this.row(str(ws.id)).keys });
    const mine = ctx.members.get(me.pcId);
    if (!mine) return false;
    const old = this.d.myMemberId();
    if (mine.memberId !== old) {
      // Let in as the same member as before: tasks assigned to this PC's old id are yours still.
      this.d.setMyMemberId(mine.memberId);
      this.db
        .prepare('UPDATE project_tasks SET assignee = ? WHERE assignee = ?')
        .run(mine.memberId, old);
    }
    this.db
      .prepare("UPDATE workspaces SET state = 'member' WHERE id = ?")
      .run(str(ws.id));
    try {
      await fsp.rm(path.join(folder, 'requests', `${me.pcId}.wsr`), {
        force: true,
      });
    } catch {
      // Left for later.
    }
    this.notice(
      str(ws.id),
      'join',
      `You are in the workspace ${str(ws.name)}.`,
    );
    return true;
  }

  /** Cancels a request, or forgets a declined one. */
  forget(workspaceId: string): void {
    const ws = this.row(workspaceId);
    if (str(ws.state) === 'member')
      throw new Error('Leave the workspace instead.');
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
    void fsp
      .rm(path.join(str(ws.folder), 'requests', `${this.pcKeys().pcId}.wsr`), {
        force: true,
      })
      .catch(() => undefined);
  }

  // ------------------------------------------------------------ members

  /** The members of a workspace, each with their PCs (doc 08, 3.5). */
  async members(workspaceId: string): Promise<WsMember[]> {
    const ws = this.row(workspaceId);
    const ctx = this.ctxs.get(workspaceId) ?? (await this.load(ws));
    const presence = await this.presence(ctx);
    const me = this.pcKeys().pcId;
    const by = new Map<string, WsMember>();
    for (const m of ctx.members.values()) {
      if (m.memberId.startsWith('recovery-')) continue;
      const rem = ctx.removals.get(m.pcId);
      const p = presence.get(m.pcId);
      const pc = {
        pcId: m.pcId,
        pc: m.pc,
        account: m.account,
        approvedBy: ctx.members.get(m.approvedBy)?.name ?? '',
        at: m.at,
        removed: (rem ? (rem.effective ? 'yes' : 'pending') : 'no') as
          | 'yes'
          | 'pending'
          | 'no',
        online: !!p && this.now().getTime() - Date.parse(p.at) < 45_000,
        viewing: p?.viewing ?? '',
        lastSeen: p?.at ?? null,
      };
      const x = by.get(m.memberId);
      if (x) {
        x.pcs.push(pc);
        if (m.at > (x.pcs[0]?.at ?? '')) x.name = m.name;
        if (m.pcId === me) x.me = true;
      } else
        by.set(m.memberId, {
          memberId: m.memberId,
          name: m.name,
          tag: tagOf(m.memberId),
          color: colorOf(m.memberId),
          me: m.pcId === me,
          pcs: [pc],
          removed: false,
        });
    }
    for (const x of by.values())
      x.removed = x.pcs.every((p) => p.removed === 'yes');
    return [...by.values()];
  }

  /** Who a shared project's tasks can be assigned to; null when the project is local. */
  membersForProject(projectId: string): Member[] | null {
    const r = this.db
      .prepare('SELECT workspace_id FROM ws_projects WHERE project_id = ?')
      .get(projectId) as Row | undefined;
    if (!r) return null;
    const ctx = this.ctxs.get(str(r.workspace_id));
    let list: Member[] = [];
    if (ctx) list = this.memberList(ctx);
    else {
      // The folder was not read yet (offline since WorkSync started): the members as last seen.
      const saved = this.db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get(`wsMembers:${str(r.workspace_id)}`) as Row | undefined;
      try {
        if (saved) list = JSON.parse(str(saved.value)) as Member[];
      } catch {
        list = [];
      }
    }
    // Your own member even before the folder was ever read.
    const mine = this.d.myMemberId();
    if (!list.some((m) => m.id === mine))
      list.push({
        id: mine,
        name: this.d.myName(),
        tag: tagOf(mine),
        account: this.d.account(),
        pc: this.d.pcName(),
        color: colorOf(mine),
        me: true,
      });
    return list;
  }

  /** The member name a PC writes as, for notices and history. */
  private nameOf(ctx: Ctx, pcId: string): string {
    const m = ctx.members.get(pcId);
    return m ? `${m.name} ·${tagOf(m.memberId)}` : 'Someone';
  }

  /**
   * Removes one PC, or every PC of a member (doc 08, 3.5). Their later
   * changes are refused, and a new workspace key is made for everyone else.
   */
  async remove(
    workspaceId: string,
    o: { pcId?: string; memberId?: string },
  ): Promise<void> {
    const ws = this.row(workspaceId);
    const ctx = await this.load(ws);
    const me = this.pcKeys();
    const targets = [...ctx.members.values()]
      .filter((m) => (o.pcId ? m.pcId === o.pcId : m.memberId === o.memberId))
      .map((m) => m.pcId);
    if (!targets.length)
      throw new Error('That member is not in the workspace.');
    if (targets.includes(me.pcId))
      throw new Error('To take this PC out, choose Leave the workspace.');
    const folder = str(ws.folder);
    for (const t of targets)
      await this.write(
        path.join(folder, 'removals', `${t}.${me.pcId}.wsx`),
        this.sealFor(ctx, 'removal', {
          target: t,
          by: me.pcId,
          at: this.iso(),
        }),
      );
    await this.rotate(ctx, new Set(targets));
    const names = [
      ...new Set(targets.map((t) => ctx.members.get(t)?.name ?? '')),
    ].join(', ');
    this.notice(
      workspaceId,
      'removed',
      `You removed ${names}. Every member is told.`,
    );
    await this.load(this.row(workspaceId));
  }

  /** A new workspace key, locked for every PC still in. */
  private async rotate(ctx: Ctx, without: Set<string>): Promise<void> {
    const epoch = Math.max(
      this.now().getTime(),
      this.currentEpoch(ctx.keys) + 1,
    );
    const key = newWorkspaceKey();
    const folder = str(ctx.ws.folder);
    for (const m of ctx.members.values()) {
      if (without.has(m.pcId) || ctx.removals.get(m.pcId)?.effective) continue;
      await this.write(
        path.join(folder, 'keys', `${m.pcId}.${epoch}.wsk`),
        lockKeyFor(key, m),
      );
    }
    ctx.keys[String(epoch)] = key;
    this.saveKeys(str(ctx.ws.id), ctx.keys);
  }

  /** Leaves a workspace: shared projects stay here as local copies, no longer synced. */
  async leave(workspaceId: string): Promise<void> {
    const ws = this.row(workspaceId);
    const me = this.pcKeys();
    try {
      const ctx = await this.load(ws);
      await this.write(
        path.join(str(ws.folder), 'removals', `${me.pcId}.${me.pcId}.wsx`),
        this.sealFor(ctx, 'removal', {
          target: me.pcId,
          by: me.pcId,
          at: this.iso(),
        }),
      );
    } catch {
      // Offline: the others see it when the folder can be reached by someone.
    }
    this.dropLocal(workspaceId);
  }

  private dropLocal(workspaceId: string) {
    const projects = this.db
      .prepare('SELECT project_id FROM ws_projects WHERE workspace_id = ?')
      .all(workspaceId) as Row[];
    for (const p of projects) {
      this.db
        .prepare('DELETE FROM ws_rows WHERE project_id = ?')
        .run(str(p.project_id));
      this.db
        .prepare('DELETE FROM ws_pending WHERE project_id = ?')
        .run(str(p.project_id));
    }
    this.db
      .prepare('DELETE FROM ws_projects WHERE workspace_id = ?')
      .run(workspaceId);
    this.db
      .prepare('DELETE FROM ws_cursors WHERE workspace_id = ?')
      .run(workspaceId);
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
    this.ctxs.delete(workspaceId);
  }

  setOffline(workspaceId: string, offline: boolean): void {
    this.row(workspaceId);
    this.db
      .prepare('UPDATE workspaces SET offline = ? WHERE id = ?')
      .run(offline ? 1 : 0, workspaceId);
  }

  // ------------------------------------------------------------ recovery file

  /** A file that can let a new PC in on its own, locked with a password (doc 08, 3.5). */
  async recoveryFile(workspaceId: string, password: string): Promise<string> {
    if (password.length < 8)
      throw new Error('Choose a password of at least 8 characters.');
    const ws = this.row(workspaceId);
    const ctx = await this.load(ws);
    const keys = makePcKeys();
    const me = this.pcKeys();
    const rec: MemberRec = {
      pcId: keys.pcId,
      memberId: `recovery-${workspaceId}`,
      name: 'Recovery file',
      account: '',
      pc: '',
      signPub: keys.signPub,
      boxPub: keys.boxPub,
      approvedBy: me.pcId,
      at: this.iso(),
    };
    const folder = str(ws.folder);
    await this.write(
      path.join(folder, 'members', `${keys.pcId}.wsm`),
      this.sealFor(ctx, 'member', rec),
    );
    for (const [e, key] of Object.entries(ctx.keys))
      await this.write(
        path.join(folder, 'keys', `${keys.pcId}.${e}.wsk`),
        lockKeyFor(key, keys),
      );
    return lockWithPassword(password, {
      workspaceId,
      name: str(ws.name),
      keys,
    });
  }

  /** Joins with a recovery file: the file lets this PC's request in by itself. */
  async joinWithRecovery(
    folder: string,
    fileText: string,
    password: string,
  ): Promise<WorkspaceInfo> {
    const r = openWithPassword<{ workspaceId: string; keys: PcKeys }>(
      password,
      fileText,
    );
    const file = await this.readWorkspaceFile(folder);
    if (file.id !== r.workspaceId)
      throw new Error('This recovery file is for another workspace.');
    await this.requestJoin(folder);
    // Act as the recovery member just long enough to approve this PC.
    const recWs = {
      id: file.id,
      name: file.name,
      folder,
      pc_id: r.keys.pcId,
      state: 'member',
      keys: '{}',
    } as Row;
    const keys: Record<string, string> = {};
    for (const f of await this.ls(path.join(folder, 'keys'))) {
      const m = /^([0-9a-f]{16})\.(\d+)\.wsk$/.exec(f);
      if (!m || m[1] !== r.keys.pcId) continue;
      const text = await this.read(path.join(folder, 'keys', f));
      if (text) keys[m[2]] = unlockKey(text, r.keys);
    }
    if (!Object.keys(keys).length)
      throw new Error('This recovery file was taken out of the workspace.');
    const sealed: Record<string, string> = {};
    for (const [e, v] of Object.entries(keys))
      sealed[e] = this.d.protector.seal(v);
    recWs.keys = JSON.stringify(sealed);
    const ctx = await this.load(recWs);
    const me = this.pcKeys();
    const t = await this.read(path.join(folder, 'requests', `${me.pcId}.wsr`));
    const req = JSON.parse(t!) as RequestRec;
    const rec: MemberRec = {
      pcId: me.pcId,
      memberId: req.memberId,
      name: req.name,
      account: req.account,
      pc: req.pc,
      signPub: req.signPub,
      boxPub: req.boxPub,
      approvedBy: r.keys.pcId,
      at: this.iso(),
    };
    const epoch = this.currentEpoch(ctx.keys);
    await this.write(
      path.join(folder, 'members', `${me.pcId}.wsm`),
      seal(r.keys, ctx.keys[String(epoch)], epoch, 'member', rec),
    );
    for (const [e, key] of Object.entries(ctx.keys))
      await this.write(
        path.join(folder, 'keys', `${me.pcId}.${e}.wsk`),
        lockKeyFor(key, me),
      );
    this.ctxs.delete(file.id);
    await this.checkPending(this.row(file.id));
    return (await this.info(file.id))!;
  }

  // ------------------------------------------------------------ sharing

  /** Shares a local project in a workspace; every member sees it (doc 08, 3.6). */
  async share(workspaceId: string, projectId: string): Promise<void> {
    const ws = this.row(workspaceId);
    if (str(ws.state) !== 'member')
      throw new Error('You are not a member of that workspace yet.');
    const ctx = await this.load(ws);
    if (this.readOnly(ctx))
      throw new Error(
        'This workspace needs a newer WorkSync. Update from the workspace folder first.',
      );
    const p = this.db
      .prepare('SELECT id, name FROM projects WHERE id = ?')
      .get(projectId) as Row | undefined;
    if (!p) throw new Error('That project no longer exists.');
    if (
      this.db
        .prepare('SELECT 1 FROM ws_projects WHERE project_id = ?')
        .get(projectId)
    )
      throw new Error('That project is already shared.');
    await this.write(
      path.join(str(ws.folder), 'projects', projectId, 'info.wsi'),
      this.sealFor(ctx, 'project', {
        id: projectId,
        name: str(p.name),
        sharedBy: this.d.myMemberId(),
        at: this.iso(),
      }),
    );
    this.db
      .prepare(
        'INSERT INTO ws_projects (project_id, workspace_id, shared_at) VALUES (?, ?, ?)',
      )
      .run(projectId, workspaceId, this.iso());
    await this.syncWorkspace(workspaceId);
  }

  /** The workspace a project is shared in, if any. */
  workspaceOf(projectId: string): string | null {
    const r = this.db
      .prepare('SELECT workspace_id FROM ws_projects WHERE project_id = ?')
      .get(projectId) as Row | undefined;
    return r ? str(r.workspace_id) : null;
  }

  /**
   * Before a shared project is deleted here: it stops syncing and is not
   * fetched again; the others keep it.
   */
  forgetProject(projectId: string): void {
    const ws = this.workspaceOf(projectId);
    if (!ws) return;
    this.db
      .prepare('DELETE FROM ws_projects WHERE project_id = ?')
      .run(projectId);
    this.db.prepare('DELETE FROM ws_rows WHERE project_id = ?').run(projectId);
    this.db
      .prepare('DELETE FROM ws_pending WHERE project_id = ?')
      .run(projectId);
    const key = `wsIgnored:${ws}`;
    const r = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as Row | undefined;
    const list = r ? (JSON.parse(str(r.value)) as string[]) : [];
    this.db
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(key, JSON.stringify([...new Set([...list, projectId])]));
  }

  private ignored(workspaceId: string): string[] {
    const r = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(`wsIgnored:${workspaceId}`) as Row | undefined;
    return r ? (JSON.parse(str(r.value)) as string[]) : [];
  }

  // ------------------------------------------------------------ sync

  /** What changed here since the last sync, as changes (doc 08, 3.4). */
  private localChanges(projectId: string): {
    changes: Change[];
    snap: Map<string, Row>;
  } {
    const current = sharedRows(this.db, projectId);
    const snap = new Map<string, Row>();
    for (const r of this.db
      .prepare('SELECT * FROM ws_rows WHERE project_id = ?')
      .all(projectId) as Row[])
      snap.set(`${str(r.tbl)}\n${str(r.id)}`, r);
    const changes: Change[] = [];
    for (const t of SHARED_TABLES) {
      for (const [id, row] of current.get(t.name)!) {
        const s = snap.get(`${t.name}\n${id}`);
        const before =
          s && Number(s.deleted) === 0
            ? (JSON.parse(str(s.data)) as Row)
            : null;
        const f: Row = {};
        for (const [k, v] of Object.entries(row))
          if (!before || JSON.stringify(before[k]) !== JSON.stringify(v))
            f[k] = v;
        // A new row's file goes along once; it is not kept in the comparison copy.
        if (!before && t.blob) {
          const b = this.db
            .prepare(`SELECT ${t.blob} AS b FROM ${t.name} WHERE id = ?`)
            .get(id) as Row | undefined;
          if (b) f[t.blob] = toWire(b.b);
        }
        if (Object.keys(f).length) changes.push({ t: t.name, id, f, c: '' });
      }
    }
    for (const [k, s] of snap) {
      if (Number(s.deleted) !== 0) continue;
      const [t, id] = k.split('\n');
      if (!current.get(t)?.has(id)) changes.push({ t, id, del: true, c: '' });
    }
    return { changes, snap };
  }

  /** Records what was sent, so it is not sent again. */
  private recordSent(
    projectId: string,
    changes: Change[],
    snap: Map<string, Row>,
  ) {
    const put = this.db.prepare(
      'INSERT OR REPLACE INTO ws_rows (project_id, tbl, id, data, clocks, deleted) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const ch of changes) {
      const s = snap.get(`${ch.t}\n${ch.id}`);
      const data =
        s && Number(s.deleted) === 0 ? (JSON.parse(str(s.data)) as Row) : {};
      const clocks = s
        ? (JSON.parse(str(s.clocks) || '{}') as Record<string, string>)
        : {};
      if (ch.del) {
        put.run(
          projectId,
          ch.t,
          ch.id,
          '{}',
          JSON.stringify({ ...clocks, _del: ch.c }),
          1,
        );
        continue;
      }
      for (const [k, v] of Object.entries(ch.f ?? {})) {
        if (k !== TABLE[ch.t]?.blob) data[k] = v;
        clocks[k] = ch.c;
      }
      delete clocks._del;
      put.run(
        projectId,
        ch.t,
        ch.id,
        JSON.stringify(data),
        JSON.stringify(clocks),
        0,
      );
    }
  }

  private cursor(workspaceId: string, projectId: string, pcId: string): number {
    const r = this.db
      .prepare(
        'SELECT seq FROM ws_cursors WHERE workspace_id = ? AND project_id = ? AND pc_id = ?',
      )
      .get(workspaceId, projectId, pcId) as Row | undefined;
    return r ? Number(r.seq) : 0;
  }
  private setCursor(
    workspaceId: string,
    projectId: string,
    pcId: string,
    seq: number,
  ) {
    if (this.cursor(workspaceId, projectId, pcId) === seq) return;
    this.quiet(() =>
      this.db
        .prepare(
          'INSERT OR REPLACE INTO ws_cursors (workspace_id, project_id, pc_id, seq) VALUES (?, ?, ?, ?)',
        )
        .run(workspaceId, projectId, pcId, seq),
    );
  }

  /** Changes waiting to be written, per workspace. */
  waiting(workspaceId: string): number {
    const r = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM ws_outbox WHERE project_id IN (SELECT project_id FROM ws_projects WHERE workspace_id = ?)',
      )
      .get(workspaceId) as Row;
    return Number(r.n);
  }

  /**
   * Notes the changes made here since the last look, with the time they were
   * seen, so a change made offline keeps its own time (doc 08, 3.4).
   */
  stage(projectId: string): number {
    // Nothing was written to the database since the last look: nothing to compare.
    const count = this.totalChanges();
    if (this.cleanAt.get(projectId) === count) return 0;
    const { changes, snap } = this.localChanges(projectId);
    if (!changes.length) {
      this.cleanAt.set(projectId, count);
      return 0;
    }
    for (const ch of changes) {
      ch.c = this.tick();
      // Fields you edited (not rows you only shared), for "changed what you set" notices.
      const was = snap.get(`${ch.t}\n${ch.id}`);
      if (was && Number(was.deleted) === 0)
        for (const k of Object.keys(ch.f ?? {}))
          this.editedHere.set(`${ch.t}:${ch.id}:${k}`, this.now().getTime());
    }
    const add = this.db.prepare(
      'INSERT INTO ws_outbox (project_id, change) VALUES (?, ?)',
    );
    this.db.exec('BEGIN');
    try {
      this.recordSent(projectId, changes, snap);
      for (const ch of changes) add.run(projectId, JSON.stringify(ch));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    // Compared and recorded in one go, so the rows match what is recorded now.
    this.cleanAt.set(projectId, this.totalChanges());
    return changes.length;
  }

  /** Stages the changes of every shared project. */
  stageAll(): void {
    for (const p of this.db
      .prepare('SELECT project_id FROM ws_projects')
      .all() as Row[])
      if (
        this.db
          .prepare('SELECT 1 FROM projects WHERE id = ?')
          .get(str(p.project_id))
      )
        this.stage(str(p.project_id));
  }

  private async push(ctx: Ctx, projectId: string): Promise<number> {
    this.stage(projectId);
    const rows = this.db
      .prepare(
        'SELECT n, change FROM ws_outbox WHERE project_id = ? ORDER BY n',
      )
      .all(projectId) as Row[];
    if (!rows.length) return 0;
    const changes = rows.map((r) => JSON.parse(str(r.change)) as Change);
    const me = this.pcKeys().pcId;
    const wsId = str(ctx.ws.id);
    const seq = this.cursor(wsId, projectId, me) + 1;
    const dir = path.join(str(ctx.ws.folder), 'projects', projectId, 'log', me);
    await this.write(
      path.join(dir, `${String(seq).padStart(6, '0')}.wsc`),
      this.sealFor(ctx, 'changes', { project: projectId, seq, changes }),
    );
    await this.write(
      path.join(dir, 'head.wsh'),
      this.sealFor(ctx, 'head', { project: projectId, seq }),
    );
    this.setCursor(wsId, projectId, me, seq);
    this.quiet(() =>
      this.db
        .prepare('DELETE FROM ws_outbox WHERE project_id = ? AND n <= ?')
        .run(projectId, Number(rows[rows.length - 1].n)),
    );
    return changes.length;
  }

  private async pull(
    ctx: Ctx,
    projectId: string,
  ): Promise<{ applied: number; fromOthers: Set<string> }> {
    const wsId = str(ctx.ws.id);
    const me = this.pcKeys().pcId;
    const base = path.join(str(ctx.ws.folder), 'projects', projectId, 'log');
    const incoming: { pc: string; ch: Change }[] = [];
    const cursors: [string, number][] = [];
    let fromSnapshot = 0;
    // A project not on this PC yet starts from the newest snapshot, if there is one.
    if (
      !this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId) &&
      !this.db
        .prepare(
          'SELECT 1 FROM ws_cursors WHERE workspace_id = ? AND project_id = ?',
        )
        .get(wsId, projectId)
    )
      fromSnapshot += await this.loadSnapshot(ctx, projectId, null);
    const gaps: [string, number][] = [];
    for (const pc of await this.ls(base)) {
      // This PC's own log is read too: after a restored backup, or a stop
      // right after writing, it holds changes this database has not got.
      if (!/^[0-9a-f]{16}$/.test(pc)) continue;
      const signerOk = ctx.members.has(pc);
      if (!signerOk) {
        ctx.problems.push(`projects/${projectId}/log/${pc}`);
        continue;
      }
      const headText = await this.read(path.join(base, pc, 'head.wsh'));
      if (!headText) continue;
      let head: number;
      try {
        head = open<{ seq: number }>(
          headText,
          'head',
          this.keyOf(ctx),
          this.signer(ctx),
        ).data.seq;
      } catch {
        ctx.problems.push(`projects/${projectId}/log/${pc}/head.wsh`);
        continue;
      }
      let at = this.cursor(wsId, projectId, pc);
      const removal = ctx.removals.get(pc);
      while (at < head) {
        const text = await this.read(
          path.join(base, pc, `${String(at + 1).padStart(6, '0')}.wsc`),
        );
        if (!text) {
          // Not arrived yet, or removed after a snapshot that covers it.
          gaps.push([pc, at]);
          break;
        }
        let data: { project: string; seq: number; changes: Change[] };
        try {
          data = open<{ project: string; seq: number; changes: Change[] }>(
            text,
            'changes',
            this.keyOf(ctx),
            this.signer(ctx),
          ).data;
        } catch (e) {
          if (e instanceof UnreadableFile && /no key/.test(e.message)) break; // the key comes later
          ctx.problems.push(`projects/${projectId}/log/${pc}/${at + 1}`);
          at++;
          continue;
        }
        if (data.project === projectId && data.seq === at + 1)
          for (const ch of data.changes) {
            // Changes of a removed PC after its removal are refused.
            if (
              removal?.effective &&
              Hlc.parse(ch.c).ms > Date.parse(removal.at)
            )
              continue;
            incoming.push({ pc, ch });
          }
        at++;
      }
      cursors.push([pc, at]);
    }
    const fromOthers = new Set<string>();
    const order = new Map(SHARED_TABLES.map((t, i) => [t.name, i]));
    // Waiting ones first: their parent may have come now.
    const waiting = (
      this.db
        .prepare('SELECT * FROM ws_pending WHERE project_id = ?')
        .all(projectId) as Row[]
    ).map((r) => ({
      pending: str(r.id),
      pc: str(r.pc_id),
      ch: JSON.parse(str(r.change)) as Change,
    }));
    const all = [
      ...waiting,
      ...incoming.map((x) => ({ pending: '', ...x })),
    ].sort(
      (a, b) =>
        (a.ch.del ? 1 : 0) - (b.ch.del ? 1 : 0) ||
        (a.ch.del
          ? (order.get(b.ch.t) ?? 0) - (order.get(a.ch.t) ?? 0)
          : (order.get(a.ch.t) ?? 0) - (order.get(b.ch.t) ?? 0)) ||
        a.ch.c.localeCompare(b.ch.c),
    );
    let applied = 0;
    // What was edited here while the folder was being read is noted first, so
    // a change that comes in is compared with it instead of replacing it unseen.
    if (all.length) this.stage(projectId);
    this.quiet(() =>
      this.applyAll(ctx, projectId, all, cursors, (pc) => {
        applied++;
        if (pc !== me) fromOthers.add(pc);
      }),
    );
    // Change files removed after a snapshot: the snapshot brings this PC up to date.
    if (gaps.length)
      fromSnapshot += await this.loadSnapshot(ctx, projectId, gaps);
    return { applied: applied + fromSnapshot, fromOthers };
  }

  private applyAll(
    ctx: Ctx,
    projectId: string,
    all: { pending: string; pc: string; ch: Change }[],
    cursors: [string, number][],
    onApplied: (pc: string) => void,
  ): void {
    const wsId = str(ctx.ws.id);
    const me = this.pcKeys().pcId;
    // What you changed and have not sent, to notice when someone changed the same thing.
    this.unsent = new Map();
    for (const r of this.db
      .prepare('SELECT change FROM ws_outbox WHERE project_id = ? ORDER BY n')
      .all(projectId) as Row[]) {
      const ch = JSON.parse(str(r.change)) as Change;
      for (const [k, v] of Object.entries(ch.f ?? {}))
        this.unsent.set(`${ch.t}:${ch.id}:${k}`, v);
    }
    // Tickets another member deleted go to the Trash here too, while they are whole.
    const removed: { id: string; no: string; title: string; pc: string }[] = [];
    for (const x of all) {
      if (!x.ch.del || x.ch.t !== 'tasks' || x.pc === me) continue;
      const t = this.db
        .prepare(
          'SELECT customer_id, title_translation, title_original FROM tasks WHERE id = ?',
        )
        .get(x.ch.id) as Row | undefined;
      if (!t) continue;
      this.d.onTicketRemoved?.(x.ch.id, this.nameOf(ctx, x.pc));
      removed.push({
        id: x.ch.id,
        no: str(t.customer_id),
        title: str(t.title_translation) || str(t.title_original),
        pc: x.pc,
      });
    }
    this.db.exec('BEGIN');
    try {
      for (const x of all) {
        this.clock().see(x.ch.c);
        try {
          if (this.apply(ctx, projectId, x.ch, x.pc)) onApplied(x.pc);
          if (x.pending)
            this.db
              .prepare('DELETE FROM ws_pending WHERE id = ?')
              .run(x.pending);
        } catch (e) {
          if (!(e instanceof Pending)) throw e;
          if (!x.pending)
            this.db
              .prepare(
                'INSERT INTO ws_pending (id, project_id, pc_id, change, at) VALUES (?, ?, ?, ?, ?)',
              )
              .run(
                randomUUID(),
                projectId,
                x.pc,
                JSON.stringify(x.ch),
                this.iso(),
              );
        }
      }
      for (const [pc, seq] of cursors) this.setCursor(wsId, projectId, pc, seq);
      // A change whose parent never came (it was deleted meanwhile) is given up after 30 days.
      this.db
        .prepare('DELETE FROM ws_pending WHERE project_id = ? AND at < ?')
        .run(
          projectId,
          new Date(this.now().getTime() - 30 * DAY).toISOString(),
        );
      for (const r of removed)
        if (!this.db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(r.id))
          this.notice(
            wsId,
            'removed',
            `${this.nameOf(ctx, r.pc)} deleted ticket ${r.no} “${r.title}”. It is in the project’s Trash for 30 days.`,
            projectId,
          );
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.unsent = null;
    }
  }

  // ------------------------------------------------------------ changes to settle

  private addConflict(
    ctx: Ctx,
    projectId: string,
    ch: Change,
    field: string,
    mine: unknown,
    theirs: unknown,
    fromPc: string,
  ): void {
    this.quiet(() => {
      this.db
        .prepare(
          'DELETE FROM ws_conflicts WHERE tbl = ? AND row_id = ? AND field = ?',
        )
        .run(ch.t, ch.id, field);
      this.db
        .prepare(
          'INSERT INTO ws_conflicts (id, workspace_id, project_id, tbl, row_id, field, mine, theirs, their_name, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          randomUUID(),
          str(ctx.ws.id),
          projectId,
          ch.t,
          ch.id,
          field,
          JSON.stringify(mine ?? null),
          JSON.stringify(theirs ?? null),
          this.nameOf(ctx, fromPc),
          this.iso(),
        );
    });
  }

  /** The changes both you and someone else made, for you to choose. */
  conflicts(): WsConflict[] {
    const out: WsConflict[] = [];
    const text = (v: unknown) => {
      try {
        const x = JSON.parse(str(v)) as unknown;
        return x === null || x === undefined ? '' : String(x);
      } catch {
        return '';
      }
    };
    for (const r of this.db
      .prepare('SELECT * FROM ws_conflicts ORDER BY at')
      .all() as Row[]) {
      const t = str(r.tbl);
      if (!ASK[t]?.includes(str(r.field))) continue;
      const row = this.db
        .prepare(`SELECT * FROM ${t} WHERE id = ?`)
        .get(str(r.row_id)) as Row | undefined;
      // The row is gone, or the choice no longer exists: nothing left to settle.
      if (!row || text(r.mine) === text(r.theirs)) {
        this.quiet(() =>
          this.db
            .prepare('DELETE FROM ws_conflicts WHERE id = ?')
            .run(str(r.id)),
        );
        continue;
      }
      const where =
        t === 'tasks'
          ? `Ticket ${str(row.customer_id)} · ${str(row.title_translation) || str(row.title_original)}`
          : t === 'project_tasks'
            ? `Task · ${str(row.title)}`
            : t === 'discussions'
              ? `Discussion ${str(row.customer_id)} · ${str(row.title)}`
              : `Note · ${str(row.title)}`;
      out.push({
        id: str(r.id),
        projectId: str(r.project_id),
        table: t,
        rowId: str(r.row_id),
        field: str(r.field),
        mine: text(r.mine),
        theirs: text(r.theirs),
        theirName: str(r.their_name),
        where,
        at: str(r.at),
      });
    }
    return out;
  }

  /**
   * Settles one: the value chosen is written like any other change of yours,
   * so everyone gets it. Returns what was changed, or null when nothing was.
   */
  resolveConflict(
    id: string,
    pick: 'mine' | 'theirs',
  ): { table: string; rowId: string; field: string; value: string } | null {
    const c = this.conflicts().find((x) => x.id === id);
    this.db.prepare('DELETE FROM ws_conflicts WHERE id = ?').run(id);
    if (!c) return null;
    const raw = this.db
      .prepare(`SELECT ${c.field} AS v FROM ${c.table} WHERE id = ?`)
      .get(c.rowId) as Row | undefined;
    if (!raw) return null;
    const want = pick === 'mine' ? c.mine : c.theirs;
    if (str(raw.v) === want) return null;
    const cols = columns(this.db, c.table);
    // Empty stands for "nothing set" where the field allows it.
    const value = want === '' && raw.v === null ? null : want;
    this.db
      .prepare(
        `UPDATE ${c.table} SET ${c.field} = ?${cols.has('updated_at') ? ', updated_at = ?' : ''} WHERE id = ?`,
      )
      .run(
        ...([
          value,
          ...(cols.has('updated_at') ? [this.iso()] : []),
          c.rowId,
        ] as never[]),
      );
    return { table: c.table, rowId: c.rowId, field: c.field, value: want };
  }

  // ------------------------------------------------------------ snapshots

  private blobFile(ctx: Ctx, projectId: string, t: string, id: string) {
    return path.join(
      str(ctx.ws.folder),
      'projects',
      projectId,
      'snapshot',
      'files',
      `${createHash('sha256').update(`${t}\n${id}`).digest('hex').slice(0, 32)}.wsb`,
    );
  }

  private async snapshotHeads(
    ctx: Ctx,
    projectId: string,
  ): Promise<{ pc: string; at: string; cursors: Record<string, number> }[]> {
    const dir = path.join(
      str(ctx.ws.folder),
      'projects',
      projectId,
      'snapshot',
    );
    const out: { pc: string; at: string; cursors: Record<string, number> }[] =
      [];
    for (const f of await this.ls(dir)) {
      const m = /^([0-9a-f]{16})\.wsn$/.exec(f);
      if (!m || ctx.removals.get(m[1])?.effective) continue;
      const text = await this.read(path.join(dir, f));
      if (!text) continue;
      try {
        const o = open<{ at: string; cursors: Record<string, number> }>(
          text,
          'snaphead',
          this.keyOf(ctx),
          this.signer(ctx),
        );
        if (o.pc === m[1]) out.push({ pc: m[1], ...o.data });
      } catch {
        // An older key, or not a member's: not used.
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  /**
   * Writes this PC's full copy of a project into the folder, so a new member
   * starts from it instead of every change ever made (doc 08, 3.4).
   */
  private async writeSnapshot(ctx: Ctx, projectId: string): Promise<boolean> {
    // Changes still waiting for their parent are not in the copy yet.
    if (
      this.db
        .prepare('SELECT 1 FROM ws_pending WHERE project_id = ?')
        .get(projectId)
    )
      return false;
    this.stage(projectId);
    const rows: SnapRow[] = (
      this.db
        .prepare(
          'SELECT tbl, id, data, clocks, deleted FROM ws_rows WHERE project_id = ?',
        )
        .all(projectId) as Row[]
    ).map((r) => ({
      t: str(r.tbl),
      id: str(r.id),
      d: JSON.parse(str(r.data) || '{}') as Row,
      c: JSON.parse(str(r.clocks) || '{}') as Record<string, string>,
      x: Number(r.deleted) === 1,
    }));
    if (!rows.length) return false;
    const cursors: Record<string, number> = {};
    for (const r of this.db
      .prepare(
        'SELECT pc_id, seq FROM ws_cursors WHERE workspace_id = ? AND project_id = ?',
      )
      .all(str(ctx.ws.id), projectId) as Row[])
      cursors[str(r.pc_id)] = Number(r.seq);
    // Files (attachments, pictures) are written once each, beside the snapshot.
    for (const r of rows) {
      const t = TABLE[r.t];
      if (!t?.blob || r.x) continue;
      const file = this.blobFile(ctx, projectId, r.t, r.id);
      if (await this.exists(file)) continue;
      const b = this.db
        .prepare(`SELECT ${t.blob} AS b FROM ${t.name} WHERE id = ?`)
        .get(r.id) as Row | undefined;
      if (b)
        await this.write(
          file,
          this.sealFor(ctx, 'snapfile', { t: r.t, id: r.id, b: toWire(b.b) }),
        );
    }
    const me = this.pcKeys().pcId;
    const dir = path.join(
      str(ctx.ws.folder),
      'projects',
      projectId,
      'snapshot',
    );
    const at = this.iso();
    await this.write(
      path.join(dir, `${me}.wss`),
      this.sealFor(ctx, 'snapshot', { project: projectId, at, cursors, rows }),
    );
    await this.write(
      path.join(dir, `${me}.wsn`),
      this.sealFor(ctx, 'snaphead', { project: projectId, at, cursors }),
    );
    return true;
  }

  /**
   * Takes in the newest snapshot. `need` names change files that are missing
   * (removed after a snapshot): only a snapshot that covers them helps. Null
   * for a project not on this PC yet.
   */
  private async loadSnapshot(
    ctx: Ctx,
    projectId: string,
    need: [string, number][] | null,
  ): Promise<number> {
    const heads = await this.snapshotHeads(ctx, projectId);
    const pick = heads.find(
      (h) =>
        need === null || need.some(([pc, at]) => (h.cursors[pc] ?? 0) > at),
    );
    if (!pick) return 0;
    const dir = path.join(
      str(ctx.ws.folder),
      'projects',
      projectId,
      'snapshot',
    );
    const text = await this.read(path.join(dir, `${pick.pc}.wss`));
    if (!text) return 0;
    let snap: {
      project: string;
      cursors: Record<string, number>;
      rows: SnapRow[];
    };
    try {
      const o = open<typeof snap>(
        text,
        'snapshot',
        this.keyOf(ctx),
        this.signer(ctx),
      );
      if (o.pc !== pick.pc || o.data.project !== projectId) return 0;
      snap = o.data;
    } catch {
      ctx.problems.push(`projects/${projectId}/snapshot/${pick.pc}.wss`);
      return 0;
    }
    // The files of rows this PC does not have yet.
    const blobs = new Map<string, unknown>();
    for (const r of snap.rows) {
      const t = TABLE[r.t];
      if (!t?.blob || r.x) continue;
      if (this.db.prepare(`SELECT 1 FROM ${t.name} WHERE id = ?`).get(r.id))
        continue;
      const b = await this.read(this.blobFile(ctx, projectId, r.t, r.id));
      if (!b) continue;
      try {
        const o = open<{ t: string; id: string; b: unknown }>(
          b,
          'snapfile',
          this.keyOf(ctx),
          this.signer(ctx),
        );
        if (o.data.t === r.t && o.data.id === r.id)
          blobs.set(`${r.t}\n${r.id}`, o.data.b);
      } catch {
        // Left out; the row comes without its file.
      }
    }
    if (this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId))
      this.stage(projectId);
    const order = new Map(SHARED_TABLES.map((t, i) => [t.name, i]));
    const rows = [...snap.rows].sort(
      (a, b) =>
        Number(a.x) - Number(b.x) ||
        (a.x
          ? (order.get(b.t) ?? 0) - (order.get(a.t) ?? 0)
          : (order.get(a.t) ?? 0) - (order.get(b.t) ?? 0)),
    );
    let n = 0;
    this.quiet(() => {
      this.db.exec('BEGIN');
      try {
        for (const r of rows) if (this.mergeRow(ctx, projectId, r, blobs)) n++;
        for (const [pc, seq] of Object.entries(snap.cursors))
          if (seq > this.cursor(str(ctx.ws.id), projectId, pc))
            this.setCursor(str(ctx.ws.id), projectId, pc, seq);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    });
    return n;
  }

  /** One row of a snapshot: each field is taken where the snapshot's is newer. */
  private mergeRow(
    ctx: Ctx,
    projectId: string,
    r: SnapRow,
    blobs: Map<string, unknown>,
  ): boolean {
    const t = TABLE[r.t];
    if (!t) return false;
    for (const c of Object.values(r.c)) this.clock().see(c);
    const me = this.pcKeys().pcId;
    if (r.x)
      return r.c._del
        ? this.apply(
            ctx,
            projectId,
            { t: r.t, id: r.id, del: true, c: r.c._del },
            me,
          )
        : false;
    const snapRow = this.db
      .prepare(
        'SELECT * FROM ws_rows WHERE project_id = ? AND tbl = ? AND id = ?',
      )
      .get(projectId, r.t, r.id) as Row | undefined;
    const clocks = snapRow
      ? (JSON.parse(str(snapRow.clocks) || '{}') as Record<string, string>)
      : {};
    const data =
      snapRow && Number(snapRow.deleted) === 0
        ? (JSON.parse(str(snapRow.data)) as Row)
        : {};
    const cols = columns(this.db, t.name);
    const theirs = Object.entries(r.c).filter(([k]) => k !== '_del');
    const put = () =>
      this.db
        .prepare(
          'INSERT OR REPLACE INTO ws_rows (project_id, tbl, id, data, clocks, deleted) VALUES (?, ?, ?, ?, ?, 0)',
        )
        .run(
          projectId,
          r.t,
          r.id,
          JSON.stringify(data),
          JSON.stringify(clocks),
        );
    const exists = !!this.db
      .prepare(`SELECT 1 FROM ${t.name} WHERE id = ?`)
      .get(r.id);
    try {
      if (!exists) {
        // Removed here after everything the snapshot knows: it stays removed.
        if (clocks._del && theirs.every(([, c]) => c <= clocks._del))
          return false;
        const full = new Map<string, unknown>(Object.entries(r.d));
        if (t.blob) {
          const b = blobs.get(`${r.t}\n${r.id}`);
          if (b === undefined) return false;
          full.set(t.blob, b);
        }
        for (const [k, v] of Object.entries(t.defaults ?? {}))
          if (!full.has(k)) full.set(k, v);
        full.set('id', r.id);
        const keys = [...full.keys()].filter(
          (k) =>
            (cols.has(k) && !t.private.includes(k)) || k in (t.defaults ?? {}),
        );
        this.db
          .prepare(
            `INSERT INTO ${t.name} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
          )
          .run(...(keys.map((k) => fromWire(full.get(k))) as never[]));
        for (const k of Object.keys(data)) delete data[k];
        Object.assign(data, r.d);
        for (const k of Object.keys(clocks)) delete clocks[k];
        for (const [k, c] of theirs) clocks[k] = c;
        put();
        return true;
      }
      const take = theirs.filter(
        ([k, c]) =>
          k in r.d &&
          cols.has(k) &&
          !t.private.includes(k) &&
          k !== t.blob &&
          (!clocks[k] || c > clocks[k]),
      );
      if (!take.length) return false;
      this.db
        .prepare(
          `UPDATE ${t.name} SET ${take.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`,
        )
        .run(...(take.map(([k]) => fromWire(r.d[k])) as never[]), r.id);
      for (const [k, c] of take) {
        data[k] = r.d[k];
        clocks[k] = c;
      }
      put();
      return true;
    } catch (e) {
      ctx.problems.push(
        `snapshot ${r.t}/${r.id}: ${String((e as Error).message).slice(0, 80)}`,
      );
      return false;
    }
  }

  /**
   * Now and then: writes a snapshot when the newest is a day old, and removes
   * this PC's change files that a snapshot covers and that are 30 days old.
   */
  private async keepHouse(
    ctx: Ctx,
    projectId: string,
    force = false,
  ): Promise<void> {
    const last = this.keptAt.get(projectId) ?? 0;
    if (!force && Date.now() - last < 10 * 60_000) return;
    this.keptAt.set(projectId, Date.now());
    let heads = await this.snapshotHeads(ctx, projectId);
    const every = this.d.snapshotEveryMs ?? DAY;
    if (
      force ||
      !heads.length ||
      this.now().getTime() - Date.parse(heads[0].at) > every
    ) {
      if (await this.writeSnapshot(ctx, projectId))
        heads = await this.snapshotHeads(ctx, projectId);
    }
    const me = this.pcKeys().pcId;
    const cover = Math.max(0, ...heads.map((h) => h.cursors[me] ?? 0));
    if (!cover) return;
    const keep = this.d.keepChangeFilesMs ?? 30 * DAY;
    const dir = path.join(str(ctx.ws.folder), 'projects', projectId, 'log', me);
    for (const f of await this.ls(dir)) {
      const m = /^(\d{6})\.wsc$/.exec(f);
      if (!m || Number(m[1]) > cover) continue;
      try {
        const st = await limited(() => fsp.stat(path.join(dir, f)), this.limit);
        if (Date.now() - st.mtimeMs >= keep)
          await limited(
            () => fsp.rm(path.join(dir, f), { force: true }),
            this.limit,
          );
      } catch {
        // Tried again next time.
      }
    }
  }

  /** Writes a snapshot of a shared project now and tidies this PC's old change files. */
  async snapshotNow(workspaceId: string, projectId: string): Promise<void> {
    const ctx = await this.load(this.row(workspaceId));
    await this.keepHouse(ctx, projectId, true);
  }

  /** Applies one change: the later change of each field wins. True when something changed. */
  private apply(
    ctx: Ctx,
    projectId: string,
    ch: Change,
    fromPc: string,
  ): boolean {
    const t = TABLE[ch.t];
    if (!t) return false;
    const snapRow = this.db
      .prepare(
        'SELECT * FROM ws_rows WHERE project_id = ? AND tbl = ? AND id = ?',
      )
      .get(projectId, ch.t, ch.id) as Row | undefined;
    const clocks = snapRow
      ? (JSON.parse(str(snapRow.clocks) || '{}') as Record<string, string>)
      : {};
    const data =
      snapRow && Number(snapRow.deleted) === 0
        ? (JSON.parse(str(snapRow.data)) as Row)
        : {};
    const put = (deleted: number) =>
      this.db
        .prepare(
          'INSERT OR REPLACE INTO ws_rows (project_id, tbl, id, data, clocks, deleted) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          projectId,
          ch.t,
          ch.id,
          JSON.stringify(data),
          JSON.stringify(clocks),
          deleted,
        );
    const exists = !!this.db
      .prepare(`SELECT 1 FROM ${t.name} WHERE id = ?`)
      .get(ch.id);
    const fieldClocks = Object.entries(clocks).filter(([k]) => k !== '_del');
    if (ch.del) {
      // A project is taken off a PC, never deleted for everyone.
      if (ch.t === 'projects') return false;
      // A removal wins over edits made around the same time. Only a row made
      // again afterwards (Undo: every field is newer) stays.
      if (fieldClocks.length && fieldClocks.every(([, c]) => c > ch.c))
        return false;
      if (clocks._del && clocks._del >= ch.c && !exists) return false;
      if (exists && t.name === 'notes') {
        // A note you shared stays yours when someone stops sharing or deletes it.
        const n = this.db
          .prepare('SELECT title, shared_by FROM notes WHERE id = ?')
          .get(ch.id) as Row;
        if (str(n.shared_by) === this.d.myMemberId()) {
          this.db
            .prepare("UPDATE notes SET shared = 0, shared_by = '' WHERE id = ?")
            .run(ch.id);
          if (fromPc !== this.pcKeys().pcId)
            this.notice(
              str(ctx.ws.id),
              'removed',
              `${this.nameOf(ctx, fromPc)} stopped sharing your note “${str(n.title)}”. It is still on this PC, only for you.`,
              projectId,
            );
        } else this.db.prepare('DELETE FROM notes WHERE id = ?').run(ch.id);
      } else if (exists && !t.noRemoteDelete)
        this.db.prepare(`DELETE FROM ${t.name} WHERE id = ?`).run(ch.id);
      for (const k of Object.keys(data)) delete data[k];
      clocks._del = ch.c;
      put(1);
      return exists;
    }
    if (clocks._del && clocks._del >= ch.c) return false;
    // An edit of a row removed here does not bring it back; only the whole row does.
    if (
      !exists &&
      clocks._del &&
      !fieldClocks.every(([k]) => k in (ch.f ?? {}))
    )
      return false;
    const cols = columns(this.db, t.name);
    const take: [string, unknown][] = [];
    const mine = this.pcKeys().pcId;
    for (const [k, v] of Object.entries(ch.f ?? {})) {
      if (!cols.has(k) || t.private.includes(k)) continue;
      // You changed this too and have not sent it yet: it is put to you to settle.
      const key = `${ch.t}:${ch.id}:${k}`;
      if (
        fromPc !== mine &&
        this.unsent?.has(key) &&
        ASK[ch.t]?.includes(k) &&
        JSON.stringify(this.unsent.get(key)) !== JSON.stringify(v)
      )
        this.addConflict(
          ctx,
          projectId,
          ch,
          k,
          this.unsent.get(key),
          v,
          fromPc,
        );
      if (clocks[k] && clocks[k] >= ch.c) continue;
      // Someone overwrote a field you set in the last few minutes (doc 08, 3.4).
      if (
        clocks[k] &&
        Hlc.parse(clocks[k]).pc === mine &&
        fromPc !== mine &&
        this.now().getTime() -
          (this.editedHere.get(`${ch.t}:${ch.id}:${k}`) ?? 0) <
          10 * 60_000 &&
        (ch.t === 'tasks' || ch.t === 'project_tasks') &&
        ['status', 'assignee', 'priority', 'due_date', 'planned_end'].includes(
          k,
        ) &&
        JSON.stringify(data[k]) !== JSON.stringify(v)
      )
        this.notice(
          str(ctx.ws.id),
          'overwritten',
          `${this.nameOf(ctx, fromPc)} changed the ${k.replace('_', ' ')} you set a few minutes ago.`,
          projectId,
          ch.id,
        );
      take.push([k, v]);
    }
    if (!take.length) return false;
    if (!exists && t.parent) {
      const parentId = (ch.f ?? {})[t.parent.column] ?? data[t.parent.column];
      if (
        !parentId ||
        !this.db
          .prepare(`SELECT 1 FROM ${t.parent.table} WHERE id = ?`)
          .get(str(parentId))
      )
        throw new Pending('parent not here yet');
    }
    try {
      if (exists) {
        this.db
          .prepare(
            `UPDATE ${t.name} SET ${take.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`,
          )
          .run(...(take.map(([, v]) => fromWire(v)) as never[]), ch.id);
      } else {
        const full = new Map<string, unknown>([
          ...Object.entries(data),
          ...take,
        ]);
        for (const [k, v] of Object.entries(t.defaults ?? {}))
          if (!full.has(k)) full.set(k, v);
        full.set('id', ch.id);
        const keys = [...full.keys()].filter(
          (k) =>
            (cols.has(k) && !t.private.includes(k)) || k in (t.defaults ?? {}),
        );
        this.db
          .prepare(
            `INSERT INTO ${t.name} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
          )
          .run(...(keys.map((k) => fromWire(full.get(k))) as never[]));
      }
    } catch (e) {
      const msg = String((e as Error).message);
      if (/NOT NULL|FOREIGN KEY/i.test(msg)) throw new Pending(msg);
      // One change the database refuses must not stop every other change.
      ctx.problems.push(`change ${ch.t}/${ch.id}: ${msg.slice(0, 80)}`);
      return false;
    }
    for (const [k, v] of take) {
      if (k !== t.blob) data[k] = v;
      clocks[k] = ch.c;
    }
    put(0);
    if (fromPc !== mine)
      this.noticesFor(ctx, projectId, ch, take, fromPc, exists);
    return true;
  }

  /** Tells you what concerns you: assigned to you, mentioned, a watched discussion (doc 08, 3.9). */
  private noticesFor(
    ctx: Ctx,
    projectId: string,
    ch: Change,
    take: [string, unknown][],
    fromPc: string,
    existed: boolean,
  ) {
    const ws = str(ctx.ws.id);
    const me = this.d.myMemberId();
    const who = this.nameOf(ctx, fromPc);
    const f = Object.fromEntries(take);
    if (ch.t === 'project_tasks') {
      const row = this.db
        .prepare(
          'SELECT title, assignee, made_by, status FROM project_tasks WHERE id = ?',
        )
        .get(ch.id) as Row | undefined;
      if (!row) return;
      if ('assignee' in f && f.assignee === me)
        this.notice(
          ws,
          'assigned',
          `${who} gave you a task: ${str(row.title)}.`,
          projectId,
          ch.id,
        );
      if (
        'status' in f &&
        f.status === 'done' &&
        (str(row.made_by) === me || str(row.assignee) === me)
      )
        this.notice(
          ws,
          'done',
          `${who} made a task Done: ${str(row.title)}.`,
          projectId,
          ch.id,
        );
    }
    if (ch.t === 'comments' && !existed) {
      const body = str(f.body);
      const d = this.db
        .prepare(
          'SELECT d.id, d.title, d.watchers FROM discussions d JOIN comments c ON c.discussion_id = d.id WHERE c.id = ?',
        )
        .get(ch.id) as Row | undefined;
      const myName = this.d.myName().toLowerCase();
      const mentioned = [...body.matchAll(/@([^\s@,.;:!?]+)/g)].some(
        (m) => m[1].toLowerCase() === myName,
      );
      if (mentioned)
        this.notice(
          ws,
          'mention',
          `${who} mentioned you in “${str(d?.title)}”.`,
          projectId,
          str(d?.id),
        );
      else if (
        d &&
        (JSON.parse(str(d.watchers) || '[]') as string[]).includes(me)
      )
        this.notice(
          ws,
          'comment',
          `${who} commented on “${str(d.title)}”.`,
          projectId,
          str(d.id),
        );
    }
    if (ch.t === 'tasks' && 'customer_id' in f && f.customer_id) {
      const twins = this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND customer_id = ?',
        )
        .get(projectId, str(f.customer_id)) as Row;
      if (Number(twins.n) > 1)
        this.notice(
          ws,
          'clash',
          `Your ${str(f.customer_id)} and ${who}'s ${str(f.customer_id)} have the same number. Talk with them and decide which one changes.`,
          projectId,
          ch.id,
        );
    }
  }

  /** New shared projects in the folder, fetched into this PC. */
  private async newProjects(ctx: Ctx): Promise<void> {
    const wsId = str(ctx.ws.id);
    const ignored = this.ignored(wsId);
    for (const pid of await this.ls(
      path.join(str(ctx.ws.folder), 'projects'),
    )) {
      if (ignored.includes(pid)) continue;
      if (
        this.db
          .prepare('SELECT 1 FROM ws_projects WHERE project_id = ?')
          .get(pid)
      )
        continue;
      const text = await this.read(
        path.join(str(ctx.ws.folder), 'projects', pid, 'info.wsi'),
      );
      if (!text) continue;
      try {
        const info = open<{ id: string; name: string }>(
          text,
          'project',
          this.keyOf(ctx),
          this.signer(ctx),
        ).data;
        if (info.id !== pid) continue;
        if (this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(pid))
          continue; // a local copy with this id
        this.db
          .prepare(
            'INSERT INTO ws_projects (project_id, workspace_id, shared_at) VALUES (?, ?, ?)',
          )
          .run(pid, wsId, this.iso());
      } catch {
        ctx.problems.push(`projects/${pid}/info.wsi`);
      }
    }
  }

  private async presence(
    ctx: Ctx,
  ): Promise<Map<string, { at: string; viewing: string }>> {
    const out = new Map<string, { at: string; viewing: string }>();
    const dir = path.join(str(ctx.ws.folder), 'presence');
    for (const f of await this.ls(dir)) {
      const m = /^([0-9a-f]{16})\.wsp$/.exec(f);
      if (!m) continue;
      const t = await this.read(path.join(dir, f));
      if (!t) continue;
      try {
        const o = open<{ at: string; viewing: string }>(
          t,
          'presence',
          this.keyOf(ctx),
          this.signer(ctx),
        );
        if (o.pc === m[1]) out.set(m[1], o.data);
      } catch {
        // stale key
      }
    }
    return out;
  }

  /** Acknowledges removals made by someone else, so they take effect. */
  private async acknowledge(ctx: Ctx): Promise<void> {
    const me = this.pcKeys().pcId;
    for (const [target, r] of ctx.removals) {
      if (r.by === me || target === me) continue;
      const file = path.join(str(ctx.ws.folder), 'acks', `${target}.${me}.wsa`);
      if (await this.read(file)) continue;
      const body = { target, by: me, at: this.iso() };
      await this.write(
        file,
        JSON.stringify({
          ...body,
          sig: signText(this.pcKeys(), JSON.stringify(body)),
        }),
      );
      const m = ctx.members.get(target);
      this.notice(
        str(ctx.ws.id),
        'removed',
        `${this.nameOf(ctx, r.by)} removed ${m?.name ?? 'a PC'} (${m?.pc ?? ''}) from the workspace.`,
      );
    }
  }

  /** New members since the last round: everyone is told (doc 08, 3.5). */
  private tellNewMembers(ctx: Ctx) {
    const key = `wsKnown:${str(ctx.ws.id)}`;
    const r = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as Row | undefined;
    const known = new Set(r ? (JSON.parse(str(r.value)) as string[]) : []);
    const first = !r;
    const me = this.pcKeys().pcId;
    let grew = false;
    for (const m of ctx.members.values()) {
      if (known.has(m.pcId)) continue;
      known.add(m.pcId);
      grew = true;
      if (
        !first &&
        m.pcId !== me &&
        m.approvedBy !== me &&
        !m.memberId.startsWith('recovery-')
      )
        this.notice(
          str(ctx.ws.id),
          'member',
          `${this.nameOf(ctx, m.approvedBy)} let ${m.name} (${m.account} · ${m.pc}) in.`,
        );
    }
    if (grew || first)
      this.quiet(() =>
        this.db
          .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
          .run(key, JSON.stringify([...known])),
      );
  }

  /** A removed member's tasks become Unassigned (doc 10, 4). */
  private unassignRemoved(ctx: Ctx) {
    const gone = new Set(
      [...ctx.members.values()]
        .filter((m) => ctx.removals.get(m.pcId)?.effective)
        .map((m) => m.memberId)
        .filter((id) =>
          [...ctx.members.values()].every(
            (x) => x.memberId !== id || ctx.removals.get(x.pcId)?.effective,
          ),
        ),
    );
    if (!gone.size) return;
    for (const p of this.db
      .prepare('SELECT project_id FROM ws_projects WHERE workspace_id = ?')
      .all(str(ctx.ws.id)) as Row[])
      for (const id of gone)
        this.db
          .prepare(
            "UPDATE project_tasks SET assignee = '' WHERE project_id = ? AND assignee = ? AND status <> 'done'",
          )
          .run(str(p.project_id), id);
  }

  /** One sync round of one workspace. Returns how many changes came in. */
  async syncWorkspace(
    workspaceId: string,
  ): Promise<{ in: number; out: number }> {
    const ws = this.row(workspaceId);
    const st = this.status.get(workspaceId) ?? {
      online: false,
      problem: null,
      waiting: 0,
      update: null,
    };
    this.status.set(workspaceId, st);
    if (Number(ws.offline) === 1) {
      for (const p of this.db
        .prepare('SELECT project_id FROM ws_projects WHERE workspace_id = ?')
        .all(workspaceId) as Row[])
        if (
          this.db
            .prepare('SELECT 1 FROM projects WHERE id = ?')
            .get(str(p.project_id))
        )
          this.stage(str(p.project_id));
      st.online = false;
      st.waiting = this.waiting(workspaceId);
      return { in: 0, out: 0 };
    }
    for (const p of this.db
      .prepare('SELECT project_id FROM ws_projects WHERE workspace_id = ?')
      .all(workspaceId) as Row[])
      if (
        this.db
          .prepare('SELECT 1 FROM projects WHERE id = ?')
          .get(str(p.project_id))
      )
        this.stage(str(p.project_id));
    const wasOnline = st.online;
    let got = 0;
    let sent = 0;
    try {
      if (str(ws.state) === 'pending') {
        await this.checkPending(ws);
        st.online = true;
        st.problem = null;
        return { in: 0, out: 0 };
      }
      if (str(ws.state) !== 'member') return { in: 0, out: 0 };
      const ctx = await this.load(ws);
      const me = this.pcKeys().pcId;
      if (ctx.removals.get(me)?.effective) {
        this.notice(
          workspaceId,
          'removed',
          `You were removed from the workspace ${str(ws.name)}. Its projects stay here as local copies.`,
        );
        this.dropLocal(workspaceId);
        return { in: 0, out: 0 };
      }
      if (!ctx.members.has(me))
        throw new Error('This PC is not a member of the workspace any more.');
      this.tellNewMembers(ctx);
      if (!this.readOnly(ctx)) await this.acknowledge(ctx);
      await this.newProjects(ctx);
      this.unassignRemoved(ctx);
      for (const p of this.db
        .prepare('SELECT project_id FROM ws_projects WHERE workspace_id = ?')
        .all(workspaceId) as Row[]) {
        const pid = str(p.project_id);
        // Pull first, so changes made offline here are compared with what came in.
        got += (await this.pull(ctx, pid)).applied;
        if (
          !this.readOnly(ctx) &&
          this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(pid)
        )
          sent += await this.push(ctx, pid);
        if (this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(pid)) {
          // Whoever links the customer's file is known to all, so nobody links it twice.
          this.db
            .prepare(
              "UPDATE projects SET file_keeper = ? WHERE id = ? AND (file_keeper IS NULL OR file_keeper = '') AND EXISTS (SELECT 1 FROM source_files WHERE project_id = ?)",
            )
            .run(this.d.myMemberId(), pid, pid);
          // Tidying up is never worth failing a sync for; it is tried again later.
          if (!this.readOnly(ctx))
            await this.keepHouse(ctx, pid).catch(() => undefined);
        }
      }
      if (this.now().getTime() - this.lastPresence > 15_000) {
        this.lastPresence = this.now().getTime();
        await this.write(
          path.join(str(ws.folder), 'presence', `${me}.wsp`),
          this.sealFor(ctx, 'presence', {
            at: this.iso(),
            viewing: this.viewing,
          }),
        );
      }
      st.update = await this.findUpdate(str(ws.folder));
      // The time of the last sync is kept in memory and written once a minute.
      const nowMs = this.now().getTime();
      const was = this.syncedAt.get(workspaceId);
      const save = !was || nowMs - was.saved > 60_000 || ws.last_error != null;
      this.syncedAt.set(workspaceId, {
        at: this.iso(),
        saved: save ? nowMs : was.saved,
      });
      if (save)
        this.quiet(() =>
          this.db
            .prepare(
              'UPDATE workspaces SET last_sync = ?, last_error = NULL WHERE id = ?',
            )
            .run(this.iso(), workspaceId),
        );
      if (!wasOnline && (got || sent) && st.problem)
        this.notice(
          workspaceId,
          'catchup',
          `Back online with ${str(ws.name)}: ${got} changes came in and ${sent} were sent.`,
        );
      st.online = true;
      st.problem = null;
      st.waiting = 0;
    } catch (e) {
      st.online = false;
      st.problem = e instanceof Error ? e.message : String(e);
      st.waiting = this.waiting(workspaceId);
      if (str(ws.last_error) !== st.problem)
        this.quiet(() =>
          this.db
            .prepare('UPDATE workspaces SET last_error = ? WHERE id = ?')
            .run(st.problem, workspaceId),
        );
    }
    return { in: got, out: sent };
  }

  /** Syncs every workspace. Returns how many changes came in. */
  async syncAll(): Promise<number> {
    let n = 0;
    for (const ws of this.rows())
      n += (await this.syncWorkspace(str(ws.id))).in;
    return n;
  }

  // ------------------------------------------------------------ updates

  /** A newer WorkSync zip in the folder's app folder (doc 08, 3.10). */
  private async findUpdate(folder: string): Promise<WorkspaceInfo['update']> {
    if (!this.d.appVersion) return null;
    const cmp = (a: string, b: string) => {
      const x = a.split('.').map(Number);
      const y = b.split('.').map(Number);
      for (let i = 0; i < 3; i++)
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
      return 0;
    };
    let best: WorkspaceInfo['update'] = null;
    for (const f of await this.ls(path.join(folder, 'app'))) {
      const m = /(\d+\.\d+\.\d+)/.exec(f);
      if (!m || !/\.zip$/i.test(f)) continue;
      if (
        cmp(m[1], this.d.appVersion) > 0 &&
        (!best || cmp(m[1], best.version) > 0)
      )
        best = { file: path.join(folder, 'app', f), version: m[1] };
    }
    return best;
  }

  // ------------------------------------------------------------ info

  async info(id: string): Promise<WorkspaceInfo | null> {
    const ws = this.db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(id) as Row | undefined;
    if (!ws) return null;
    const ctx = this.ctxs.get(id);
    const st = this.status.get(id);
    const projects = (
      this.db
        .prepare(
          'SELECT w.project_id, p.name FROM ws_projects w LEFT JOIN projects p ON p.id = w.project_id WHERE w.workspace_id = ?',
        )
        .all(id) as Row[]
    ).map((r) => ({
      id: str(r.project_id),
      name: str(r.name),
      local: r.name != null,
    }));
    return {
      id,
      name: str(ws.name),
      folder: str(ws.folder),
      state: str(ws.state) as WsState,
      offline: Number(ws.offline) === 1,
      online: st?.online ?? false,
      lastSync:
        this.syncedAt.get(id)?.at ??
        (ws.last_sync == null ? null : str(ws.last_sync)),
      waiting: st?.waiting ?? 0,
      problem:
        st?.problem ?? (ws.last_error == null ? null : str(ws.last_error)),
      code:
        str(ws.state) === 'pending' ? joinCode(publicOf(this.pcKeys())) : null,
      projects,
      readOnly: ctx ? this.readOnly(ctx) : false,
      problems: [...new Set(ctx?.problems ?? [])],
      update: st?.update ?? null,
    };
  }

  async list(): Promise<WorkspaceInfo[]> {
    const out: WorkspaceInfo[] = [];
    for (const r of this.rows()) {
      const i = await this.info(str(r.id));
      if (i) out.push(i);
    }
    return out;
  }
}
