/**
 * Shared workspaces (doc 08): types the main process and the screens share.
 * Free of Node.js and Electron imports.
 */

/** The workspace folder format this WorkSync reads and writes. */
export const WORKSPACE_FORMAT = 1;

export interface WsPc {
  pcId: string;
  /** The PC's name, such as PC-0412. */
  pc: string;
  account: string;
  approvedBy: string;
  at: string;
  /** Removed, or waiting for a second member to see the removal. */
  removed: 'no' | 'pending' | 'yes';
  online: boolean;
  /** What the person has open, such as ticket 015 (a hint). */
  viewing: string;
  lastSeen: string | null;
}

export interface WsMember {
  memberId: string;
  name: string;
  tag: string;
  color: string;
  me: boolean;
  pcs: WsPc[];
  removed: boolean;
}

export interface JoinRequest {
  workspaceId: string;
  pcId: string;
  name: string;
  account: string;
  pc: string;
  code: string;
  at: string;
  /** Members who look like the same person (same Windows account or name). */
  looksLike: { memberId: string; name: string; account: string }[];
}

export type WsState = 'member' | 'pending' | 'declined' | 'removed' | 'left';

export interface WorkspaceInfo {
  id: string;
  name: string;
  folder: string;
  state: WsState;
  /** You chose Work offline. */
  offline: boolean;
  /** The folder could be reached at the last try. */
  online: boolean;
  /** When this PC last synced with the folder. */
  lastSync: string | null;
  /** Your changes not yet written to the folder. */
  waiting: number;
  /** Why the last sync failed, in English (translated on screen). */
  problem: string | null;
  /** The code to tell a member, while waiting to be let in. */
  code: string | null;
  /** Projects shared in this workspace. */
  projects: { id: string; name: string; local: boolean }[];
  /** A newer folder format than this WorkSync knows: read-only. */
  readOnly: boolean;
  /** Files in the folder that are not signed by a member, ignored. */
  problems: string[];
  /** A newer WorkSync zip in the folder's app folder, if any. */
  update: { file: string; version: string } | null;
}

export type NoticeKind =
  | 'assigned'
  | 'mention'
  | 'comment'
  | 'overwritten'
  | 'join'
  | 'member'
  | 'removed'
  | 'clash'
  | 'catchup'
  | 'done';

export interface Notice {
  id: string;
  workspaceId: string;
  projectId: string | null;
  itemId: string | null;
  at: string;
  kind: NoticeKind;
  /** In English; translated on screen. */
  text: string;
  read: boolean;
}

/**
 * A hybrid clock (doc 08, 3.4): the wall clock plus a counter and the PC,
 * so a PC with a wrong clock cannot win forever and two changes never tie.
 */
export class Hlc {
  private ms = 0;
  private c = 0;
  constructor(
    private pc: string,
    private wall: () => number = () => Date.now(),
  ) {}
  static parse(s: string): { ms: number; c: number; pc: string } {
    const [ms, c, ...pc] = s.split('.');
    return { ms: Number(ms), c: Number(c), pc: pc.join('.') };
  }
  private fmt() {
    return `${String(this.ms).padStart(13, '0')}.${String(this.c).padStart(4, '0')}.${this.pc}`;
  }
  /** A clock value for a change made now. */
  next(): string {
    const w = this.wall();
    if (w > this.ms) {
      this.ms = w;
      this.c = 0;
    } else this.c++;
    return this.fmt();
  }
  /** Moves past a clock value seen from another PC. */
  see(s: string): void {
    const r = Hlc.parse(s);
    if (!Number.isFinite(r.ms)) return;
    if (r.ms > this.ms) {
      this.ms = r.ms;
      this.c = r.c;
    } else if (r.ms === this.ms && r.c > this.c) this.c = r.c;
  }
}
