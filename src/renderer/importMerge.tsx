import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MergePreview } from '../shared/ipc';
import type { AutoItem, Pick, Question, Where } from '../shared/merge';
import { shortDate, toIsoDate } from '../shared/model';
import { useApp } from './appState';
import { Icon } from './Icon';
import { Modal } from './parts';
import { tr } from './i18n';

type ImportInfo = NonNullable<
  Awaited<ReturnType<typeof window.worksync.chooseImport>>
>;

/** A date and time as the app shows them (11月9日 14:20, 9 Nov 14:20). */
const when = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${shortDate(toIsoDate(d))} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const day = (iso: string | null) =>
  iso ? shortDate(toIsoDate(new Date(iso))) : '';

/**
 * Importing a .worksync file when a project here is a copy of it, or has its
 * name: merge into it, add the file as a copy, or replace yours.
 */
export function ImportChoice({
  info,
  onCopy,
  onReplace,
  onMerge,
  onClose,
}: {
  info: ImportInfo;
  onCopy: () => void;
  onReplace: (projectId: string) => void;
  onMerge: (projectId: string) => void;
  onClose: () => void;
}) {
  const { projects } = useApp();
  const canMerge = info.mergeTargets.length > 0;
  const replaceable = [
    ...info.mergeTargets,
    ...info.sameName.filter(
      (p) => !info.mergeTargets.some((m) => m.id === p.id),
    ),
  ];
  const [how, setHow] = useState<'merge' | 'copy' | 'replace'>(
    canMerge ? 'merge' : 'copy',
  );
  const [target, setTarget] = useState(replaceable[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const targetName = replaceable.find((p) => p.id === target)?.name ?? '';
  const who = info.fromName || tr('the other person');
  // The name a copy would get, as Windows names copies.
  const taken = new Set(projects.map((p) => p.name.trim().toLowerCase()));
  const root = info.name.replace(/\s*\(\d+\)$/, '');
  let n = 1;
  while (taken.has(`${root} (${n})`.toLowerCase())) n++;
  const copyName = taken.has(info.name.trim().toLowerCase())
    ? `${root} (${n})`
    : info.name;
  const go = () => {
    setBusy(true);
    if (how === 'merge') onMerge(target);
    else if (how === 'copy') onCopy();
    else onReplace(target);
  };
  const option = (
    key: typeof how,
    title: string,
    text: string,
    badge?: string,
  ) => (
    <label className={`ic-opt ${how === key ? 'on' : ''}`}>
      <input
        type="radio"
        name="importHow"
        checked={how === key}
        onChange={() => setHow(key)}
      />
      <span>
        <b>
          {title}
          {badge && <span className="ic-new">{badge}</span>}
        </b>
        <small>{text}</small>
      </span>
    </label>
  );
  return (
    <Modal
      title={tr('Import {name}', { name: info.name })}
      subtitle={
        canMerge
          ? tr(
              'This file is a copy of your project {project}, exported by {who} on {when}.',
              {
                project: targetName,
                who,
                when: when(info.exportedAt),
              },
            )
          : tr('A project called {name} already exists here.', {
              name: info.name,
            })
      }
      onClose={onClose}
      narrow
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button
            className={`btn ${how === 'replace' ? 'danger' : 'primary'}`}
            disabled={busy || (how !== 'copy' && !target)}
            onClick={go}
          >
            {how === 'merge'
              ? tr('Compare and merge…')
              : how === 'copy'
                ? tr('Import as a copy')
                : tr('Replace {name}', { name: targetName })}
          </button>
        </>
      }
    >
      <div className="form imp-choice">
        {replaceable.length > 1 && how !== 'copy' && (
          <label className="field">
            <span className="k">{tr('Your project')}</span>
            <select
              className="inp"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              {(how === 'merge' ? info.mergeTargets : replaceable).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {canMerge &&
          option(
            'merge',
            tr('Merge into {name}', { name: info.mergeTargets[0].name }),
            tr(
              'Adds what only {who} has, keeps what only you have, and asks you where you both changed the same thing.',
              { who },
            ),
            tr('New'),
          )}
        {option(
          'copy',
          tr('Import as a copy'),
          tr('Adds it as {name}. Yours stays as it is.', { name: copyName }),
        )}
        {replaceable.length > 0 &&
          option(
            'replace',
            tr('Replace yours'),
            tr(
              'Your project becomes this copy. What only you changed is lost; WorkSync backs up first, so you can get it back from Settings.',
            ),
          )}
        <p className="muted step-help">
          {tr(
            'The file holds {n} tasks. Merging does not need the customer’s file: WorkSync matches tasks, notes, terms and people by their own ids.',
            { n: info.tasks },
          )}
        </p>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ merge window

/** Words of `a` not in `b` are marked: a light word-level diff. */
function marked(a: string, b: string): { text: string; mark: boolean }[] {
  if (!b || a === b) return [{ text: a, mark: a !== b && !!a }];
  const x = a.split(/(\s+)/);
  const y = b.split(/(\s+)/);
  if (x.length * y.length > 250_000) return [{ text: a, mark: true }];
  const t = Array.from(
    { length: x.length + 1 },
    () => new Uint16Array(y.length + 1),
  );
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      t[i][j] =
        x[i] === y[j]
          ? t[i + 1][j + 1] + 1
          : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: { text: string; mark: boolean }[] = [];
  const put = (text: string, mark: boolean) => {
    const last = out[out.length - 1];
    if (last && last.mark === mark) last.text += text;
    else out.push({ text, mark });
  };
  for (let i = 0, j = 0; i < x.length;) {
    if (j < y.length && x[i] === y[j]) {
      put(x[i], false);
      i++;
      j++;
    } else if (j < y.length && t[i][j + 1] > t[i + 1][j]) j++;
    else {
      put(x[i], /\S/.test(x[i]));
      i++;
    }
  }
  // Spaces between two changed words belong to the change: one highlight.
  const joined: { text: string; mark: boolean }[] = [];
  for (const part of out) {
    const gap = joined[joined.length - 1];
    const before = joined[joined.length - 2];
    if (part.mark && gap && !gap.mark && !/\S/.test(gap.text) && before?.mark) {
      before.text += gap.text + part.text;
      joined.pop();
    } else joined.push({ ...part });
  }
  return joined;
}

const whereText = (w: Where) =>
  w.kind === 'task'
    ? `${w.no ? `No. ${w.no} ` : ''}${w.name}`
    : w.kind === 'project'
      ? tr('The project')
      : w.name;

function Marked({
  text,
  other,
  side,
}: {
  text: string;
  other: string;
  side: 'mine' | 'theirs';
}) {
  if (!text) return <span className="muted">{tr('(empty)')}</span>;
  return (
    <>
      {marked(text, other).map((p, i) =>
        p.mark ? (
          <mark key={i} className={`mg-mark ${side}`}>
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Merging a copy, step by step: what changed, one question at a time where
 * you both changed something, then a review. Nothing changes until Merge.
 */
export function MergeWizard({
  file,
  projectId,
  onDone,
  onClose,
}: {
  file: string;
  projectId: string;
  onDone: (r: { projectId: string; name: string; added: number }) => void;
  onClose: () => void;
}) {
  const { attempt } = useApp();
  const [plan, setPlan] = useState<MergePreview | null>(null);
  const [step, setStep] = useState<'summary' | 'q' | 'review'>('summary');
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState<Record<string, Pick>>({});
  const [off, setOff] = useState<Set<string>>(new Set());
  const [whole, setWhole] = useState(false);
  const [hide, setHide] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void attempt(() => window.worksync.previewMerge(file, projectId)).then(
      (p) => (p ? setPlan(p) : onClose()),
    );
    // Once, when the window opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const who = plan?.fromName || tr('the other person');
  const qs = plan?.questions ?? [];
  const q = qs[i];
  const pick = (x: Question): Pick => answers[x.id] ?? x.suggest;
  const toggle = (id: string) =>
    setOff((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const autoOn = (plan?.auto ?? []).filter((a) => !off.has(a.id)).length;
  const steps = [tr('What changed'), tr('Your choices'), tr('Review')];
  const stepIdx = step === 'summary' ? 0 : step === 'q' ? 1 : 2;

  const merge = async () => {
    if (!plan) return;
    setBusy(true);
    const r = await attempt(() =>
      window.worksync.applyMerge(plan.token, {
        answers,
        off: [...off],
      }),
    );
    setBusy(false);
    if (r) onDone(r);
  };

  const autoText = (a: AutoItem) => {
    const fields = a.fields.map((f) => tr(f)).join(', ');
    switch (a.tag) {
      case 'New task':
        return tr('{who} added this task', { who });
      case 'Changes':
      case 'Project':
        return tr('{who} changed: {fields}', { who, fields });
      case 'Deleted':
        return tr('{who} deleted it', { who });
      case 'Situation updates':
        return tr(
          a.count === 1
            ? '1 situation update from {who}'
            : '{n} situation updates from {who}',
          { n: a.count, who },
        );
      case 'Difficulty':
        return tr('{who} added a difficulty: {text}', { who, text: a.detail });
      case 'Glossary':
        return tr('{who} added the term → {text}', { who, text: a.detail });
      case 'Person':
        return tr('{who} added this person', { who });
      case 'Note':
        return a.fields.length
          ? tr('{who} changed: {fields}', { who, fields })
          : tr('{who} added this note', { who });
    }
  };

  const answerText = (x: Question) => {
    const p = pick(x);
    if (x.kind === 'timeline') {
      const left = x.updates.filter((u) => off.has(`upd:${u.id}`)).length;
      return left
        ? tr('Situation updates: {n} left out', { n: left })
        : tr('Situation updates: all kept, by date');
    }
    if (x.kind === 'deleted')
      return x.by === 'theirs'
        ? p === 'theirs'
          ? tr('Delete it, as {who} did', { who })
          : tr('Keep it')
        : p === 'theirs'
          ? tr('Bring it back')
          : tr('Keep it deleted');
    const field = tr(x.field);
    if (p === 'both') return tr('{field}: keep both', { field });
    const v = p === 'mine' ? x.mine : x.theirs;
    const short = (x.kind === 'field' && x.words ? tr(v) : v)
      .split('\n')
      .filter(Boolean)
      .slice(-1)[0];
    return p === 'mine'
      ? tr('{field}: keep yours, “{value}”', { field, value: short ?? '' })
      : tr('{field}: take {who}’s, “{value}”', {
          field,
          who,
          value: short ?? '',
        });
  };

  // The current situation in a timeline question: the newest update kept.
  const currentId = useMemo(() => {
    if (!q || q.kind !== 'timeline') return null;
    const kept = q.updates.filter((u) => !off.has(`upd:${u.id}`));
    return kept.length ? kept[kept.length - 1].id : null;
  }, [q, off]);

  const card = (x: Question, side: 'mine' | 'theirs') => {
    const on = pick(x) === side;
    let heading =
      side === 'mine' ? tr('Your version') : tr('{who}’s version', { who });
    let body: React.ReactNode = null;
    if (x.kind === 'field' || x.kind === 'note') {
      const v = side === 'mine' ? x.mine : x.theirs;
      const o = side === 'mine' ? x.theirs : x.mine;
      body =
        x.kind === 'field' && x.words ? (
          <span className={`mg-val big`}>{tr(v) || tr('(empty)')}</span>
        ) : (
          <span
            className={`mg-val ${v.length < 40 && !v.includes('\n') ? 'big' : ''}`}
          >
            <Marked text={v} other={o} side={side} />
          </span>
        );
    } else if (x.kind === 'deleted') {
      const keep = (x.by === 'theirs') === (side === 'mine');
      heading =
        x.by === 'theirs'
          ? side === 'mine'
            ? tr('Keep it')
            : tr('Delete it')
          : side === 'mine'
            ? tr('Keep it deleted')
            : tr('Bring it back');
      body = (
        <span className="mg-val">
          {keep
            ? (x.by === 'theirs'
                ? tr('You changed it since: ')
                : tr('{who} changed it since: ', { who })) +
              x.fields.map((f) => tr(f)).join(', ')
            : x.by === 'theirs'
              ? tr('{who} deleted it.', { who })
              : tr('You deleted it.')}
        </span>
      );
    }
    const at = side === 'mine' ? x.mineAt : x.theirsAt;
    return (
      <label className={`mg-card ${side} ${on ? 'on' : ''}`}>
        <span className="mg-card-head">
          <input
            type="radio"
            name={`pick-${x.id}`}
            checked={on}
            onChange={() => setAnswers((a) => ({ ...a, [x.id]: side }))}
          />
          <span className={`mg-who ${side}`}>
            {side === 'mine'
              ? tr('You').slice(0, 1)
              : who.slice(0, 1).toUpperCase()}
          </span>
          <b>{heading}</b>
          {x.suggest === side &&
            x.kind !== 'deleted' &&
            x.mineAt &&
            x.theirsAt && <span className="mg-newer">{tr('Newer')}</span>}
        </span>
        {body}
        {at && (
          <span className="mg-when">
            {side === 'mine'
              ? tr('You last edited it on {date}', { date: day(at) })
              : tr('{who} last edited it on {date}', { who, date: day(at) })}
          </span>
        )}
      </label>
    );
  };

  const title = (x: Question) => {
    const place = whereText(x.where);
    if (x.kind === 'field')
      return tr('Which {field} is right for {place}?', {
        field: tr(x.field),
        place,
      });
    if (x.kind === 'deleted')
      return x.by === 'theirs'
        ? tr('{who} deleted {place}, but you changed it', { who, place })
        : tr('You deleted {place}, but {who} changed it', { who, place });
    if (x.kind === 'timeline')
      return tr('You and {who} both added situation updates to {place}', {
        who,
        place,
      });
    return tr('You both changed the note “{place}”', { place });
  };
  const sub = (x: Question) =>
    x.kind === 'timeline'
      ? tr(
          'They go into the history by date. Untick any you do not want; the newest one kept becomes the current situation.',
        )
      : x.kind === 'note'
        ? tr(
            'Lines only one of you changed are already merged. Choose one version where you both changed the same lines, or keep both.',
          )
        : plan?.lastMergedAt
          ? tr('You both changed it since you last merged on {date}.', {
              date: day(plan.lastMergedAt),
            })
          : tr('The two copies have different values.');

  const context = (q?.context ?? []).filter(
    (c) => !(hide && c.mine === c.theirs),
  );
  const hidden = (q?.context ?? []).length - context.length;

  const next = () => {
    setWhole(false);
    if (step === 'summary') {
      if (qs.length) {
        setStep('q');
        setI(0);
      } else setStep('review');
    } else if (step === 'q') {
      if (i < qs.length - 1) setI(i + 1);
      else setStep('review');
    } else void merge();
  };
  const back = () => {
    setWhole(false);
    if (step === 'summary') onClose();
    else if (step === 'q') {
      if (i > 0) setI(i - 1);
      else setStep('summary');
    } else if (qs.length) {
      setStep('q');
      setI(qs.length - 1);
    } else setStep('summary');
  };
  const useNewer = () => {
    setAnswers((a) => {
      const n = { ...a };
      for (const x of qs.slice(i)) if (!n[x.id]) n[x.id] = x.suggest;
      return n;
    });
    setStep('review');
  };

  return createPortal(
    <div
      className="mg"
      role="dialog"
      aria-modal="true"
      aria-label={tr('Merge')}
    >
      <header className="mg-head">
        <span className="mg-title">
          <small>{tr('Merge {who}’s copy into', { who })}</small>
          <b>{plan?.projectName ?? ''}</b>
        </span>
        <ol className="mg-steps" aria-label={tr('Steps')}>
          {steps.map((t, k) => (
            <li
              key={t}
              className={k === stepIdx ? 'now' : k < stepIdx ? 'done' : ''}
            >
              <span className="n">
                {k < stepIdx ? <Icon name="check" /> : k + 1}
              </span>
              {t}
            </li>
          ))}
        </ol>
        <button
          className="icon-btn"
          aria-label={tr('Close')}
          title={tr('Close')}
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
      </header>

      <main className="mg-main">
        {!plan ? (
          <p className="muted mg-wait">{tr('Comparing the two copies…')}</p>
        ) : step === 'summary' ? (
          <div className="mg-col">
            <div>
              <h1>
                {plan.auto.length + qs.length === 0
                  ? tr(
                      'Nothing new: your project already has everything in this copy.',
                    )
                  : plan.lastMergedAt
                    ? tr(
                        'Here is what changed since you last merged on {date}',
                        {
                          date: day(plan.lastMergedAt),
                        },
                      )
                    : tr('Here is how the two copies differ')}
              </h1>
              <p className="mg-sub">
                {plan.lastMergedAt
                  ? tr(
                      'Most of it comes in by itself. You only decide where you both changed the same thing.',
                    )
                  : tr(
                      'This is the first merge of these copies, so every difference is a question; next time only real conflicts are.',
                    )}
              </p>
            </div>
            <div className="mg-stats">
              <div className="mg-stat auto">
                <span className="ico">
                  <Icon name="check" />
                </span>
                <span>
                  <b>{autoOn}</b>
                  <small>{tr('added by itself')}</small>
                </span>
              </div>
              <div className="mg-stat ask">
                <span className="ico">?</span>
                <span>
                  <b>{qs.length}</b>
                  <small>
                    {qs.length === 1
                      ? tr('question for you')
                      : tr('questions for you')}
                  </small>
                </span>
              </div>
            </div>
            {plan.auto.length > 0 && (
              <section className="mg-auto" aria-label={tr('Added by itself')}>
                <h2>
                  {tr('Added by itself')}{' '}
                  <small>{tr('Untick anything you do not want.')}</small>
                </h2>
                {plan.auto.map((a) => (
                  <label
                    key={a.id}
                    className={`mg-inc ${off.has(a.id) ? 'off' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={!off.has(a.id)}
                      onChange={() => toggle(a.id)}
                    />
                    <span className="mg-tag">{tr(a.tag)}</span>
                    <span className="mg-inc-text">
                      <b>{whereText(a.where)}</b>
                      <small>{autoText(a)}</small>
                    </span>
                  </label>
                ))}
              </section>
            )}
          </div>
        ) : step === 'q' && q ? (
          <div className="mg-col wide">
            <div className="mg-qhead">
              <span className="mg-qpos">
                {tr('Question {n} of {total}', { n: i + 1, total: qs.length })}
              </span>
              <span className="mg-dots" aria-hidden="true">
                {qs.map((x, k) => (
                  <span
                    key={x.id}
                    className={k === i ? 'now' : k < i ? 'done' : ''}
                  />
                ))}
              </span>
              <span className="mg-place">{whereText(q.where)}</span>
            </div>
            <div>
              <h1>{title(q)}</h1>
              <p className="mg-sub">{sub(q)}</p>
            </div>
            {q.kind === 'timeline' ? (
              <div className="mg-tl">
                {q.updates.map((u, k) => {
                  const kept = !off.has(`upd:${u.id}`);
                  return (
                    <div key={u.id} className="mg-tl-row">
                      <span className="mg-tl-rail">
                        <span className={`dot ${u.side} ${kept ? 'on' : ''}`} />
                        {k < q.updates.length - 1 && <span className="line" />}
                      </span>
                      <label
                        className={`mg-tl-card ${u.side} ${kept ? '' : 'off'} ${u.id === currentId ? 'now' : ''}`}
                      >
                        <span className="mg-tl-top">
                          <span className="mono">{when(u.at)}</span>
                          <span className="muted">
                            {u.side === 'mine'
                              ? tr('by you')
                              : u.side === 'theirs'
                                ? tr('by {who}', { who })
                                : tr('in both copies')}
                          </span>
                          {u.side === 'theirs' && (
                            <span className="mg-pill theirs">
                              {tr('New from {who}', { who })}
                            </span>
                          )}
                          {u.id === currentId && (
                            <span className="mg-pill now">
                              {tr('Current situation')}
                            </span>
                          )}
                          {u.side !== 'both' && (
                            <span className="mg-keep">
                              <input
                                type="checkbox"
                                checked={kept}
                                onChange={() => toggle(`upd:${u.id}`)}
                              />
                              {tr('Keep')}
                            </span>
                          )}
                        </span>
                        {u.doingNow && (
                          <span className="mg-tl-text">
                            <b>{tr('Doing now:')}</b> {u.doingNow}
                          </span>
                        )}
                        {(u.nextStep || u.handledBy) && (
                          <span className="mg-tl-next">
                            {u.nextStep &&
                              `${tr('Next:')} ${u.nextStep}${u.nextDate ? ` · ${shortDate(u.nextDate)}` : ''}`}
                            {u.handledBy &&
                              ` · ${tr('Handled by')} ${u.handledBy}`}
                          </span>
                        )}
                      </label>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div role="radiogroup" aria-label={title(q)} className="mg-cards">
                {card(q, 'mine')}
                {card(q, 'theirs')}
              </div>
            )}
            {q.kind === 'note' && (
              <>
                <label
                  className={`mg-inc both ${pick(q) === 'both' ? 'on' : ''}`}
                >
                  <input
                    type="radio"
                    name={`pick-${q.id}`}
                    checked={pick(q) === 'both'}
                    onChange={() =>
                      setAnswers((a) => ({ ...a, [q.id]: 'both' }))
                    }
                  />
                  <span className="mg-inc-text">
                    <b>{tr('Keep both')}</b>
                    <small>
                      {tr(
                        'Your lines and {who}’s lines both stay, each once.',
                        { who },
                      )}
                    </small>
                  </span>
                </label>
                <section
                  className="mg-preview"
                  aria-label={tr('Result preview')}
                >
                  <h2>{tr('Result preview')}</h2>
                  <pre>{q.results[pick(q)]}</pre>
                </section>
              </>
            )}
            {(q.context?.length ?? 0) > 0 && (
              <div className="mg-whole">
                <button
                  className="btn ghost"
                  aria-expanded={whole}
                  onClick={() => setWhole((w) => !w)}
                >
                  <Icon name="chev" className={whole ? 'up' : ''} />
                  {whole
                    ? tr('Hide the rest of the task')
                    : tr('See the rest of the task')}
                </button>
                {whole && (
                  <div className="mg-ctx">
                    <div className="mg-ctx-head">
                      <span className="muted">
                        {tr(
                          'The rest of the task, yours and {who}’s side by side',
                          { who },
                        )}
                      </span>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={hide}
                          onChange={(e) => setHide(e.target.checked)}
                        />{' '}
                        {tr('Hide identical content')}
                      </label>
                    </div>
                    {context.map((c) => (
                      <div key={c.field} className="mg-ctx-row">
                        <span className="muted">{tr(c.field)}</span>
                        <span>{c.mine || '—'}</span>
                        <span
                          className={c.mine === c.theirs ? 'muted' : 'theirs'}
                        >
                          {c.mine === c.theirs ? tr('Same') : c.theirs || '—'}
                        </span>
                      </div>
                    ))}
                    {hide && hidden > 0 && (
                      <p className="muted mg-ctx-foot">
                        {tr(
                          hidden === 1
                            ? '1 field is the same on both sides and is hidden.'
                            : '{n} fields are the same on both sides and are hidden.',
                          { n: hidden },
                        )}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="mg-col">
            <div>
              <h1>{tr('Ready to merge')}</h1>
              <p className="mg-sub">
                {tr(
                  'Check your answers. Nothing changes until you press Merge.',
                )}
              </p>
            </div>
            <section className="mg-review" aria-label={tr('Your answers')}>
              {qs.map((x, k) => (
                <div key={x.id} className="mg-review-row">
                  <span
                    className={`mg-who ${x.kind === 'timeline' ? 'both' : pick(x)}`}
                  >
                    {x.kind === 'timeline' || pick(x) === 'both'
                      ? '+'
                      : pick(x) === 'mine'
                        ? tr('You').slice(0, 1)
                        : who.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="mg-inc-text">
                    <span>{answerText(x)}</span>
                    <small>{whereText(x.where)}</small>
                  </span>
                  <button
                    className="btn sm"
                    onClick={() => {
                      setStep('q');
                      setI(k);
                    }}
                  >
                    {tr('Change')}
                  </button>
                </div>
              ))}
              <div className="mg-review-row auto">
                <span className="mg-who both">
                  <Icon name="check" />
                </span>
                <span className="mg-inc-text">
                  <span>
                    {tr(
                      autoOn === 1
                        ? '1 more change comes in by itself'
                        : '{n} more changes come in by itself',
                      { n: autoOn },
                    )}
                  </span>
                </span>
                <button className="btn sm" onClick={() => setStep('summary')}>
                  {tr('See them')}
                </button>
              </div>
            </section>
            <p className="mg-safe">
              <Icon name="shield" />
              {tr(
                'WorkSync makes a backup first. If something looks wrong afterwards, restore it from Settings › Backups.',
              )}
            </p>
          </div>
        )}
      </main>

      <footer className="mg-foot">
        <button className="btn" onClick={back} disabled={busy}>
          {step === 'summary' ? tr('Cancel') : tr('Back')}
        </button>
        <span className="grow" />
        {step === 'q' && qs.length - i > 1 && (
          <button className="btn ghost" onClick={useNewer}>
            {tr('Use the suggestion for the rest')}
          </button>
        )}
        <button className="btn primary" onClick={next} disabled={!plan || busy}>
          {step === 'summary'
            ? qs.length
              ? tr(
                  qs.length === 1
                    ? 'Start: 1 question'
                    : 'Start: {n} questions',
                  { n: qs.length },
                )
              : tr('Review')
            : step === 'q'
              ? i < qs.length - 1
                ? tr('Next question')
                : tr('Review')
              : busy
                ? tr('Merging…')
                : tr('Merge now')}
        </button>
      </footer>
    </div>,
    document.body,
  );
}
