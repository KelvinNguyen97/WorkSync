import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  JoinRequest,
  Notice,
  WorkspaceInfo,
  WsMember,
} from '../shared/workspace';
import { useApp } from './appState';
import { Icon } from './Icon';
import { tr, uiLanguage } from './i18n';
import { translateMessage } from '../shared/i18n';
import { confirmDelete, Modal } from './parts';
import { workChanged } from './work';

const WS_CHANGED = 'worksync:ws-ui';
export const wsChanged = () => window.dispatchEvent(new Event(WS_CHANGED));

/** The workspaces, kept current: after each sync, and every few seconds for "synced 4 s ago". */
export function useWorkspaces() {
  const [list, setList] = useState<WorkspaceInfo[]>([]);
  const load = useCallback(async () => {
    try {
      setList(await window.worksync.listWorkspaces());
    } catch {
      setList([]);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 5000);
    const on = () => void load();
    window.addEventListener(WS_CHANGED, on);
    return () => {
      window.clearInterval(t);
      window.removeEventListener(WS_CHANGED, on);
    };
  }, [load]);
  return { list, reload: load };
}

/** A message from the main process (stored in English) in the app language. */
const msg = (s: string) => translateMessage(uiLanguage(), s);

function ago(iso: string | null, now: number): string {
  if (!iso) return tr('not synced yet');
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return tr('synced {n} s ago', { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return tr('synced {n} min ago', { n: m });
  return tr('synced at {time}', { time: iso.slice(11, 16) });
}

/** "Online · synced 4 s ago" in green, "Offline · 3 changes waiting" in grey (doc 08, 3.2). */
export function WsState({ w }: { w: WorkspaceInfo }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  if (w.state === 'pending')
    return (
      <span className="ws-state wait">
        <span className="dot" />
        {tr('Waiting to be let in · code {code}', { code: w.code ?? '' })}
      </span>
    );
  if (w.state === 'declined')
    return (
      <span className="ws-state bad">
        <span className="dot" />
        {tr('Your request was declined')}
      </span>
    );
  if (w.readOnly)
    return (
      <span className="ws-state bad">
        <span className="dot" />
        {tr('Read-only: needs a newer WorkSync')}
      </span>
    );
  const on = w.online && !w.offline;
  return (
    <span
      className={`ws-state ${on ? 'on' : 'off'}`}
      title={w.problem ? msg(w.problem) : undefined}
    >
      <span className="dot" />
      {on
        ? `${tr('Online')} · ${ago(w.lastSync, now)}`
        : `${w.offline ? tr('Working offline') : tr('Offline')} · ${tr(
            w.waiting === 1 ? '{n} change waiting' : '{n} changes waiting',
            { n: w.waiting },
          )}`}
    </span>
  );
}

/** The workspaces in the sidebar, with their state. */
export function WorkspacesNav({ onOpen }: { onOpen: () => void }) {
  const { list } = useWorkspaces();
  if (!list.length) return null;
  return (
    <div className="ws-nav">
      {list.map((w) => (
        <button
          key={w.id}
          className="ws-nav-item"
          onClick={onOpen}
          title={w.folder}
        >
          <Icon name="users" />
          <span className="grow">
            <b>{w.name}</b>
            <WsState w={w} />
          </span>
        </button>
      ))}
    </div>
  );
}

/** Join requests for members to check (doc 08, 3.5): one card each. */
export function JoinRequests() {
  const { attempt, toast } = useApp();
  const [reqs, setReqs] = useState<JoinRequest[]>([]);
  const { list } = useWorkspaces();
  const load = useCallback(async () => {
    try {
      setReqs(await window.worksync.joinRequests());
    } catch {
      setReqs([]);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 8000);
    const off = window.worksync.onWorkspaceChanged(() => void load());
    return () => {
      window.clearInterval(t);
      off();
    };
  }, [load]);
  if (!reqs.length) return null;
  const name = (id: string) => list.find((w) => w.id === id)?.name ?? '';
  return (
    <div className="ws-reqs" role="region" aria-label={tr('Join requests')}>
      {reqs.map((r) => (
        <div key={r.pcId} className="ws-req">
          <Icon name="users" />
          <span className="grow">
            <b>
              {tr('{who} wants to join {workspace}', {
                who: `${r.name} · ${r.account} · ${r.pc}`,
                workspace: name(r.workspaceId),
              })}
            </b>
            <small>
              {tr(
                'Check that their screen shows this code, at their desk, by Teams or by phone. Then let them in.',
              )}
            </small>
          </span>
          <span className="ws-code" aria-label={tr('Code')}>
            {r.code}
          </span>
          {r.looksLike.map((m) => (
            <button
              key={m.memberId}
              className="btn"
              title={tr('Their history, tasks and comments stay theirs.')}
              onClick={() =>
                void attempt(() =>
                  window.worksync.approveJoin(
                    r.workspaceId,
                    r.pcId,
                    m.memberId,
                  ),
                ).then(() => {
                  toast(
                    tr('Let {who} in as the same member.', { who: r.name }),
                  );
                  void load();
                  wsChanged();
                })
              }
            >
              {tr('Let in as {who} again', {
                who: `${m.name}${m.account ? ` (${m.account})` : ''}`,
              })}
            </button>
          ))}
          <button
            className="btn primary"
            onClick={() =>
              void attempt(() =>
                window.worksync.approveJoin(r.workspaceId, r.pcId),
              ).then(() => {
                toast(tr('Let {who} in.', { who: r.name }));
                void load();
                wsChanged();
              })
            }
          >
            <Icon name="check" />
            {r.looksLike.length ? tr('Let in as a new member') : tr('Let in')}
          </button>
          <button
            className="btn"
            onClick={() =>
              void attempt(() =>
                window.worksync.declineJoin(r.workspaceId, r.pcId),
              ).then(() => void load())
            }
          >
            {tr('Decline')}
          </button>
        </div>
      ))}
    </div>
  );
}

/** The bell: assigned to you, mentions, watched discussions, removals (doc 08, 3.9). */
export function NoticesBell({
  onOpen,
  onShow,
}: {
  onOpen: (n: Notice) => void;
  /** Called when the list opens, to close the narrow window's sidebar under it. */
  onShow?: () => void;
}) {
  const [list, setList] = useState<Notice[]>([]);
  const [open, setOpen] = useState(false);
  const load = useCallback(async () => {
    try {
      setList(await window.worksync.listNotices());
    } catch {
      setList([]);
    }
  }, []);
  useEffect(() => {
    void load();
    const off = window.worksync.onWorkspaceChanged(() => void load());
    const t = window.setInterval(() => void load(), 15000);
    return () => {
      off();
      window.clearInterval(t);
    };
  }, [load]);
  const unread = list.filter((n) => !n.read).length;
  return (
    <>
      <button
        className="nav-item"
        aria-label={tr('Notices')}
        onClick={() => {
          onShow?.();
          setOpen(true);
        }}
      >
        <Icon name="bell" />
        <span className="grow">{tr('Notices')}</span>
        {unread > 0 && <span className="count ws-unread">{unread}</span>}
      </button>
      {open && (
        <Modal
          title={tr('Notices')}
          subtitle={tr('What happened in your workspaces that concerns you.')}
          onClose={() => {
            setOpen(false);
            void window.worksync.markNoticesRead().then(load);
          }}
          narrow
        >
          <div className="ws-notices" role="list">
            {list.map((n) => (
              <button
                key={n.id}
                role="listitem"
                className={`ws-notice ${n.read ? '' : 'unread'}`}
                onClick={() => {
                  setOpen(false);
                  void window.worksync.markNoticesRead([n.id]).then(load);
                  onOpen(n);
                }}
              >
                <Icon
                  name={
                    n.kind === 'mention' || n.kind === 'comment'
                      ? 'chat'
                      : n.kind === 'assigned' || n.kind === 'done'
                        ? 'checklist'
                        : n.kind === 'clash' || n.kind === 'overwritten'
                          ? 'alert'
                          : 'users'
                  }
                />
                <span className="grow">
                  {msg(n.text)}
                  <small className="muted mono">
                    {n.at.slice(0, 16).replace('T', ' ')}
                  </small>
                </span>
              </button>
            ))}
            {!list.length && <p className="muted">{tr('No notices yet.')}</p>}
          </div>
        </Modal>
      )}
    </>
  );
}

function Members({ w }: { w: WorkspaceInfo }) {
  const { attempt, toast } = useApp();
  const [members, setMembers] = useState<WsMember[]>([]);
  const load = useCallback(async () => {
    try {
      setMembers(await window.worksync.workspaceMembers(w.id));
    } catch {
      setMembers([]);
    }
  }, [w.id]);
  useEffect(() => {
    void load();
    const off = window.worksync.onWorkspaceChanged(() => void load());
    return off;
  }, [load]);
  const remove = async (
    who: { pcId?: string; memberId?: string },
    label: string,
  ) => {
    if (
      !(await confirmDelete({
        title: tr('Remove {who}?', { who: label }),
        text: tr(
          'Their later changes are refused and a new workspace key is made for everyone else. What they already saw stays in their own copy. Every member is told; it takes effect once a second member’s WorkSync has seen it, or after 24 hours.',
        ),
        yes: tr('Remove'),
      }))
    )
      return;
    await attempt(() => window.worksync.removeFromWorkspace(w.id, who));
    toast(tr('Removed {who}. Every member is told.', { who: label }));
    void load();
  };
  return (
    <div className="ws-members" role="list" aria-label={tr('Members')}>
      {members.map((m) => (
        <div
          key={m.memberId}
          role="listitem"
          className={`ws-member ${m.removed ? 'removed' : ''}`}
        >
          <span
            className="wk-avatar"
            style={{ background: m.color }}
            aria-hidden="true"
          >
            {m.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="grow">
            <b>
              {m.name} <span className="wk-tag">·{m.tag}</span>{' '}
              {m.me && <span className="chip">{tr('You')}</span>}
              {m.removed && <span className="chip muted">{tr('Removed')}</span>}
            </b>
            {m.pcs.map((p) => (
              <small key={p.pcId} className="ws-pc">
                <span
                  className={`dot ${p.online ? 'on' : ''}`}
                  aria-hidden="true"
                />
                {p.account} · {p.pc}
                {p.online
                  ? ` · ${tr('online')}${p.viewing ? ` · ${p.viewing}` : ''}`
                  : p.lastSeen
                    ? ` · ${tr('last seen {time}', { time: p.lastSeen.slice(0, 16).replace('T', ' ') })}`
                    : ''}
                {p.removed === 'pending' &&
                  ` · ${tr('removal waits for a second member')}`}
                {p.removed === 'yes' && ` · ${tr('removed')}`}
                {!m.me && p.removed === 'no' && m.pcs.length > 1 && (
                  <button
                    className="linkbtn"
                    onClick={() =>
                      void remove({ pcId: p.pcId }, `${m.name} · ${p.pc}`)
                    }
                  >
                    {tr('Remove this PC')}
                  </button>
                )}
              </small>
            ))}
          </span>
          {!m.me && !m.removed && (
            <button
              className="btn sm"
              onClick={() => void remove({ memberId: m.memberId }, m.name)}
            >
              {tr('Remove')}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Settings › Workspaces (doc 08, 4). */
export function WorkspacesDialog({ onClose }: { onClose: () => void }) {
  const { attempt, toast, projects, settings, setSettings, reloadAll } =
    useApp();
  const { list, reload } = useWorkspaces();
  const [making, setMaking] = useState<{ folder: string; name: string } | null>(
    null,
  );
  const [name, setName] = useState(settings.displayName);
  const [share, setShare] = useState<Record<string, string>>({});
  const [password, setPassword] = useState<Record<string, string>>({});
  const [recovering, setRecovering] = useState<{
    folder: string;
    password: string;
  } | null>(null);
  const shared = new Set(list.flatMap((w) => w.projects.map((p) => p.id)));
  const pick = async () =>
    attempt(() => window.worksync.chooseWorkspaceFolder());
  const done = async () => {
    await reload();
    wsChanged();
  };
  const saveName = async () => {
    const s = await attempt(() =>
      window.worksync.updateSettings({ displayName: name.trim() }),
    );
    if (s) {
      setSettings(s);
      toast(tr('Saved.'));
    }
  };
  return (
    <Modal
      title={tr('Workspaces')}
      subtitle={tr(
        'Work on the same projects with people on the same network, through a folder on the shared drive. No server and no passwords: each PC has its own key, and a member lets a new PC in after checking a 6-digit code.',
      )}
      onClose={onClose}
      wide
    >
      <div className="ws-dialog">
        <div className="set-row">
          <span>
            <b>{tr('Your name')}</b>
            <small>
              {tr(
                'How others in a workspace see you. Your Windows account and PC name are shown with it.',
              )}
            </small>
          </span>
          <span className="ws-inline">
            <input
              className="inp"
              aria-label={tr('Your name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button className="btn" onClick={() => void saveName()}>
              {tr('Save')}
            </button>
          </span>
        </div>
        <div className="row-acts ws-top">
          <button
            className="btn primary"
            onClick={() =>
              void pick().then((f) => f && setMaking({ folder: f, name: '' }))
            }
          >
            <Icon name="plus" />
            {tr('Create a workspace')}
          </button>
          <button
            className="btn"
            onClick={() =>
              void pick().then(
                (f) =>
                  f &&
                  void attempt(() => window.worksync.joinWorkspace(f)).then(
                    (w) => {
                      if (w) {
                        toast(
                          tr('Asked to join. Tell a member the code {code}.', {
                            code: w.code ?? '',
                          }),
                        );
                        void done();
                      }
                    },
                  ),
              )
            }
          >
            <Icon name="users" />
            {tr('Join a workspace')}
          </button>
          <button
            className="btn"
            onClick={() =>
              void pick().then(
                (f) => f && setRecovering({ folder: f, password: '' }),
              )
            }
          >
            {tr('Join with a recovery file')}
          </button>
          <span className="grow" />
          <button
            className="btn"
            onClick={() =>
              void attempt(() => window.worksync.syncNow()).then(async () => {
                await done();
                await reloadAll();
                workChanged();
              })
            }
          >
            <Icon name="refresh" />
            {tr('Sync now')}
          </button>
        </div>
        {making && (
          <form
            className="ws-card form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void attempt(() =>
                window.worksync.createWorkspace(making.folder, making.name),
              ).then((w) => {
                if (w) {
                  setMaking(null);
                  toast(
                    tr(
                      'Made the workspace {name}. Share projects in it, and let people in.',
                      { name: w.name },
                    ),
                  );
                  void done();
                }
              });
            }}
          >
            <b>{tr('New workspace in {folder}', { folder: making.folder })}</b>
            <label>
              {tr('Name')}
              <input
                className="inp"
                value={making.name}
                autoFocus
                onChange={(e) => setMaking({ ...making, name: e.target.value })}
              />
            </label>
            <div className="row-acts">
              <button
                type="button"
                className="btn"
                onClick={() => setMaking(null)}
              >
                {tr('Cancel')}
              </button>
              <button className="btn primary" type="submit">
                {tr('Create')}
              </button>
            </div>
          </form>
        )}
        {recovering && (
          <form
            className="ws-card form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void attempt(() =>
                window.worksync.joinWithRecovery(
                  recovering.folder,
                  recovering.password,
                ),
              ).then((w) => {
                if (w) {
                  setRecovering(null);
                  toast(
                    tr('You are in the workspace {name}.', { name: w.name }),
                  );
                  void done();
                }
              });
            }}
          >
            <b>
              {tr('Join {folder} with a recovery file', {
                folder: recovering.folder,
              })}
            </b>
            <label>
              {tr('The recovery file’s password')}
              <input
                className="inp"
                type="password"
                autoFocus
                value={recovering.password}
                onChange={(e) =>
                  setRecovering({ ...recovering, password: e.target.value })
                }
              />
            </label>
            <div className="row-acts">
              <button
                type="button"
                className="btn"
                onClick={() => setRecovering(null)}
              >
                {tr('Cancel')}
              </button>
              <button className="btn primary" type="submit">
                {tr('Choose the file and join')}
              </button>
            </div>
          </form>
        )}
        {list.map((w) => (
          <section key={w.id} className="ws-card" aria-label={w.name}>
            <div className="ws-card-head">
              <Icon name="users" />
              <b className="grow">{w.name}</b>
              <WsState w={w} />
            </div>
            <small className="muted mono">{w.folder}</small>
            {w.problem && !w.online && (
              <div className="keepnote warn">
                <Icon name="alert" />
                {msg(w.problem)}
              </div>
            )}
            {w.update && (
              <div className="keepnote">
                <Icon name="download" />
                {tr(
                  'A newer WorkSync ({version}) is in the workspace folder.',
                  { version: w.update.version },
                )}
                <button
                  className="linkbtn"
                  onClick={() =>
                    void attempt(() =>
                      window.worksync.showWorkspaceUpdate(w.id),
                    )
                  }
                >
                  {tr('Show it')}
                </button>
              </div>
            )}
            {w.state === 'pending' && (
              <div className="ws-pending">
                <p>
                  {tr(
                    'Tell a member of the workspace this code. They check it with you and let you in.',
                  )}
                </p>
                <span className="ws-code big">{w.code}</span>
                <button
                  className="btn"
                  onClick={() =>
                    void attempt(() =>
                      window.worksync.forgetWorkspace(w.id),
                    ).then(() => void done())
                  }
                >
                  {tr('Cancel the request')}
                </button>
              </div>
            )}
            {w.state === 'declined' && (
              <button
                className="btn"
                onClick={() =>
                  void attempt(() =>
                    window.worksync.forgetWorkspace(w.id),
                  ).then(() => void done())
                }
              >
                {tr('Forget it')}
              </button>
            )}
            {w.state === 'member' && (
              <>
                <h3 className="k">{tr('Shared projects')}</h3>
                <ul className="ws-projects">
                  {w.projects.map((p) => (
                    <li key={p.id}>{p.local ? p.name : tr('Arriving…')}</li>
                  ))}
                  {!w.projects.length && (
                    <li className="muted">{tr('None yet.')}</li>
                  )}
                </ul>
                <div className="ws-inline">
                  <select
                    className="inp"
                    aria-label={tr('Project to share')}
                    value={share[w.id] ?? ''}
                    onChange={(e) =>
                      setShare({ ...share, [w.id]: e.target.value })
                    }
                  >
                    <option value="">{tr('Share a project…')}</option>
                    {projects
                      .filter((p) => !shared.has(p.id))
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                  <button
                    className="btn"
                    disabled={!share[w.id]}
                    onClick={() =>
                      void attempt(() =>
                        window.worksync.shareProject(w.id, share[w.id]),
                      ).then(() => {
                        toast(
                          tr('Shared. Every member of {name} sees it.', {
                            name: w.name,
                          }),
                        );
                        setShare({ ...share, [w.id]: '' });
                        void done();
                      })
                    }
                  >
                    {tr('Share the project')}
                  </button>
                </div>
                <p className="muted ws-note">
                  {tr(
                    'Shared: tickets, situations, difficulties, tasks, discussions, people, glossary and releases. Stays on your PC: your notes on a ticket, your next action, your priority, pins, My tasks, settings, and the link to the customer’s file.',
                  )}
                </p>
                <h3 className="k">{tr('Members')}</h3>
                <Members w={w} />
                <div className="set-row">
                  <span>
                    <b>{tr('Work offline')}</b>
                    <small>
                      {tr(
                        'Keep working on this PC; changes wait and are sent when you turn this off.',
                      )}
                    </small>
                  </span>
                  <button
                    className="switch"
                    role="switch"
                    aria-checked={w.offline}
                    title={
                      w.offline
                        ? tr('On. Click to turn it off.')
                        : tr('Off. Click to turn it on.')
                    }
                    aria-label={tr('Work offline')}
                    onClick={() =>
                      void attempt(() =>
                        window.worksync.setWorkspaceOffline(w.id, !w.offline),
                      ).then(() => void done())
                    }
                  >
                    <span />
                  </button>
                </div>
                <div className="set-row">
                  <span>
                    <b>{tr('Recovery file')}</b>
                    <small>
                      {tr(
                        'If every member’s PC is gone, a recovery file lets a new PC in on its own. Keep it on a USB stick or another safe place, with its password.',
                      )}
                    </small>
                  </span>
                  <span className="ws-inline">
                    <input
                      className="inp"
                      type="password"
                      aria-label={tr('Password for the recovery file')}
                      placeholder={tr('Password (8+ characters)')}
                      value={password[w.id] ?? ''}
                      onChange={(e) =>
                        setPassword({ ...password, [w.id]: e.target.value })
                      }
                    />
                    <button
                      className="btn"
                      onClick={() =>
                        void attempt(() =>
                          window.worksync.saveRecoveryFile(
                            w.id,
                            password[w.id] ?? '',
                          ),
                        ).then(
                          (ok) =>
                            ok &&
                            toast(
                              tr(
                                'Saved the recovery file. Keep it and its password safe.',
                              ),
                            ),
                        )
                      }
                    >
                      {tr('Save a recovery file')}
                    </button>
                  </span>
                </div>
                {w.problems.length > 0 && (
                  <details className="keepnote warn">
                    <summary>
                      {tr(
                        'Problems: {n} files not signed by a member are ignored',
                        { n: w.problems.length },
                      )}
                    </summary>
                    <ul className="mono">
                      {w.problems.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </details>
                )}
                <div className="row-acts">
                  <button
                    className="btn danger-text"
                    onClick={() =>
                      void confirmDelete({
                        title: tr('Leave {name}?', { name: w.name }),
                        text: tr(
                          'Its shared projects stay on this PC as local copies, no longer synced.',
                        ),
                        yes: tr('Leave'),
                      }).then(
                        (ok) =>
                          ok &&
                          void attempt(() =>
                            window.worksync.leaveWorkspace(w.id),
                          ).then(() => void done()),
                      )
                    }
                  >
                    {tr('Leave the workspace')}
                  </button>
                </div>
              </>
            )}
          </section>
        ))}
        {!list.length && !making && (
          <p className="muted">
            {tr(
              'You are not in a workspace. Projects stay on this PC only. Create a workspace in a folder on the shared drive, or join one a colleague made.',
            )}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** "Tanaka has this ticket open": a hint only; nothing is locked (doc 08, 3.9). */
export function OpenByOthers({
  projectId,
  label,
}: {
  projectId: string;
  label: string;
}) {
  const { list } = useWorkspaces();
  const w = list.find((x) => x.projects.some((p) => p.id === projectId));
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    if (!w) return;
    let live = true;
    const load = () =>
      void window.worksync
        .workspaceMembers(w.id)
        .then(
          (ms) =>
            live &&
            setNames(
              ms
                .filter(
                  (m) =>
                    !m.me && m.pcs.some((p) => p.online && p.viewing === label),
                )
                .map((m) => `${m.name} ·${m.tag}`),
            ),
        )
        .catch(() => undefined);
    load();
    const t = window.setInterval(load, 15000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [w?.id, label]);
  if (!names.length) return null;
  return (
    <span
      className="chip ws-open"
      title={tr('A hint only; nothing is locked.')}
    >
      <Icon name="eye" />
      {tr('{who} has this ticket open', { who: names.join(', ') })}
    </span>
  );
}
