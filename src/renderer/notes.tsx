import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  filterNotes,
  joinBlocks,
  linkAt,
  noteBlocks,
  noteImageIds,
  noteLinks,
  noteText,
  parseTags,
  type Note,
  type NoteBlock,
  type NoteFilter,
} from '../shared/notes';
import { imageFrom, keepImage, NoteImage } from './noteImages';
import { useApp } from './appState';
import { Icon } from './Icon';
import type { HeaderSlot } from './mine';
import { tr } from './i18n';

const when = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return tr('just now');
  if (mins < 60) return tr('{n} min ago', { n: mins });
  const p = (n: number) => String(n).padStart(2, '0');
  const today = new Date();
  if (d.toDateString() === today.toDateString())
    return tr('today {time}', {
      time: `${p(d.getHours())}:${p(d.getMinutes())}`,
    });
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
};

const preview = (n: Note) => {
  const text = noteText(n.body)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' · ');
  const images = noteImageIds(n.body).length;
  const pics = images
    ? tr(images === 1 ? '1 image' : '{n} images', { n: images })
    : '';
  return [pics, text].filter(Boolean).join(' · ');
};

/**
 * Notes: every note, or the notes of one project. The editor saves while
 * you type. A note on its own works as usual; one attached to a project also
 * shows inside that project.
 */
export function NotesView({
  notes,
  setNotes,
  projectId,
  query,
  head,
}: {
  notes: Note[];
  setNotes: (f: (list: Note[]) => Note[]) => void;
  /** Set for a project's Notes tab: only its notes, and new ones go there. */
  projectId?: string;
  query: string;
  head: HeaderSlot;
}) {
  const { attempt, toast, projects, project } = useApp();
  const [filter, setFilter] = useState<NoteFilter>('all');
  const [scope, setScope] = useState<'any' | 'none' | string>('any');
  const [sel, setSel] = useState<string | null>(null);
  const inProject = projectId ? project(projectId) : null;

  const scoped = useMemo(
    () =>
      notes.filter((n) =>
        projectId
          ? n.projectId === projectId
          : scope === 'any' ||
            (scope === 'none' ? !n.projectId : n.projectId === scope),
      ),
    [notes, projectId, scope],
  );
  const shown = filterNotes(scoped, filter, query, new Date());
  const selected = notes.find((n) => n.id === sel) ?? null;

  // Open the newest note when the page opens, or after the open one goes.
  useEffect(() => {
    if (!selected && shown.length) setSel(shown[0].id);
    // Only when the selection is gone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, projectId]);

  const put = (n: Note) =>
    setNotes((list) =>
      list.some((x) => x.id === n.id)
        ? list.map((x) => (x.id === n.id ? n : x))
        : [n, ...list],
    );

  const open = (id: string) => {
    setSel(id);
    void window.worksync.viewNote(id).then(put, () => {});
  };

  const create = async () => {
    const n = await attempt(() =>
      window.worksync.saveNote({
        title: '',
        body: '',
        tags: [],
        favorite: false,
        projectId:
          projectId ?? (scope !== 'any' && scope !== 'none' ? scope : null),
      }),
    );
    if (n) {
      put(n);
      setFilter('all');
      setSel(n.id);
      window.setTimeout(
        () => document.getElementById('noteTitle')?.focus(),
        30,
      );
    }
  };

  const remove = async (n: Note) => {
    const gone = await attempt(() => window.worksync.deleteNote(n.id));
    if (!gone) return;
    setNotes((list) => list.filter((x) => x.id !== n.id));
    setSel(null);
    toast(tr('Deleted “{title}”.', { title: n.title || tr('Untitled note') }), {
      label: tr('Undo'),
      run: () =>
        void attempt(() => window.worksync.restoreNote(gone)).then((back) => {
          if (back) {
            put(back);
            setSel(back.id);
          }
        }),
    });
  };

  const filters: [NoteFilter, string][] = [
    ['all', 'All'],
    ['favorites', 'Favorites'],
    ['recent', 'Recent'],
    ['tagged', 'Tagged'],
  ];

  return (
    <div className="mine-page notes-page">
      {head &&
        createPortal(
          <div className="vh">
            <div>
              <h1>{tr('Notes')}</h1>
              <div className="sub">
                {inProject
                  ? `${inProject.name} · notes attached to this project. They also appear in Notes, with all your other notes.`
                  : tr(
                      'All your notes. A note can belong to a project, or to none.',
                    )}
              </div>
            </div>
            <button className="btn primary" onClick={() => void create()}>
              <Icon name="plus" />
              {inProject ? tr('New note in this project') : tr('New note')}
            </button>
          </div>,
          head,
        )}
      <div className="notes-tools">
        <div className="seg-ctl" role="group" aria-label={tr('Show')}>
          {filters.map(([k, l]) => (
            <button
              key={k}
              aria-pressed={filter === k}
              onClick={() => setFilter(k)}
            >
              {tr(l)}
            </button>
          ))}
        </div>
        {!projectId && (
          <select
            className="inp"
            aria-label={tr('Project')}
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="any">{tr('Any project')}</option>
            <option value="none">{tr('No project')}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <span className="muted notes-count">
          {tr(shown.length === 1 ? '{n} note' : '{n} notes', {
            n: shown.length,
          })}
        </span>
      </div>
      <div className="notes-body">
        <div className="notes-list" role="list" aria-label={tr('Notes')}>
          {shown.map((n) => (
            <button
              key={n.id}
              role="listitem"
              className={`note-item ${n.id === sel ? 'sel' : ''}`}
              onClick={() => open(n.id)}
            >
              <span className="note-item-top">
                <b>{n.title || tr('Untitled note')}</b>
                {n.favorite && <Icon name="star" className="fav" />}
              </span>
              {preview(n) && <small>{preview(n)}</small>}
              <span className="note-item-meta">
                {!projectId && n.projectId && (
                  <span className="note-proj">
                    {project(n.projectId)?.name ?? tr('Project')}
                  </span>
                )}
                {n.tags.map((t) => (
                  <span key={t} className="note-tag">
                    {t}
                  </span>
                ))}
                <span className="grow" />
                <span className="muted">{when(n.updatedAt)}</span>
              </span>
            </button>
          ))}
          {!shown.length && (
            <div className="empty">
              {scoped.length
                ? tr('No note matches. Try another filter.')
                : inProject
                  ? tr(
                      'No notes in this project yet. Meeting notes and memos that aren’t about one task go well here.',
                    )
                  : tr('No notes yet. Choose New note to write one.')}
            </div>
          )}
        </div>
        <section className="note-editor" aria-label={tr('Note')}>
          {selected ? (
            <NoteEditor
              key={selected.id}
              note={selected}
              onSaved={put}
              onDelete={() => void remove(selected)}
              fixedProject={!!projectId}
            />
          ) : (
            <div className="empty">
              {tr('Choose a note, or make a new one.')}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function NoteEditor({
  note,
  onSaved,
  onDelete,
  fixedProject,
}: {
  note: Note;
  onSaved: (n: Note) => void;
  onDelete: () => void;
  fixedProject: boolean;
}) {
  const { attempt, projects } = useApp();
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [tagText, setTagText] = useState('');
  const [state, setState] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  const pending = useRef<{ title?: string; body?: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const flush = async () => {
    window.clearTimeout(timer.current);
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    setState('saving');
    const n = await attempt(() => window.worksync.saveNote(p, note.id));
    if (n) onSaved(n);
    setState(pending.current ? 'unsaved' : n ? 'saved' : 'unsaved');
  };
  // Saves a moment after typing stops, and when the note closes.
  const queue = (patch: { title?: string; body?: string }) => {
    pending.current = { ...pending.current, ...patch };
    setState('unsaved');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 600);
  };
  useEffect(
    () => () => {
      void flush();
    },
    // On close only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const save = async (
    patch: Parameters<typeof window.worksync.saveNote>[0],
  ) => {
    const n = await attempt(() => window.worksync.saveNote(patch, note.id));
    if (n) onSaved(n);
  };
  const addTags = () => {
    const more = parseTags(tagText);
    if (!more.length) return;
    setTagText('');
    void save({ tags: [...note.tags, ...more] });
  };
  const links = noteLinks(body);
  const openLink = (url: string) =>
    void flush().then(() =>
      attempt(() => window.worksync.openNoteLink(note.id, url)),
    );

  return (
    <div className="note-edit">
      <div className="note-edit-head">
        <input
          id="noteTitle"
          className="note-title"
          aria-label={tr('Title')}
          placeholder={tr('Untitled note')}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            queue({ title: e.target.value });
          }}
        />
        <span className={`note-state ${state}`} role="status">
          {state === 'saved' ? (
            <>
              <Icon name="check" /> {tr('Saved')}
            </>
          ) : state === 'saving' ? (
            tr('Saving…')
          ) : (
            tr('Editing')
          )}
        </span>
        <button
          className={`icon-btn ${note.favorite ? 'on-fav' : ''}`}
          aria-pressed={note.favorite}
          aria-label={tr('Favorite')}
          title={
            note.favorite ? tr('Remove from favorites') : tr('Add to favorites')
          }
          onClick={() => void save({ favorite: !note.favorite })}
        >
          <Icon name="star" />
        </button>
        <button
          className="icon-btn"
          aria-label={tr('Delete note')}
          title={tr('Delete note')}
          onClick={onDelete}
        >
          <Icon name="trash" />
        </button>
      </div>
      <div className="note-meta">
        {!fixedProject && (
          <label className="note-meta-field">
            {tr('Project')}
            <select
              className="inp"
              value={note.projectId ?? ''}
              onChange={(e) => void save({ projectId: e.target.value || null })}
            >
              <option value="">{tr('No project')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="note-tags">
          {note.tags.map((t) => (
            <span key={t} className="note-tag">
              {t}
              <button
                className="note-tag-x"
                aria-label={`Remove the tag ${t}`}
                onClick={() =>
                  void save({ tags: note.tags.filter((x) => x !== t) })
                }
              >
                <Icon name="x" />
              </button>
            </span>
          ))}
          <input
            className="inp note-tag-inp"
            aria-label={tr('Add tags')}
            placeholder={tr('Add tags')}
            value={tagText}
            onChange={(e) => setTagText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addTags();
              }
            }}
            onBlur={addTags}
          />
        </span>
      </div>
      <NoteBody
        body={body}
        onChange={(b) => {
          setBody(b);
          queue({ body: b });
        }}
        onLink={openLink}
        onBlur={() => void flush()}
      />
      {links.length > 0 && (
        <div className="note-links">
          <span className="muted">{tr('Links in this note')}</span>
          {links.map((u) => (
            <button
              key={u}
              className="linkbtn"
              title={`Open ${u} in your browser`}
              onClick={() => openLink(u)}
            >
              <Icon name="globe" />
              {u.replace(/^https?:\/\//, '')}
            </button>
          ))}
        </div>
      )}
      <div className="note-foot muted">
        <span>
          {tr('Created')} {when(note.createdAt)}
        </span>
        <span>
          {tr('Changed')} {when(note.updatedAt)}
        </span>
      </div>
    </div>
  );
}

type Block = NoteBlock & { key: number };
let nextKey = 1;
const keyed = (blocks: NoteBlock[]): Block[] =>
  blocks.map((b) => ({ ...b, key: nextKey++ }));

/**
 * The note text with its images, in order. Each piece of text is its own
 * box that grows with its text, and an image pasted (or dropped) into one
 * goes where the cursor is. Copied text is pasted as text, even when the
 * clipboard also holds a picture of it (as Excel does).
 */
function NoteBody({
  body,
  onChange,
  onLink,
  onBlur,
}: {
  body: string;
  onChange: (body: string) => void;
  onLink: (url: string) => void;
  onBlur: () => void;
}) {
  const { attempt, toast } = useApp();
  const [blocks, setBlocks] = useState<Block[]>(() => keyed(noteBlocks(body)));
  const boxes = useRef(new Map<number, HTMLTextAreaElement>());
  const focusNext = useRef<{ key: number; at: number } | null>(null);

  const latest = useRef(blocks);
  const update = (next: Block[]) => {
    latest.current = next;
    setBlocks(next);
    onChange(joinBlocks(next));
  };

  useLayoutEffect(() => {
    const f = focusNext.current;
    if (!f) return;
    focusNext.current = null;
    const el = boxes.current.get(f.key);
    if (el) {
      el.focus();
      el.setSelectionRange(f.at, f.at);
    }
  });

  /** Puts an image into a text block, between start and end of its text. */
  const insert = async (
    key: number,
    file: File,
    start: number,
    end: number,
  ) => {
    const id = await attempt(() => keepImage(file));
    if (!id) return;
    const now = latest.current;
    const i = now.findIndex((x) => x.key === key);
    const b = now[i];
    if (!b || b.kind !== 'text') return;
    const before = b.text.slice(0, start).replace(/\n$/, '');
    const after = b.text.slice(end).replace(/^\n/, '');
    const [t1, img, t2] = keyed([
      { kind: 'text', text: before },
      { kind: 'image', id },
      { kind: 'text', text: after },
    ]);
    focusNext.current = { key: t2.key, at: 0 };
    update([...now.slice(0, i), t1, img, t2, ...now.slice(i + 1)]);
  };

  const remove = (key: number) => {
    const blocks = latest.current;
    const i = blocks.findIndex((x) => x.key === key);
    const before = blocks;
    const prev = blocks[i - 1];
    const next = blocks[i + 1];
    if (prev?.kind !== 'text' || next?.kind !== 'text') return;
    const text = [prev.text, next.text].filter((t) => t !== '').join('\n');
    const [merged] = keyed([{ kind: 'text', text }]);
    focusNext.current = { key: merged.key, at: prev.text.length };
    update([...blocks.slice(0, i - 1), merged, ...blocks.slice(i + 2)]);
    toast(tr('Removed the image.'), {
      label: tr('Undo'),
      run: () => update(before),
    });
  };

  const onlyText = blocks.length === 1;
  return (
    <div className="note-body" onBlur={onBlur}>
      {blocks.map((b, i) =>
        b.kind === 'image' ? (
          <NoteImage key={b.key} id={b.id} onRemove={() => remove(b.key)} />
        ) : (
          <TextPiece
            key={b.key}
            ref={(el) => {
              if (el) boxes.current.set(b.key, el);
              else boxes.current.delete(b.key);
            }}
            last={i === blocks.length - 1}
            placeholder={
              onlyText
                ? tr(
                    'Write here. It saves as you type. Paste an image to add it. Web addresses open with Ctrl+click.',
                  )
                : undefined
            }
            value={b.text}
            onChange={(text) =>
              update(
                latest.current.map((x) =>
                  x.key === b.key ? { ...b, text } : x,
                ),
              )
            }
            onPaste={(e) => {
              const file = imageFrom(e.clipboardData);
              if (!file) return;
              e.preventDefault();
              const t = e.currentTarget;
              void insert(b.key, file, t.selectionStart, t.selectionEnd);
            }}
            onDrop={(e) => {
              const file = [...e.dataTransfer.files].find((f) =>
                f.type.startsWith('image/'),
              );
              if (!file) return;
              e.preventDefault();
              void insert(b.key, file, b.text.length, b.text.length);
            }}
            onLinkAt={(at) => {
              const url = linkAt(b.text, at);
              if (url) onLink(url);
              return !!url;
            }}
          />
        ),
      )}
    </div>
  );
}

/** A piece of note text: a box as tall as its text. */
function TextPiece({
  ref,
  value,
  last,
  placeholder,
  onChange,
  onPaste,
  onDrop,
  onLinkAt,
}: {
  ref: (el: HTMLTextAreaElement | null) => void;
  value: string;
  last: boolean;
  placeholder?: string;
  onChange: (text: string) => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onDrop: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  onLinkAt: (at: number) => boolean;
}) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const fit = () => {
    const el = own.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(fit, [value]);
  useEffect(() => {
    const el = own.current;
    if (!el) return;
    const watch = new ResizeObserver(fit);
    watch.observe(el.parentElement ?? el);
    return () => watch.disconnect();
  }, []);
  return (
    <textarea
      ref={(el) => {
        own.current = el;
        ref(el);
      }}
      className={`note-text ${last ? 'last' : ''}`}
      rows={1}
      aria-label={tr('Note text')}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onPaste={onPaste}
      onDrop={onDrop}
      onClick={(e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        if (onLinkAt(e.currentTarget.selectionStart)) e.preventDefault();
      }}
    />
  );
}
