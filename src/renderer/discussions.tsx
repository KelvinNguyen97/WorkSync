import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  canEdit,
  MAX_ATTACHMENT_BYTES,
  readActionItem,
  readSummaryAnswer,
  type AttachmentInfo,
  type Comment,
  type Discussion,
  type SummaryAnswer,
  type SummaryBatch,
} from '../shared/discussions';
import { shortDate, type Task } from '../shared/model';
import type { Member } from '../shared/work';
import { useApp } from './appState';
import { Icon } from './Icon';
import { tr } from './i18n';
import { confirmDelete, Modal, StatusChip } from './parts';
import { RichEditor, RichText } from './rich';
import {
  MemberChip,
  TicketTasks,
  trWork,
  useMembers,
  workChanged,
} from './work';

/** Discussions of a project (or all), kept current. */
export function useDiscussions(projectId?: string) {
  const [list, setList] = useState<Discussion[]>([]);
  const load = useCallback(async () => {
    try {
      setList(await window.worksync.listDiscussions(projectId));
    } catch {
      setList([]);
    }
  }, [projectId]);
  useEffect(() => {
    void load();
    const on = () => void load();
    window.addEventListener('worksync:work-changed', on);
    return () => window.removeEventListener('worksync:work-changed', on);
  }, [load]);
  return list;
}

const when = (iso: string) =>
  iso.slice(0, 16).replace('T', ' ').replaceAll('-', '/');

/** A small question with two answers, such as "Link them?". */
function Ask({
  title,
  text,
  yes,
  no,
  onYes,
  onNo,
}: {
  title: string;
  text: string;
  yes: string;
  no: string;
  onYes: () => void;
  onNo: () => void;
}) {
  return (
    <Modal
      title={title}
      subtitle={text}
      onClose={onNo}
      narrow
      footer={
        <>
          <button className="btn" onClick={onNo}>
            {no}
          </button>
          <button className="btn primary" onClick={onYes}>
            <Icon name="link" />
            {yes}
          </button>
        </>
      }
    >
      <></>
    </Modal>
  );
}

/** New discussion: a title, an optional No. and a description. */
function NewDiscussion({
  projectId,
  onClose,
  onMade,
}: {
  projectId: string;
  onClose: () => void;
  onMade: (d: Discussion) => void;
}) {
  const { attempt } = useApp();
  const [v, setV] = useState({ title: '', no: '', description: '' });
  const [offer, setOffer] = useState<{
    id: string;
    no: string;
    title: string;
  } | null>(null);
  const make = async (link: boolean) => {
    const d = await attempt(() =>
      window.worksync.saveDiscussion(projectId, {
        title: v.title,
        no: link ? '' : v.no,
        description: v.description,
      }),
    );
    if (!d) return;
    const linked =
      link && offer
        ? await attempt(() => window.worksync.linkDiscussion(d.id, offer.id))
        : d;
    workChanged();
    onMade(linked ?? d);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (v.no.trim()) {
      const p = await attempt(() =>
        window.worksync.progressWithNo(projectId, v.no.trim()),
      );
      if (p && !p.linked) {
        setOffer(p);
        return;
      }
    }
    await make(false);
  };
  return (
    <Modal
      title={tr('New discussion')}
      subtitle={tr(
        'A ticket to talk a topic through: comments, mentions and files. Give it the No. of a progress ticket to link them.',
      )}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn primary" type="submit" form="dc-new">
            <Icon name="plus" />
            {tr('Make the discussion')}
          </button>
        </>
      }
    >
      <form id="dc-new" className="form" onSubmit={(e) => void submit(e)}>
        <label>
          {tr('Title')}
          <input
            className="inp"
            value={v.title}
            onChange={(e) => setV({ ...v, title: e.target.value })}
          />
        </label>
        <label>
          {tr('No. (optional)')}
          <input
            className="inp"
            value={v.no}
            onChange={(e) => setV({ ...v, no: e.target.value })}
          />
        </label>
        <div className="lbl-block">
          <span>{tr('Description')}</span>
          <RichEditor
            label={tr('Description')}
            rows={5}
            value={v.description}
            onChange={(description) => setV({ ...v, description })}
          />
        </div>
      </form>
      {offer && (
        <Ask
          title={tr('Link them?')}
          text={tr(
            'Progress ticket {no} “{title}” has this number. Link them?',
            {
              no: offer.no,
              title: offer.title,
            },
          )}
          yes={tr('Link')}
          no={tr('Use another number')}
          onYes={() => void make(true)}
          onNo={() => setOffer(null)}
        />
      )}
    </Modal>
  );
}

type DFilter = 'open' | 'resolved' | 'all' | 'linked' | 'fresh';

/** The Discussions list of a project (doc 09). */
export function DiscussionsView({
  projectId,
  query,
  header,
  openTicket,
}: {
  projectId: string;
  query: string;
  header: (title: string, subtitle: string, right?: ReactNode) => ReactNode;
  openTicket: (id: string) => void;
}) {
  const { project, tasks } = useApp();
  const list = useDiscussions(projectId);
  const members = useMembers(projectId);
  const [filter, setFilter] = useState<DFilter>('open');
  const [openId, setOpenId] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [updating, setUpdating] = useState<string[] | null>(null);
  const q = query.trim().toLowerCase();
  const progressNos = new Map(
    tasks
      .filter((t) => t.projectId === projectId)
      .map((t) => [t.customerId, t]),
  );
  const pending = list.filter((d) => d.linkedTaskId && d.newSinceSummary > 0);
  const shown = list.filter(
    (d) =>
      (filter === 'all' ||
        (filter === 'open' && d.state === 'open') ||
        (filter === 'resolved' && d.state === 'resolved') ||
        (filter === 'linked' && !!d.linkedTaskId) ||
        (filter === 'fresh' && d.linkedTaskId && d.newSinceSummary > 0)) &&
      (!q || `${d.no} ${d.title} ${d.description}`.toLowerCase().includes(q)),
  );
  const chips: [DFilter, string, number][] = [
    ['open', 'Open', list.filter((d) => d.state === 'open').length],
    ['resolved', 'Resolved', list.filter((d) => d.state === 'resolved').length],
    ['linked', 'Linked', list.filter((d) => d.linkedTaskId).length],
    ['fresh', 'New since summary', pending.length],
    ['all', 'All', list.length],
  ];
  return (
    <div className="dc-page">
      {header(
        tr('Discussions'),
        tr('{name} · talk tickets through; reports use progress tickets only', {
          name: project(projectId)?.name ?? '',
        }),
        <div className="vh-actions">
          <button
            className="btn"
            disabled={!pending.length}
            onClick={() => setUpdating(pending.map((d) => d.id))}
            title={tr(
              'Linked discussions with comments since their last summary',
            )}
          >
            <Icon name="spark" />
            {tr('Update progress from discussions ({n})', {
              n: pending.length,
            })}
          </button>
          <button className="btn primary" onClick={() => setMaking(true)}>
            <Icon name="plus" />
            {tr('New discussion')}
          </button>
        </div>,
      )}
      <div className="mt-chips" role="group" aria-label={tr('Show')}>
        {chips.map(([k, l, n]) => (
          <button
            key={k}
            className="qchip"
            aria-pressed={filter === k}
            onClick={() => setFilter(k)}
          >
            {tr(l)} <b>{n}</b>
          </button>
        ))}
      </div>
      <div className="dc-list" role="list">
        {shown.map((d) => {
          const twin =
            !d.linkedTaskId && d.no ? progressNos.get(d.no) : undefined;
          return (
            <button
              key={d.id}
              role="listitem"
              className={`dc-row ${d.state}`}
              onClick={() => setOpenId(d.id)}
            >
              <span className="dc-ico">
                <Icon name="chat" />
              </span>
              <span className="mono dc-no">{d.no || '—'}</span>
              <span className="dc-title">
                <b>{d.title}</b>
                <small className="muted">
                  {tr('{n} comments', { n: d.commentCount })}
                  {d.linkedTaskId &&
                    d.newSinceSummary > 0 &&
                    ` · ${tr('{n} new since the last summary', { n: d.newSinceSummary })}`}
                  {' · '}
                  <MemberChip id={d.madeBy} members={members} />
                </small>
              </span>
              <span className="dc-link">
                {d.linkedTaskId ? (
                  <span className="chip ok">
                    <Icon name="link" />
                    {tr('Progress {no}', { no: d.no })}
                  </span>
                ) : twin ? (
                  <span className="chip warn">
                    {tr('Link with {no}?', { no: d.no })}
                  </span>
                ) : null}
              </span>
              <span className={`chip ${d.state === 'open' ? '' : 'muted'}`}>
                {tr(d.state === 'open' ? 'Open' : 'Resolved')}
              </span>
            </button>
          );
        })}
        {!shown.length && (
          <div className="empty">
            <b>
              {list.length
                ? tr('No discussion matches.')
                : tr('No discussions yet.')}
            </b>
            {!list.length && (
              <p className="muted">
                {tr(
                  'Make one to talk a topic through. Link it to a progress ticket by giving it the same No., then press Summarize to bring the progress up to date.',
                )}
              </p>
            )}
          </div>
        )}
      </div>
      {making && (
        <NewDiscussion
          projectId={projectId}
          onClose={() => setMaking(false)}
          onMade={(d) => {
            setMaking(false);
            setOpenId(d.id);
          }}
        />
      )}
      {openId && (
        <DiscussionWindow
          id={openId}
          onClose={() => setOpenId(null)}
          openTicket={(id) => {
            setOpenId(null);
            openTicket(id);
          }}
          onSummarize={(id) => setUpdating([id])}
        />
      )}
      {updating && (
        <SummarizeDialog
          ids={updating}
          projectId={projectId}
          onClose={() => setUpdating(null)}
        />
      )}
    </div>
  );
}

function Thumb({ a }: { a: AttachmentInfo }) {
  const { attempt } = useApp();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!a.type.startsWith('image/')) return;
    let u: string | null = null;
    void window.worksync
      .getAttachment(a.id)
      .then((f) => {
        u = URL.createObjectURL(
          new Blob([f.data as BlobPart], { type: f.type }),
        );
        setUrl(u);
      })
      .catch(() => undefined);
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [a.id, a.type]);
  const size =
    a.size > 1024 * 1024
      ? `${(a.size / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(a.size / 1024))} KB`;
  return (
    <span className="dc-file">
      {url ? (
        <button
          className="dc-thumb"
          title={tr('Open {name}', { name: a.name })}
          onClick={() =>
            void attempt(() => window.worksync.openAttachment(a.id))
          }
        >
          <img src={url} alt={a.name} />
        </button>
      ) : (
        <button
          className="btn sm"
          onClick={() =>
            void attempt(() => window.worksync.openAttachment(a.id))
          }
        >
          <Icon name="attach" />
          {a.name} <span className="muted">{size}</span>
        </button>
      )}
      <button
        className="icon-btn"
        aria-label={tr('Save {name}', { name: a.name })}
        title={tr('Save a copy')}
        onClick={() => void attempt(() => window.worksync.saveAttachment(a.id))}
      >
        <Icon name="download" />
      </button>
    </span>
  );
}

/** The discussion ticket window (doc 09, 7). */
export function DiscussionWindow({
  id,
  onClose,
  openTicket,
  onSummarize,
}: {
  id: string;
  onClose: () => void;
  openTicket: (taskId: string) => void;
  onSummarize: (id: string) => void;
}) {
  const { attempt, toast, tasks, now, project, reloadTasks } = useApp();
  const [d, setD] = useState<Discussion | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [history, setHistory] = useState<
    { id: string; at: string; by: string; text: string }[]
  >([]);
  const members = useMembers(d?.projectId ?? null);
  const [decisionsOnly, setDecisionsOnly] = useState(false);
  const [reply, setReply] = useState<Comment | null>(null);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(
    null,
  );
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [edit, setEdit] = useState<{
    title: string;
    description: string;
    no: string;
  } | null>(null);
  const [offer, setOffer] = useState<{
    id: string;
    no: string;
    title: string;
  } | null>(null);
  const [linking, setLinking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const load = useCallback(async () => {
    try {
      const [x, c, h] = await Promise.all([
        window.worksync
          .listDiscussions()
          .then((l) => l.find((y) => y.id === id) ?? null),
        window.worksync.listComments(id),
        window.worksync.workHistory(id),
      ]);
      setD(x);
      setComments(c);
      setHistory(h);
    } catch {
      setD(null);
    }
  }, [id]);
  useEffect(() => {
    void load();
    const on = () => void load();
    window.addEventListener('worksync:work-changed', on);
    return () => window.removeEventListener('worksync:work-changed', on);
  }, [load]);
  const me = members.find((m) => m.me)?.id ?? '';
  const linked = d?.linkedTaskId
    ? tasks.find((t) => t.id === d.linkedTaskId)
    : undefined;
  const twin = useMemo(
    () =>
      d && !d.linkedTaskId && d.no
        ? tasks.find(
            (t) => t.projectId === d.projectId && t.customerId === d.no,
          )
        : undefined,
    [d, tasks],
  );
  if (!d)
    return (
      <Modal title={tr('Discussion')} onClose={onClose}>
        <p className="muted">{tr('This discussion no longer exists.')}</p>
      </Modal>
    );
  const top = comments.filter((c) => !c.parentId);
  const repliesOf = (c: Comment) => comments.filter((x) => x.parentId === c.id);
  const isNew = (c: Comment) =>
    !!d.summarizedUpto &&
    (c.createdAt > d.summarizedUpto ||
      (!!c.editedAt && c.editedAt > d.summarizedUpto));
  const firstNew = d.summarizedUpto
    ? comments.find((c) => !c.deleted && isNew(c))?.id
    : undefined;
  const addFiles = (list: FileList | File[] | null) => {
    const add = [...(list ?? [])];
    const big = add.find((f) => f.size > MAX_ATTACHMENT_BYTES);
    if (big) {
      toast(tr('{name} is larger than 25 MB.', { name: big.name }));
      return;
    }
    setFiles((x) => [...x, ...add]);
  };
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() && !files.length) {
      boxRef.current?.focus();
      return;
    }
    const payload = await Promise.all(
      files.map(async (f) => ({
        name: f.name || 'pasted image.png',
        type: f.type,
        bytes: new Uint8Array(await f.arrayBuffer()),
      })),
    );
    const c = await attempt(() =>
      window.worksync.addComment(d.id, {
        body: text,
        parentId: reply?.id ?? null,
        files: payload,
      }),
    );
    if (!c) return;
    setText('');
    setFiles([]);
    setReply(null);
    workChanged();
  };
  const saveEdit = async () => {
    if (!edit) return;
    if (edit.no.trim() !== d.no && !d.linkedTaskId && edit.no.trim()) {
      const p = await attempt(() =>
        window.worksync.progressWithNo(d.projectId, edit.no.trim()),
      );
      if (p && !p.linked) {
        setOffer(p);
        return;
      }
    }
    const x = await attempt(() =>
      window.worksync.saveDiscussion(
        d.projectId,
        {
          title: edit.title,
          description: edit.description,
          ...(d.linkedTaskId ? {} : { no: edit.no }),
        },
        d.id,
      ),
    );
    if (x) {
      setEdit(null);
      workChanged();
    }
  };
  const link = async (taskId: string) => {
    const x = await attempt(() => window.worksync.linkDiscussion(d.id, taskId));
    if (x) {
      setOffer(null);
      setEdit(null);
      setLinking(false);
      workChanged();
      toast(
        tr('Linked. Press Summarize to bring the progress ticket up to date.'),
      );
    }
  };
  const makeProgress = async () => {
    const r = await attempt(() =>
      window.worksync.makeProgressFromDiscussion(d.id),
    );
    if (r) {
      workChanged();
      await reloadTasks();
      toast(
        tr('Made progress ticket {no} and linked it.', {
          no: r.task.customerId,
        }),
      );
      onSummarize(d.id);
    }
  };
  const name = (memberId: string) => {
    const m = members.find((x) => x.id === memberId);
    return m ? (m.me ? tr('You') : `${m.name} ·${m.tag}`) : tr('someone');
  };
  const one = (c: Comment, isReply: boolean) => (
    <div
      key={c.id}
      className={`dc-c ${isReply ? 'reply' : ''} ${c.decision ? 'decision' : ''}`}
    >
      {c.id === firstNew && (
        <div className="dc-new-line" role="separator">
          {tr('New since the last summary')}
        </div>
      )}
      <div className="dc-c-head">
        <MemberChip id={c.author} members={members} />
        <span className="muted mono">{when(c.createdAt)}</span>
        {c.editedAt && !c.deleted && (
          <span className="muted">{tr('edited')}</span>
        )}
        {c.decision && (
          <span className="chip ok">
            <Icon name="check" />
            {tr('Decision')}
          </span>
        )}
        <span className="grow" />
        {!c.deleted && (
          <>
            {!isReply && (
              <button
                className="linkbtn"
                onClick={() => {
                  setReply(c);
                  boxRef.current?.focus();
                }}
              >
                {tr('Reply')}
              </button>
            )}
            <button
              className="linkbtn"
              onClick={() =>
                void attempt(() =>
                  window.worksync.setDecision(c.id, !c.decision),
                ).then((x) => x && workChanged())
              }
            >
              {c.decision ? tr('Not a decision') : tr('Mark as decision')}
            </button>
            {c.author === me && canEdit(c, now) && (
              <button
                className="linkbtn"
                onClick={() => setEditing({ id: c.id, body: c.body })}
              >
                {tr('Edit')}
              </button>
            )}
            {c.author === me && (
              <button
                className="linkbtn danger-text"
                onClick={() =>
                  void confirmDelete({
                    title: tr('Delete this comment?'),
                    text: tr('Others see that a comment was deleted.'),
                    yes: tr('Delete'),
                  }).then(
                    (ok) =>
                      ok &&
                      void attempt(() =>
                        window.worksync.deleteComment(c.id),
                      ).then((x) => x && workChanged()),
                  )
                }
              >
                {tr('Delete')}
              </button>
            )}
          </>
        )}
      </div>
      {c.deleted ? (
        <div className="dc-body muted">{tr('This comment was deleted.')}</div>
      ) : editing?.id === c.id ? (
        <div className="dc-editing">
          <RichEditor
            label={tr('Comment')}
            rows={3}
            value={editing.body}
            onChange={(body) => setEditing({ ...editing, body })}
          />
          <div className="row-acts">
            <button className="btn" onClick={() => setEditing(null)}>
              {tr('Cancel')}
            </button>
            <button
              className="btn primary"
              onClick={() =>
                void attempt(() =>
                  window.worksync.editComment(c.id, editing.body),
                ).then((x) => {
                  if (x) {
                    setEditing(null);
                    workChanged();
                  }
                })
              }
            >
              {tr('Save')}
            </button>
          </div>
        </div>
      ) : (
        <RichText className="dc-body" text={c.body} mentions={members} />
      )}
      {!c.deleted && c.attachments.length > 0 && (
        <div className="dc-files">
          {c.attachments.map((a) => (
            <Thumb key={a.id} a={a} />
          ))}
        </div>
      )}
    </div>
  );
  const visibleTop = decisionsOnly
    ? top.filter((c) => c.decision || repliesOf(c).some((r) => r.decision))
    : top;
  return (
    <Modal
      title={`${d.no ? `${d.no} · ` : ''}${d.title}`}
      subtitle={`${tr('Discussion')} · ${project(d.projectId)?.name ?? ''}`}
      onClose={onClose}
      wide
    >
      <div className="dc-win">
        <div className="dc-bar">
          <div
            className="dc-bar-group"
            role="group"
            aria-label={tr('Progress ticket')}
          >
            {linked ? (
              <>
                <button
                  className="dc-linkbar"
                  onClick={() => openTicket(linked.id)}
                >
                  <Icon name="menu" />
                  {tr('Progress {no}', { no: linked.customerId })} ·{' '}
                  <StatusChip status={linked.status} />
                  <span className="muted">
                    {d.summarizedAt
                      ? tr('summarized {date}', {
                          date: shortDate(d.summarizedAt.slice(0, 10)),
                        })
                      : tr('not summarized yet')}
                  </span>
                </button>
                <button
                  className="btn primary"
                  onClick={() => onSummarize(d.id)}
                >
                  <Icon name="spark" />
                  {tr('Summarize into progress')}
                  {d.newSinceSummary > 0 && <b> · {d.newSinceSummary}</b>}
                </button>
                <button
                  className="btn"
                  onClick={() =>
                    void attempt(() =>
                      window.worksync.unlinkDiscussion(d.id),
                    ).then((x) => x && workChanged())
                  }
                >
                  {tr('Unlink')}
                </button>
              </>
            ) : (
              <>
                {twin && (
                  <button
                    className="btn primary"
                    onClick={() => void link(twin.id)}
                  >
                    <Icon name="link" />
                    {tr('Link with {no}?', { no: twin.customerId })}
                  </button>
                )}
                <button className="btn" onClick={() => setLinking(true)}>
                  <Icon name="link" />
                  {tr('Link a progress ticket…')}
                </button>
                <button className="btn" onClick={() => void makeProgress()}>
                  <Icon name="plus" />
                  {tr('Make a progress ticket')}
                </button>
              </>
            )}
          </div>
          <div
            className="dc-bar-group end"
            role="group"
            aria-label={tr('This discussion')}
          >
            <button
              className="btn"
              onClick={() =>
                void attempt(() =>
                  window.worksync.saveDiscussion(
                    d.projectId,
                    { state: d.state === 'open' ? 'resolved' : 'open' },
                    d.id,
                  ),
                ).then((x) => x && workChanged())
              }
            >
              <Icon name={d.state === 'open' ? 'check' : 'refresh'} />
              {d.state === 'open' ? tr('Mark as resolved') : tr('Open again')}
            </button>
            <button
              className="icon-btn"
              aria-label={tr('Edit')}
              title={tr('Edit the title, No. and description')}
              onClick={() =>
                setEdit({
                  title: d.title,
                  description: d.description,
                  no: d.no,
                })
              }
            >
              <Icon name="edit" />
            </button>
            <button
              className="icon-btn"
              aria-label={tr('Delete')}
              title={tr('Delete')}
              onClick={() =>
                void confirmDelete({
                  title: tr('Delete “{title}”?', { title: d.title }),
                  text: tr(
                    'The discussion is deleted with its comments and files. A linked progress ticket stays.',
                  ),
                  yes: tr('Delete'),
                }).then(
                  (ok) =>
                    ok &&
                    void attempt(() =>
                      window.worksync.deleteDiscussion(d.id),
                    ).then((x) => {
                      if (x) {
                        workChanged();
                        onClose();
                      }
                    }),
                )
              }
            >
              <Icon name="trash" />
            </button>
          </div>
        </div>
        {edit ? (
          <div className="form dc-editform">
            <label>
              {tr('Title')}
              <input
                className="inp"
                value={edit.title}
                onChange={(e) => setEdit({ ...edit, title: e.target.value })}
              />
            </label>
            <label>
              {tr('No.')}
              <input
                className="inp"
                value={edit.no}
                disabled={!!d.linkedTaskId}
                title={
                  d.linkedTaskId
                    ? tr(
                        'A linked discussion has its progress ticket’s number.',
                      )
                    : undefined
                }
                onChange={(e) => setEdit({ ...edit, no: e.target.value })}
              />
            </label>
            <div className="lbl-block">
              <span>{tr('Description')}</span>
              <RichEditor
                label={tr('Description')}
                rows={5}
                value={edit.description}
                onChange={(description) => setEdit({ ...edit, description })}
              />
            </div>
            <div className="row-acts">
              <button className="btn" onClick={() => setEdit(null)}>
                {tr('Cancel')}
              </button>
              <button className="btn primary" onClick={() => void saveEdit()}>
                {tr('Save')}
              </button>
            </div>
          </div>
        ) : (
          d.description && (
            <div className="dc-desc">
              <RichText text={d.description} />
            </div>
          )
        )}
        <div className="dc-columns">
          <div className="dc-stream">
            <div className="dc-stream-head">
              <h3 className="k">
                {tr('Comments')} <span className="muted">{d.commentCount}</span>
              </h3>
              <label className="check">
                <input
                  type="checkbox"
                  checked={decisionsOnly}
                  onChange={(e) => setDecisionsOnly(e.target.checked)}
                />
                {tr('Decisions only')}
              </label>
            </div>
            {visibleTop.map((c) => (
              <div key={c.id} className="dc-thread">
                {one(c, false)}
                {repliesOf(c)
                  .filter((r) => !decisionsOnly || r.decision)
                  .map((r) => one(r, true))}
              </div>
            ))}
            {!top.length && (
              <div className="muted">
                {tr('No comments yet. Write the first one below.')}
              </div>
            )}
            <form
              className="dc-box"
              onSubmit={(e) => void send(e)}
              onDragOver={(e: DragEvent) => e.preventDefault()}
              onDrop={(e: DragEvent) => {
                e.preventDefault();
                addFiles(e.dataTransfer.files);
              }}
            >
              {reply && (
                <div className="dc-replying">
                  {tr('Reply to {who}', { who: name(reply.author) })}
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={tr('Cancel the reply')}
                    onClick={() => setReply(null)}
                  >
                    <Icon name="x" />
                  </button>
                </div>
              )}
              <RichEditor
                inputRef={boxRef}
                rows={3}
                label={tr('Comment')}
                placeholder={tr(
                  'Write a comment… @name to mention a member. Paste or drop images and files.',
                )}
                value={text}
                onChange={setText}
                onPaste={(e: ClipboardEvent) => {
                  const f = [...e.clipboardData.files];
                  if (f.length) {
                    e.preventDefault();
                    addFiles(f);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey))
                    void send(e);
                }}
              />
              {files.length > 0 && (
                <div className="dc-pending">
                  {files.map((f, i) => (
                    <span key={i} className="chip">
                      <Icon name="attach" />
                      {f.name || tr('pasted image')}
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={tr('Remove {name}', { name: f.name })}
                        onClick={() =>
                          setFiles(files.filter((_, j) => j !== i))
                        }
                      >
                        <Icon name="x" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="row-acts">
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    addFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => fileRef.current?.click()}
                >
                  <Icon name="attach" />
                  {tr('Attach')}
                </button>
                <span className="grow muted">{tr('Ctrl+Enter sends')}</span>
                <button className="btn primary" type="submit">
                  {tr('Send')}
                </button>
              </div>
            </form>
          </div>
          <div className="dc-side">
            <TicketTasks projectId={d.projectId} discussionId={d.id} />
            <section aria-label={tr('Watchers')}>
              <h3 className="k">{tr('Watchers')}</h3>
              <div className="dc-watchers">
                {d.watchers.map((w) => (
                  <MemberChip key={w} id={w} members={members} />
                ))}
              </div>
              {me && (
                <button
                  className="linkbtn"
                  onClick={() =>
                    void attempt(() =>
                      window.worksync.saveDiscussion(
                        d.projectId,
                        {
                          watchers: d.watchers.includes(me)
                            ? d.watchers.filter((w) => w !== me)
                            : [...d.watchers, me],
                        },
                        d.id,
                      ),
                    ).then((x) => x && workChanged())
                  }
                >
                  {d.watchers.includes(me) ? tr('Stop watching') : tr('Watch')}
                </button>
              )}
            </section>
            {history.length > 0 && (
              <details className="wk-history">
                <summary>{tr('History')}</summary>
                <ul>
                  {history.map((h) => (
                    <li key={h.id}>
                      <span className="mono">{when(h.at)}</span>{' '}
                      <b>{name(h.by)}</b> {trWork(h.text)}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </div>
      </div>
      {offer && (
        <Ask
          title={tr('Link them?')}
          text={tr(
            'Progress ticket {no} “{title}” has this number. Link them?',
            {
              no: offer.no,
              title: offer.title,
            },
          )}
          yes={tr('Link')}
          no={tr('Use another number')}
          onYes={() => void link(offer.id)}
          onNo={() => setOffer(null)}
        />
      )}
      {linking && (
        <LinkPicker
          projectId={d.projectId}
          onClose={() => setLinking(false)}
          onPick={(t) => void link(t.id)}
        />
      )}
    </Modal>
  );
}

/** Picks a progress ticket to link (newest first, searchable). */
function LinkPicker({
  projectId,
  onClose,
  onPick,
}: {
  projectId: string;
  onClose: () => void;
  onPick: (t: Task) => void;
}) {
  const { tasks } = useApp();
  const all = useDiscussions(projectId);
  const [q, setQ] = useState('');
  const taken = new Set(all.map((d) => d.linkedTaskId).filter(Boolean));
  const list = tasks
    .filter((t) => t.projectId === projectId && !taken.has(t.id))
    .filter((t) =>
      `${t.customerId} ${t.titleOriginal} ${t.titleTranslation}`
        .toLowerCase()
        .includes(q.trim().toLowerCase()),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <Modal
      title={tr('Link a progress ticket')}
      subtitle={tr('The discussion takes its number.')}
      onClose={onClose}
      narrow
    >
      <input
        className="inp"
        aria-label={tr('Search')}
        placeholder={tr('Search by number or title')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="dc-pick" role="list">
        {list.slice(0, 80).map((t) => (
          <button
            key={t.id}
            role="listitem"
            className="dc-pick-row"
            onClick={() => onPick(t)}
          >
            <span className="mono">{t.customerId}</span>
            <span className="grow">
              {t.titleTranslation || t.titleOriginal}
            </span>
            <StatusChip status={t.status} />
          </button>
        ))}
        {!list.length && (
          <div className="muted">{tr('No progress ticket to link.')}</div>
        )}
      </div>
    </Modal>
  );
}

/** For a progress ticket: its linked discussion, or a way to link one (doc 09, 4.1). */
export function DiscussionBar({
  task,
  onOpenDiscussion,
}: {
  task: Task;
  onOpenDiscussion: (id: string) => void;
}) {
  const { attempt, toast } = useApp();
  const all = useDiscussions(task.projectId);
  const [picking, setPicking] = useState(false);
  const d = all.find((x) => x.linkedTaskId === task.id);
  const twin = all.find(
    (x) => !x.linkedTaskId && x.no && x.no === task.customerId,
  );
  if (d)
    return (
      <button className="dc-linkbar" onClick={() => onOpenDiscussion(d.id)}>
        <Icon name="chat" />
        {tr('Discussion {no}', { no: d.no })} ·{' '}
        {tr('{n} comments', { n: d.commentCount })}
        {d.newSinceSummary > 0 && (
          <b>
            {' '}
            · {tr('{n} new since the last summary', { n: d.newSinceSummary })}
          </b>
        )}
      </button>
    );
  return (
    <div className="dc-bar slim">
      {twin && (
        <button
          className="btn sm primary"
          onClick={() =>
            void attempt(() =>
              window.worksync.linkDiscussion(twin.id, task.id),
            ).then((x) => {
              if (x) {
                workChanged();
                toast(
                  tr(
                    'Linked. Press Summarize in the discussion to bring this ticket up to date.',
                  ),
                );
              }
            })
          }
        >
          <Icon name="link" />
          {tr('Link with discussion {no}?', { no: twin.no })}
        </button>
      )}
      <button className="btn sm" onClick={() => setPicking(true)}>
        <Icon name="chat" />
        {tr('Link a discussion…')}
      </button>
      {picking && (
        <Modal
          title={tr('Link a discussion')}
          subtitle={tr('The discussion takes this ticket’s number.')}
          onClose={() => setPicking(false)}
          narrow
        >
          <div className="dc-pick" role="list">
            {all
              .filter((x) => !x.linkedTaskId)
              .map((x) => (
                <button
                  key={x.id}
                  role="listitem"
                  className="dc-pick-row"
                  onClick={() =>
                    void attempt(() =>
                      window.worksync.linkDiscussion(x.id, task.id),
                    ).then((r) => {
                      if (r) {
                        setPicking(false);
                        workChanged();
                      }
                    })
                  }
                >
                  <span className="mono">{x.no || '—'}</span>
                  <span className="grow">{x.title}</span>
                  <span className="muted">
                    {tr('{n} comments', { n: x.commentCount })}
                  </span>
                </button>
              ))}
            {!all.some((x) => !x.linkedTaskId) && (
              <div className="muted">
                {tr('No discussion to link. Make one in Discussions.')}
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

interface Review {
  key: string;
  discussion: Discussion;
  task: Task;
  answer: SummaryAnswer;
  take: {
    doingNow: boolean;
    situation: boolean;
    next: boolean;
    status: boolean;
    newDiff: boolean[];
    resolved: boolean[];
    actions: {
      on: boolean;
      title: string;
      assignee: string;
      dueDate: string | null;
    }[];
  };
}

/** Summarize into progress, for one or many linked discussions (doc 09, 5 and 6). */
export function SummarizeDialog({
  ids,
  projectId,
  onClose,
}: {
  ids: string[];
  projectId: string;
  onClose: () => void;
}) {
  const { attempt, toast, tasks, putTask } = useApp();
  const all = useDiscussions(projectId);
  const members = useMembers(projectId);
  const [chosen, setChosen] = useState<string[]>(ids);
  const [step, setStep] = useState<'choose' | 'copy' | 'review'>(
    ids.length > 1 ? 'choose' : 'copy',
  );
  const [batches, setBatches] = useState<SummaryBatch[]>([]);
  const [pasted, setPasted] = useState<Record<number, string>>({});
  const [copied, setCopied] = useState<Record<number, boolean>>({});
  const [reviews, setReviews] = useState<Review[]>([]);
  const [problems, setProblems] = useState<{
    missing: string[];
    unreadable: { key: string; text: string }[];
  }>({
    missing: [],
    unreadable: [],
  });
  const ds = all.filter((d) => chosen.includes(d.id));
  useEffect(() => {
    if (step !== 'copy' || !chosen.length) return;
    void attempt(() => window.worksync.summaryRequest(chosen)).then(
      (b) => b && setBatches(b),
    );
  }, [step, chosen.join(',')]);
  const read = () => {
    const out: Review[] = [];
    const missing: string[] = [];
    const unreadable: { key: string; text: string }[] = [];
    batches.forEach((b) => {
      const r = readSummaryAnswer(pasted[b.number] ?? '', b.keys);
      missing.push(...r.missing);
      unreadable.push(...r.unreadable);
      for (const a of r.answers) {
        const discussion = ds.find(
          (d) => (d.no || `D-${d.id.slice(0, 6)}`) === a.key,
        );
        const task =
          discussion && tasks.find((t) => t.id === discussion.linkedTaskId);
        if (!discussion || !task) continue;
        out.push({
          key: a.key,
          discussion,
          task,
          answer: a,
          take: {
            doingNow: !!a.doingNow,
            situation: !!a.situation,
            // Ticked only when the answer gives a next step or a date; "none" does not clear yours.
            next: !!a.nextStep || !!a.nextDate,
            status: false,
            newDiff: a.difficulties.map(() => true),
            resolved: a.resolved.map(() => true),
            actions: a.actionItems.map((x) => ({
              on: false,
              ...readActionItem(x, members),
            })),
          },
        });
      }
    });
    setReviews(out);
    setProblems({ missing, unreadable });
    setStep('review');
  };
  const apply = async (only?: Review) => {
    let done = 0;
    for (const r of only ? [only] : reviews) {
      const a = r.answer;
      const t = r.take;
      const task = await attempt(() =>
        window.worksync.applySummary(r.discussion.id, {
          ...(t.doingNow ? { doingNow: a.doingNow } : {}),
          ...(t.situation ? { situation: a.situation } : {}),
          ...(t.next
            ? {
                ...(a.nextStep ? { nextStep: a.nextStep } : {}),
                ...(a.nextDate !== undefined
                  ? { nextDate: a.nextDate }
                  : a.nextStep
                    ? { nextDate: null }
                    : {}),
              }
            : {}),
          difficulties: a.difficulties.filter((_, i) => t.newDiff[i]),
          resolved: a.resolved.filter((_, i) => t.resolved[i]),
          status: t.status ? a.status : null,
        }),
      );
      if (!task) continue;
      putTask(task);
      for (const x of t.actions.filter((y) => y.on && y.title.trim()))
        await attempt(() =>
          window.worksync.saveProjectTask(projectId, {
            title: x.title,
            assignee: x.assignee,
            dueDate: x.dueDate,
            ticketId: task.id,
          }),
        );
      done++;
    }
    workChanged();
    if (only) {
      setReviews(reviews.filter((x) => x !== only));
      toast(tr('Updated progress ticket {no}.', { no: only.key }));
      if (reviews.length === 1) onClose();
    } else {
      toast(
        tr(
          done === 1
            ? 'Updated {n} progress ticket.'
            : 'Updated {n} progress tickets.',
          { n: done },
        ),
      );
      onClose();
    }
  };
  const set = (r: Review, take: Partial<Review['take']>) =>
    setReviews(
      reviews.map((x) =>
        x === r ? { ...x, take: { ...x.take, ...take } } : x,
      ),
    );
  const Change = ({
    on,
    onChange,
    label,
    before,
    after,
  }: {
    on: boolean;
    onChange: (v: boolean) => void;
    label: string;
    before: string;
    after: string;
  }) => (
    <label className={`sm-change ${on ? 'on' : ''}`}>
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="sm-label">{label}</span>
      <span className="sm-before muted">{before || '—'}</span>
      <span className="sm-arrow" aria-hidden="true">
        →
      </span>
      <span className="sm-after">{after || '—'}</span>
    </label>
  );
  return (
    <Modal
      title={
        ids.length > 1
          ? tr('Update progress from discussions')
          : tr('Summarize into progress')
      }
      subtitle={tr(
        'Copy the request to your AI, paste its answer back, then check each change before it is applied.',
      )}
      onClose={onClose}
      wide
      footer={
        step === 'choose' ? (
          <>
            <button className="btn" onClick={onClose}>
              {tr('Cancel')}
            </button>
            <button
              className="btn primary"
              disabled={!chosen.length}
              onClick={() => setStep('copy')}
            >
              {tr('Next')}
            </button>
          </>
        ) : step === 'copy' ? (
          <>
            <button className="btn" onClick={onClose}>
              {tr('Cancel')}
            </button>
            <button
              className="btn primary"
              disabled={
                !batches.length ||
                batches.some((b) => !(pasted[b.number] ?? '').trim())
              }
              onClick={read}
            >
              {tr('Read the answer')}
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => setStep('copy')}>
              {tr('Back')}
            </button>
            <span className="grow" />
            <button
              className="btn primary"
              disabled={!reviews.length}
              onClick={() => void apply()}
            >
              <Icon name="check" />
              {reviews.length > 1 ? tr('Apply all') : tr('Apply')}
            </button>
          </>
        )
      }
    >
      {step === 'choose' && (
        <div className="sm-choose" role="list">
          {all
            .filter((d) => ids.includes(d.id))
            .map((d) => (
              <label key={d.id} className="check sm-row" role="listitem">
                <input
                  type="checkbox"
                  checked={chosen.includes(d.id)}
                  onChange={(e) =>
                    setChosen(
                      e.target.checked
                        ? [...chosen, d.id]
                        : chosen.filter((x) => x !== d.id),
                    )
                  }
                />
                <span className="mono">{d.no}</span> <b>{d.title}</b>{' '}
                <span className="muted">
                  {tr('{n} new comments', { n: d.newSinceSummary })}
                </span>
              </label>
            ))}
        </div>
      )}
      {step === 'copy' && (
        <div className="sm-copy">
          {batches.map((b) => (
            <div key={b.number} className="sm-batch">
              <div className="sm-batch-head">
                <b>
                  {b.of > 1
                    ? tr('Batch {n} of {of}', { n: b.number, of: b.of })
                    : tr('The request')}
                </b>
                <span className="muted">
                  {tr('{n} characters · tickets {keys}', {
                    n: b.text.length,
                    keys: b.keys.join(', '),
                  })}
                </span>
                <span className="grow" />
                <button
                  className={`btn ${copied[b.number] ? '' : 'primary'}`}
                  onClick={() =>
                    void navigator.clipboard.writeText(b.text).then(() => {
                      setCopied({ ...copied, [b.number]: true });
                      toast(
                        tr(
                          'Copied. Paste it into your AI, then paste its answer below.',
                        ),
                      );
                    })
                  }
                >
                  <Icon name="copy" />
                  {copied[b.number] ? tr('Copied') : tr('Copy')}
                </button>
              </div>
              <textarea
                className="inp mono"
                rows={6}
                aria-label={tr('The AI’s answer')}
                placeholder={tr(
                  'Paste the AI’s answer here. It starts with === TICKET … ===',
                )}
                value={pasted[b.number] ?? ''}
                onChange={(e) =>
                  setPasted({ ...pasted, [b.number]: e.target.value })
                }
              />
            </div>
          ))}
          {!batches.length && (
            <p className="muted">{tr('Making the request…')}</p>
          )}
        </div>
      )}
      {step === 'review' && (
        <div className="sm-review">
          {problems.missing.length > 0 && (
            <div className="keepnote warn">
              <Icon name="alert" />
              {tr('Not answered, try again: {keys}', {
                keys: problems.missing.join(', '),
              })}
            </div>
          )}
          {problems.unreadable.map((u) => (
            <details key={u.key} className="keepnote warn">
              <summary>
                {tr('Could not read the part for {key}', { key: u.key })}
              </summary>
              <pre className="mono">{u.text}</pre>
            </details>
          ))}
          {reviews.map((r) => {
            const a = r.answer;
            const t = r.take;
            const s = r.task.situation;
            return (
              <section key={r.key} className="sm-card" aria-label={r.key}>
                <div className="sm-card-head">
                  <b className="mono">{r.key}</b>{' '}
                  <b>{r.task.titleTranslation || r.task.titleOriginal}</b>
                  <span className="grow" />
                  {reviews.length > 1 && (
                    <button className="btn sm" onClick={() => void apply(r)}>
                      {tr('Apply this one')}
                    </button>
                  )}
                </div>
                {a.doingNow && (
                  <Change
                    on={t.doingNow}
                    onChange={(v) => set(r, { doingNow: v })}
                    label={tr('Doing now')}
                    before={s.doingNow}
                    after={a.doingNow}
                  />
                )}
                {a.situation && (
                  <Change
                    on={t.situation}
                    onChange={(v) => set(r, { situation: v })}
                    label={tr('Handled by')}
                    before={s.handledBy}
                    after={a.situation}
                  />
                )}
                {(a.nextStep || a.nextDate) && (
                  <Change
                    on={t.next}
                    onChange={(v) => set(r, { next: v })}
                    label={tr('Next step')}
                    before={`${s.nextStep}${s.nextDate ? ` (${shortDate(s.nextDate)})` : ''}`}
                    after={`${a.nextStep}${a.nextDate ? ` (${shortDate(a.nextDate)})` : ''}`}
                  />
                )}
                {a.difficulties.map((x, i) => (
                  <Change
                    key={`n${i}`}
                    on={t.newDiff[i]}
                    onChange={(v) =>
                      set(r, {
                        newDiff: t.newDiff.map((y, j) => (j === i ? v : y)),
                      })
                    }
                    label={tr('New difficulty')}
                    before=""
                    after={x}
                  />
                ))}
                {a.resolved.map((x, i) => (
                  <Change
                    key={`r${i}`}
                    on={t.resolved[i]}
                    onChange={(v) =>
                      set(r, {
                        resolved: t.resolved.map((y, j) => (j === i ? v : y)),
                      })
                    }
                    label={tr('Resolved')}
                    before={x}
                    after={tr('Resolved')}
                  />
                ))}
                {a.status && a.status !== r.task.status && (
                  <Change
                    on={t.status}
                    onChange={(v) => set(r, { status: v })}
                    label={tr('Status (a suggestion)')}
                    before={tr(r.task.status)}
                    after={tr(a.status)}
                  />
                )}
                {t.actions.length > 0 && (
                  <div className="sm-actions">
                    <div className="k">{tr('Action items found')}</div>
                    {t.actions.map((x, i) => (
                      <div key={i} className="sm-action">
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={x.on}
                            onChange={(e) =>
                              set(r, {
                                actions: t.actions.map((y, j) =>
                                  j === i ? { ...y, on: e.target.checked } : y,
                                ),
                              })
                            }
                          />
                          {tr('Make a task')}
                        </label>
                        <input
                          className="inp grow"
                          aria-label={tr('Task title')}
                          value={x.title}
                          onChange={(e) =>
                            set(r, {
                              actions: t.actions.map((y, j) =>
                                j === i ? { ...y, title: e.target.value } : y,
                              ),
                            })
                          }
                        />
                        <select
                          className="inp"
                          aria-label={tr('Assignee')}
                          value={x.assignee}
                          onChange={(e) =>
                            set(r, {
                              actions: t.actions.map((y, j) =>
                                j === i
                                  ? { ...y, assignee: e.target.value }
                                  : y,
                              ),
                            })
                          }
                        >
                          <option value="">{tr('Unassigned')}</option>
                          {members.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.me ? tr('You') : `${m.name} ·${m.tag}`}
                            </option>
                          ))}
                        </select>
                        <input
                          className="inp"
                          type="date"
                          aria-label={tr('Due date')}
                          value={x.dueDate ?? ''}
                          onChange={(e) =>
                            set(r, {
                              actions: t.actions.map((y, j) =>
                                j === i
                                  ? { ...y, dueDate: e.target.value || null }
                                  : y,
                              ),
                            })
                          }
                        />
                      </div>
                    ))}
                  </div>
                )}
                <p className="muted">
                  {tr(
                    'Applying writes a situation update; dates, priority and the customer’s fields are never changed.',
                  )}
                </p>
              </section>
            );
          })}
          {!reviews.length && !problems.missing.length && (
            <p className="muted">{tr('Nothing to apply.')}</p>
          )}
        </div>
      )}
    </Modal>
  );
}
