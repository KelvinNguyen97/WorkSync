import {
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import {
  continueList,
  parseRich,
  toggleLines,
  toggleWrap,
  type Block,
  type Edit,
  type Inline,
  type LineKind,
} from '../shared/rich';
import { useApp } from './appState';
import { tr } from './i18n';

interface Mention {
  name: string;
  tag: string;
  color: string;
}

/** Text shown with its formatting: headings, bold, lists, links… (see shared/rich). */
export function RichText({
  text,
  mentions,
  className,
}: {
  text: string;
  /** Members whose @name is marked, in comments. */
  mentions?: Mention[];
  className?: string;
}) {
  const { attempt } = useApp();
  const open = (href: string) =>
    void attempt(() => window.worksync.openWebLink(href));

  const plain = (v: string, key: number): ReactNode => {
    if (!mentions?.length) return v;
    const parts = v.split(/(@[^\s@,.;:!?]+)/g);
    return parts.map((p, i) => {
      const m =
        p.startsWith('@') &&
        mentions.find((x) => x.name.toLowerCase() === p.slice(1).toLowerCase());
      return m ? (
        <span
          key={`${key}-${i}`}
          className="dc-mention"
          style={{ borderColor: m.color }}
        >
          {p}
          <span className="wk-tag">·{m.tag}</span>
        </span>
      ) : (
        p
      );
    });
  };
  const inline = (c: Inline[]): ReactNode =>
    c.map((x, i) => {
      if (x.t === 'text') return <span key={i}>{plain(x.v, i)}</span>;
      if (x.t === 'code') return <code key={i}>{x.v}</code>;
      if (x.t !== 'link') {
        const Tag = x.t === 'b' ? 'strong' : x.t === 'i' ? 'em' : 's';
        return <Tag key={i}>{inline(x.c)}</Tag>;
      }
      return (
        <a
          key={i}
          href={x.href}
          title={x.href}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            open(x.href);
          }}
        >
          {inline(x.c)}
        </a>
      );
    });
  const lines = (ls: Inline[][]): ReactNode =>
    ls.map((l, i) => (
      <span key={i}>
        {i > 0 && <br />}
        {inline(l)}
      </span>
    ));
  const blocks = (bs: Block[]): ReactNode =>
    bs.map((b, i) => {
      if (b.t === 'p') return <p key={i}>{lines(b.lines)}</p>;
      if (b.t === 'h') {
        const H = `h${b.level + 3}` as 'h4' | 'h5' | 'h6';
        return (
          <H key={i} className={`rt-h rt-h${b.level}`}>
            {inline(b.c)}
          </H>
        );
      }
      if (b.t === 'hr') return <hr key={i} />;
      if (b.t === 'code')
        return (
          <pre key={i}>
            <code>{b.v}</code>
          </pre>
        );
      if (b.t === 'quote')
        return <blockquote key={i}>{blocks(b.blocks)}</blockquote>;
      const items = b.items.map((it, k) => (
        <li key={k} className={it.checked !== null ? 'rt-check' : undefined}>
          {it.checked !== null && (
            <span
              className={`rt-box ${it.checked ? 'on' : ''}`}
              role="img"
              aria-label={it.checked ? tr('Done') : tr('To do')}
            >
              {it.checked ? '✓' : ''}
            </span>
          )}
          <span className={it.checked ? 'rt-ticked' : undefined}>
            {lines(it.c)}
          </span>
          {blocks(it.children)}
        </li>
      ));
      return b.t === 'ol' ? (
        <ol key={i} start={b.start}>
          {items}
        </ol>
      ) : (
        <ul key={i}>{items}</ul>
      );
    });
  return (
    <div className={`rt ${className ?? ''}`}>{blocks(parseRich(text))}</div>
  );
}

const TOOLS: (
  | { key: string; label: string; show: ReactNode; wrap: string; keys?: string }
  | { key: string; label: string; show: ReactNode; lines: LineKind }
  | { key: string; label: string; show: ReactNode; link: true; keys?: string }
  | null
)[] = [
  { key: 'b', label: 'Bold', show: <b>B</b>, wrap: '**', keys: 'Ctrl+B' },
  { key: 'i', label: 'Italic', show: <i>I</i>, wrap: '*', keys: 'Ctrl+I' },
  { key: 's', label: 'Strikethrough', show: <s>S</s>, wrap: '~~' },
  { key: 'c', label: 'Code', show: <code>{'<>'}</code>, wrap: '`' },
  null,
  { key: 'h', label: 'Heading', show: 'H', lines: 'h' },
  { key: 'ul', label: 'Bullet list', show: '•—', lines: 'ul' },
  { key: 'ol', label: 'Numbered list', show: '1.', lines: 'ol' },
  { key: 'ck', label: 'Check list', show: '☑', lines: 'check' },
  { key: 'q', label: 'Quote', show: '❝', lines: 'quote' },
  null,
  { key: 'l', label: 'Link', show: '🔗', link: true, keys: 'Ctrl+K' },
];

/**
 * A text box with a formatting bar. The text stays as typed (a small
 * Markdown); Preview shows it as it will look.
 */
export function RichEditor({
  value,
  onChange,
  rows = 4,
  label,
  placeholder,
  autoFocus,
  inputRef,
  onKeyDown,
  onPaste,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  label: string;
  placeholder?: string;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLTextAreaElement>;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  className?: string;
}) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const pending = useRef<{ start: number; end: number } | null>(null);
  const [preview, setPreview] = useState(false);
  useLayoutEffect(() => {
    if (pending.current && own.current) {
      own.current.focus();
      own.current.setSelectionRange(pending.current.start, pending.current.end);
      pending.current = null;
    }
  });
  const apply = (e: Edit) => {
    pending.current = { start: e.start, end: e.end };
    onChange(e.text);
  };
  const run = (t: NonNullable<(typeof TOOLS)[number]>) => {
    const el = own.current;
    if (!el) return;
    const [a, b] = [el.selectionStart, el.selectionEnd];
    if ('wrap' in t) apply(toggleWrap(value, a, b, t.wrap));
    else if ('lines' in t) apply(toggleLines(value, a, b, t.lines));
    else {
      const sel = value.slice(a, b) || tr('link text');
      const ins = `[${sel}](https://)`;
      apply({
        text: value.slice(0, a) + ins + value.slice(b),
        // The address is selected, ready to be pasted over.
        start: a + sel.length + 3,
        end: a + ins.length - 1,
      });
    }
  };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && !e.shiftKey && !e.altKey && (k === 'b' || k === 'i')) {
      e.preventDefault();
      e.stopPropagation();
      run(TOOLS.find((t) => t?.key === k)!);
      return;
    }
    if (
      e.key === 'Enter' &&
      !mod &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing
    ) {
      const el = e.currentTarget;
      if (el.selectionStart === el.selectionEnd) {
        const next = continueList(value, el.selectionStart);
        if (next) {
          e.preventDefault();
          apply(next);
          return;
        }
      }
    }
    onKeyDown?.(e);
  };
  const lineCount = value.split('\n').length;
  return (
    <div className={`rte ${className ?? ''}`}>
      <div className="rte-bar" role="toolbar" aria-label={tr('Formatting')}>
        {TOOLS.map((t, i) =>
          t ? (
            <button
              key={t.key}
              type="button"
              className="rte-btn"
              disabled={preview}
              aria-label={tr(t.label)}
              title={`${tr(t.label)}${'keys' in t && t.keys && t.key !== 'l' ? ` (${t.keys})` : ''}`}
              // Keeps the selection in the text box.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(t)}
            >
              {t.show}
            </button>
          ) : (
            <span key={i} className="rte-sep" aria-hidden="true" />
          ),
        )}
        <span className="grow" />
        <button
          type="button"
          className="rte-btn rte-preview"
          aria-pressed={preview}
          title={tr('See it as it will look')}
          onClick={() => setPreview(!preview)}
        >
          {preview ? tr('Edit') : tr('Preview')}
        </button>
      </div>
      {preview ? (
        <div className="rte-view" style={{ minHeight: `${rows * 1.6 + 1}em` }}>
          {value.trim() ? (
            <RichText text={value} />
          ) : (
            <span className="muted">{tr('Nothing to preview yet.')}</span>
          )}
        </div>
      ) : (
        <textarea
          ref={(el) => {
            own.current = el;
            if (typeof inputRef === 'function') inputRef(el);
            else if (inputRef)
              (inputRef as { current: HTMLTextAreaElement | null }).current =
                el;
          }}
          className="inp rte-text"
          rows={Math.min(18, Math.max(rows, lineCount + 1))}
          aria-label={label}
          placeholder={placeholder}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={keys}
          onPaste={onPaste}
        />
      )}
    </div>
  );
}
