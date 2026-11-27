import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RecipeAnswer, RecipeAsk, RecipeLinkable } from '../shared/ipc';
import { translateMessage } from '../shared/i18n';
import {
  DEFAULT_FOLLOWUPS,
  FILL_FROM,
  allText,
  buildRequest,
  missingBlanks,
  readRecipeAnswer,
  syncBlanks,
  type AnswerSection,
  type Blank,
  type BlankKind,
  type FillFrom,
  type Recipe,
  type RecipeLink,
  type RecipeRun,
} from '../shared/recipes';
import { AiNotWorking, openAiSettings, useAi } from './aiActions';
import { useApp } from './appState';
import { Icon } from './Icon';
import { tr, uiLanguage } from './i18n';
import type { HeaderSlot } from './mine';
import { confirmDelete, Modal } from './parts';

/** Languages offered by a language blank; any other can be typed in a recipe's choices. */
const LANGS = [
  'Japanese',
  'English',
  'Vietnamese',
  'Chinese (Simplified)',
  'Korean',
];

const KINDS: [BlankKind, string][] = [
  ['short', 'Short text'],
  ['long', 'Long text'],
  ['choice', 'Choice'],
  ['language', 'Language'],
  ['person', 'Person in the project'],
];

const when = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

interface Shown {
  request: string;
  answer: string;
  sections: AnswerSection[];
  ok: boolean;
  provider: string;
}

const fromRun = (r: Recipe, run: RecipeRun): Shown => ({
  request: run.request,
  answer: run.answer,
  provider: run.provider,
  ...readRecipeAnswer(run.answer, r.sections),
});

/**
 * Recipes (doc 12): every recipe under Mine, or one project's recipes in its
 * menu. Pick one, fill the blanks, Run, copy the answer.
 */
export function RecipesView({
  projectId,
  query,
  head,
}: {
  /** Set for a project's Recipes view: its recipes, and new ones go there. */
  projectId?: string;
  query: string;
  head: HeaderSlot;
}) {
  const { attempt, projects, project, toast } = useApp();
  const ai = useAi();
  const [list, setList] = useState<Recipe[] | null>(null);
  const [scope, setScope] = useState<'any' | 'none' | string>('any');
  const [sel, setSel] = useState<string | null>(null);
  const [editing, setEditing] = useState<Recipe | 'new' | null>(null);
  const inProject = projectId ? project(projectId) : null;

  const load = async () => {
    const l = await attempt(() => window.worksync.listRecipes());
    if (l) setList(l);
    return l;
  };
  useEffect(() => {
    void load();
    // Once, when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (list ?? []).filter(
        (r) =>
          (projectId
            ? r.projectId === projectId
            : scope === 'any' ||
              (scope === 'none' ? !r.projectId : r.projectId === scope)) &&
          (!q ||
            r.name.toLowerCase().includes(q) ||
            r.description.toLowerCase().includes(q)),
      ),
    [list, projectId, scope, q],
  );
  const cur = (list ?? []).find((r) => r.id === sel) ?? null;
  useEffect(() => {
    if ((!cur || !shown.includes(cur)) && shown.length) setSel(shown[0].id);
    // When the selection is gone or filtered out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  const saved = async (r: Recipe) => {
    setEditing(null);
    await load();
    setSel(r.id);
    toast(tr('Saved the recipe “{name}”.', { name: r.name }));
  };

  return (
    <div className="mine-page rc-page">
      {head &&
        createPortal(
          <div className="vh">
            <div>
              <h1>{tr('Recipes')}</h1>
              <div className="sub">
                {inProject
                  ? tr(
                      '{name} · recipes of this project. They also appear in Recipes, with all your other recipes.',
                      { name: inProject.name },
                    )
                  : tr(
                      'AI requests you write once and fill in each time. A recipe can belong to a project, or to none.',
                    )}
              </div>
            </div>
            <button className="btn primary" onClick={() => setEditing('new')}>
              <Icon name="plus" />
              {inProject ? tr('New recipe in this project') : tr('New recipe')}
            </button>
          </div>,
          head,
        )}
      {!projectId && (
        <div className="notes-tools">
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
          <span className="muted notes-count">
            {tr(shown.length === 1 ? '{n} recipe' : '{n} recipes', {
              n: shown.length,
            })}
          </span>
        </div>
      )}
      <div className="rc-body">
        <div className="rc-list" role="list" aria-label={tr('Recipes')}>
          {shown.map((r) => (
            <button
              key={r.id}
              role="listitem"
              className={`rc-item ${r.id === sel ? 'sel' : ''}`}
              onClick={() => setSel(r.id)}
            >
              <b>{tr(r.name)}</b>
              {r.description && <small>{tr(r.description)}</small>}
              <span className="rc-item-meta">
                <span className={`rc-proj ${r.projectId ? 'p' : ''}`}>
                  {r.projectId
                    ? (project(r.projectId)?.name ?? tr('Project'))
                    : tr('Personal')}
                </span>
              </span>
            </button>
          ))}
          {list && !shown.length && (
            <div className="empty">
              {list.length
                ? tr('No recipe matches. Try another filter.')
                : tr('No recipes yet. Choose New recipe to write one.')}
            </div>
          )}
        </div>
        <section className="rc-main" aria-label={tr('Recipe')}>
          {cur ? (
            <RecipeRunner
              key={cur.id}
              recipe={cur}
              onEdit={() => setEditing(cur)}
              ai={ai}
              onRemembered={() => void load()}
            />
          ) : (
            <div className="empty">
              {tr('Choose a recipe, or make a new one.')}
            </div>
          )}
        </section>
      </div>
      {editing && (
        <RecipeEditor
          recipe={editing === 'new' ? null : editing}
          projectId={
            projectId ?? (scope !== 'any' && scope !== 'none' ? scope : null)
          }
          onClose={() => setEditing(null)}
          onSaved={(r) => void saved(r)}
          onDeleted={async () => {
            setEditing(null);
            setSel(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

/** Fill the blanks, optionally link a ticket, run, and copy the answer. */
function RecipeRunner({
  recipe,
  onEdit,
  ai,
  onRemembered,
}: {
  recipe: Recipe;
  onEdit: () => void;
  ai: ReturnType<typeof useAi>;
  onRemembered: () => void;
}) {
  const { attempt, toast, people, project } = useApp();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(recipe.blanks.map((b) => [b.key, b.last])),
  );
  const [link, setLink] = useState<RecipeLink | null>(null);
  const [filled, setFilled] = useState<Set<string>>(new Set());
  const [picking, setPicking] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const [runs, setRuns] = useState<RecipeRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [own, setOwn] = useState('');
  /** Copy for AI: the request copied, waiting for the answer to be pasted. */
  const [pasting, setPasting] = useState<{
    ask: RecipeAsk;
    request: string;
  } | null>(null);
  const [pasted, setPasted] = useState('');

  const loadRuns = async () =>
    setRuns((await attempt(() => window.worksync.recipeRuns(recipe.id))) ?? []);
  useEffect(() => {
    void loadRuns();
    // Once per recipe (the component is keyed by it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const missing = missingBlanks(recipe, values);
  const projectId = link?.projectId ?? recipe.projectId;
  const names = people.filter((p) => p.projectId === projectId);

  const set = (k: string, v: string) => {
    setValues({ ...values, [k]: v });
    if (filled.has(k)) setFilled(new Set([...filled].filter((x) => x !== k)));
  };

  const linkTo = async (l: RecipeLink | null) => {
    setPicking(false);
    setLink(l);
    if (!l) {
      setFilled(new Set());
      return;
    }
    const f = await attempt(() => window.worksync.recipeFill(l));
    if (!f) return;
    const next = { ...values };
    const got = new Set<string>();
    for (const b of recipe.blanks)
      if (b.from && f[b.from]?.trim()) {
        next[b.key] = f[b.from];
        got.add(b.key);
      }
    setValues(next);
    setFilled(got);
  };

  const done = (r: RecipeAnswer) => {
    setShown({
      request: r.run.request,
      answer: r.run.answer,
      provider: r.run.provider,
      sections: r.sections,
      ok: r.ok,
    });
    setPasting(null);
    setPasted('');
    void loadRuns();
    onRemembered();
  };

  const ask = (followUp?: string): RecipeAsk => ({
    recipeId: recipe.id,
    values,
    link,
    ...(followUp && shown
      ? {
          followUp: {
            request: shown.request,
            answer: shown.answer,
            ask: followUp,
          },
        }
      : {}),
  });

  const run = async (followUp?: string) => {
    const a = ask(followUp);
    if (!ai.usable) {
      // Copy for AI: the same request, pasted into any AI chat.
      const request = await attempt(() => window.worksync.recipeRequest(a));
      if (request === undefined) return;
      await attempt(() => window.worksync.copyText(request));
      setPasting({ ask: a, request });
      setPasted('');
      toast(
        tr(
          'Request copied. Paste it into any AI chat, then paste its whole answer here.',
        ),
      );
      return;
    }
    setBusy(true);
    try {
      done(await window.worksync.runRecipe(a));
      setOwn('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'Cancelled.') toast(tr('Cancelled.'));
      else
        toast(
          `${translateMessage(uiLanguage(), msg)} ${tr('Until it works again, use Copy for AI.')}`,
          { label: 'Open settings', run: openAiSettings },
          true,
        );
    } finally {
      setBusy(false);
    }
  };

  const showPasted = async () => {
    if (!pasting || !pasted.trim()) return;
    const r = await attempt(() =>
      window.worksync.pasteRecipeAnswer({
        ...pasting.ask,
        request: pasting.request,
        answer: pasted,
      }),
    );
    if (r) done(r);
  };

  const copy = async (text: string) => {
    if (await attempt(() => window.worksync.copyText(text).then(() => true)))
      toast(tr('Copied.'));
  };

  const open = (r: RecipeRun) => {
    setValues({ ...values, ...r.values });
    setLink(r.link);
    setFilled(new Set());
    setShown(fromRun(recipe, r));
    setPasting(null);
  };

  const followups = recipe.followups.length
    ? recipe.followups
    : DEFAULT_FOLLOWUPS;

  return (
    <div className="rc-run">
      <div className="rc-card">
        <div className="rc-head">
          <div className="rc-title">
            <h2>{tr(recipe.name)}</h2>
            {recipe.description && (
              <span className="muted">{tr(recipe.description)}</span>
            )}
          </div>
          {link ? (
            <span className="rc-link">
              <Icon name="link" />
              <span>
                {link.label}
                {project(link.projectId)
                  ? ` · ${project(link.projectId)!.name}`
                  : ''}
              </span>
              <button
                className="icon-btn sm"
                aria-label={tr('Unlink')}
                title={tr('Unlink')}
                onClick={() => void linkTo(null)}
              >
                <Icon name="x" />
              </button>
            </span>
          ) : (
            <button
              className="btn sm rc-linkbtn"
              onClick={() => setPicking(true)}
            >
              <Icon name="link" />
              {tr('Link a ticket (optional)')}
            </button>
          )}
          <button className="btn sm" onClick={onEdit}>
            <Icon name="edit" />
            {tr('Edit recipe')}
          </button>
        </div>

        {!recipe.blanks.length && (
          <p className="muted">
            {tr(
              'This recipe has no blanks: Run sends its instructions as they are.',
            )}
          </p>
        )}
        <div className="rc-blanks">
          {recipe.blanks.map((b) => (
            <BlankField
              key={b.key}
              blank={b}
              value={values[b.key] ?? ''}
              onChange={(v) => set(b.key, v)}
              fromTicket={filled.has(b.key)}
              names={names.map((p) => p.displayName || p.name)}
            />
          ))}
        </div>

        <div className="rc-actions">
          {ai.usable ? (
            <button
              className="btn primary rc-runbtn"
              disabled={!!missing.length || busy || ai.busy}
              title={
                missing.length
                  ? tr('Fill in: {list}', {
                      list: missing.map((b) => b.label).join(', '),
                    })
                  : undefined
              }
              onClick={() => void run()}
            >
              {busy ? (
                <span className="ai-spin" aria-hidden="true" />
              ) : (
                <Icon name="spark" />
              )}
              {busy ? tr('Running…') : tr('Run')}
              <span
                className={`ai-dot ${ai.status?.state === 'ok' ? 'ok' : 'checking'}`}
                aria-hidden="true"
              />
            </button>
          ) : (
            <>
              <AiNotWorking />
              <button
                className="btn primary"
                disabled={!!missing.length}
                onClick={() => void run()}
              >
                <Icon name="copy" />
                {tr('Copy for AI')}
              </button>
            </>
          )}
          <span className="muted rc-note">
            {ai.usable
              ? tr(
                  'Only the instructions and these blanks are sent{glossary}.',
                  {
                    glossary: projectId
                      ? tr(', with the project’s glossary')
                      : '',
                  },
                )
              : tr(
                  'Paste it into any AI chat, then paste its whole answer below.',
                )}
          </span>
          <span className="grow" />
          <button
            className="btn sm"
            onClick={() => {
              setValues(
                Object.fromEntries(recipe.blanks.map((b) => [b.key, ''])),
              );
              setFilled(new Set());
            }}
          >
            {tr('Clear')}
          </button>
        </div>

        {pasting && (
          <div className="rc-paste">
            <label className="form-inline">
              {tr('The AI’s answer')}
              <textarea
                className="inp mono"
                rows={6}
                value={pasted}
                autoFocus
                onChange={(e) => setPasted(e.target.value)}
              />
            </label>
            <div className="rc-actions">
              <button
                className="btn primary"
                disabled={!pasted.trim()}
                onClick={() => void showPasted()}
              >
                {tr('Show the answer')}
              </button>
              <button
                className="btn sm"
                onClick={() => void copy(pasting.request)}
              >
                <Icon name="copy" />
                {tr('Copy the request again')}
              </button>
            </div>
          </div>
        )}
      </div>

      {shown && (
        <div
          className="rc-card rc-answer"
          role="region"
          aria-label={tr('Answer')}
        >
          <div className="rc-head">
            <b className="grow">{tr('Answer')}</b>
            <span className="muted">{shown.provider}</span>
            <button
              className="btn sm"
              onClick={() => void copy(allText(shown.sections))}
            >
              <Icon name="copy" />
              {tr('Copy all')}
            </button>
          </div>
          {!shown.ok && (
            <p className="warn-text">
              {tr(
                'The answer did not come in the recipe’s sections, so it is shown as one block.',
              )}
            </p>
          )}
          {shown.sections.map((s, i) => (
            <div className="rc-sec" key={`${s.title}-${i}`}>
              <div className="rc-sec-head">
                <b className="grow">{s.title || tr('Answer')}</b>
                <button
                  className="btn sm rc-copy"
                  disabled={!s.text}
                  onClick={() => void copy(s.text)}
                >
                  {tr('Copy')}
                </button>
              </div>
              <div className="rc-sec-text">{s.text || '—'}</div>
            </div>
          ))}
          <div className="rc-follow">
            <span className="muted">{tr('Ask again:')}</span>
            {followups.map((f) => (
              <button
                key={f}
                className="rc-chip"
                disabled={busy || ai.busy}
                onClick={() => void run(f)}
              >
                {tr(f)}
              </button>
            ))}
            <form
              className="rc-own"
              onSubmit={(e) => {
                e.preventDefault();
                if (own.trim()) void run(own.trim());
              }}
            >
              <input
                className="inp"
                aria-label={tr('Your own follow-up')}
                placeholder={tr('Or say what to change…')}
                value={own}
                onChange={(e) => setOwn(e.target.value)}
              />
            </form>
          </div>
        </div>
      )}

      <div className="rc-card rc-history">
        <div className="rc-head">
          <b className="grow">{tr('Last 5 runs of this recipe')}</b>
          <span className="muted">
            {tr('Kept on this PC only. Older runs are removed.')}
          </span>
        </div>
        {runs.length ? (
          runs.map((r) => (
            <div className="rc-hrow" key={r.id}>
              <span className="mono muted">{when(r.at)}</span>
              <span className="rc-hsum">
                {Object.values(r.values).find((v) => v.trim().length > 20) ??
                  Object.values(r.values).join(' · ') ??
                  ''}
              </span>
              {r.link && <span className="rc-proj p">{r.link.label}</span>}
              <button className="btn sm" onClick={() => open(r)}>
                {tr('Open')}
              </button>
            </div>
          ))
        ) : (
          <p className="muted">{tr('No runs yet.')}</p>
        )}
      </div>

      {picking && (
        <LinkPicker
          projectId={recipe.projectId}
          onPick={(l) => void linkTo(l)}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

function BlankField({
  blank: b,
  value,
  onChange,
  fromTicket,
  names,
}: {
  blank: Blank;
  value: string;
  onChange: (v: string) => void;
  fromTicket: boolean;
  names: string[];
}) {
  const id = `rc-b-${b.key.replace(/\W/g, '_')}`;
  const options = (xs: string[]) => [
    ...new Set([...xs, ...(value ? [value] : [])]),
  ];
  return (
    <label
      className={`rc-field ${b.kind === 'long' ? 'wide' : ''}`}
      htmlFor={id}
    >
      <span className="rc-label">
        {tr(b.label)}
        {b.remember && <span className="rc-tag">{tr('remembered')}</span>}
        {fromTicket && (
          <span className="rc-tag t">{tr('filled from the ticket')}</span>
        )}
      </span>
      {b.kind === 'long' ? (
        <textarea
          id={id}
          className="inp"
          rows={5}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : b.kind === 'choice' || b.kind === 'language' ? (
        <select
          id={id}
          className="inp"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">{tr('Choose…')}</option>
          {options(b.kind === 'language' ? LANGS : b.choices).map((o) => (
            <option key={o} value={o}>
              {b.kind === 'language' ? tr(o) : o}
            </option>
          ))}
        </select>
      ) : (
        <>
          <input
            id={id}
            className="inp"
            value={value}
            list={
              b.kind === 'person' && names.length ? `${id}-names` : undefined
            }
            onChange={(e) => onChange(e.target.value)}
          />
          {b.kind === 'person' && names.length > 0 && (
            <datalist id={`${id}-names`}>
              {names.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          )}
        </>
      )}
    </label>
  );
}

/** Picks the ticket or discussion a run takes text from. */
function LinkPicker({
  projectId,
  onPick,
  onClose,
}: {
  projectId: string | null;
  onPick: (l: RecipeLink) => void;
  onClose: () => void;
}) {
  const { attempt, projects } = useApp();
  const [all, setAll] = useState<RecipeLinkable[] | null>(null);
  const [q, setQ] = useState('');
  const [scope, setScope] = useState(projectId ?? 'any');
  useEffect(() => {
    void attempt(() => window.worksync.recipeLinkables()).then(
      (l) => l && setAll(l),
    );
    // Once, when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const s = q.trim().toLowerCase();
  const shown = (all ?? [])
    .filter(
      (x) =>
        (scope === 'any' || x.projectId === scope) &&
        (!s ||
          x.no.toLowerCase().includes(s) ||
          x.title.toLowerCase().includes(s)),
    )
    .slice(0, 200);
  return (
    <Modal
      title={tr('Link a ticket to this run')}
      subtitle={tr(
        'Optional. Its text can fill blanks, and its project’s glossary and people are used. Nothing is added to the ticket.',
      )}
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          {tr('Cancel')}
        </button>
      }
    >
      <div className="rc-pick-tools">
        <input
          className="inp"
          aria-label={tr('Search tickets')}
          placeholder={tr('No. or title')}
          value={q}
          autoFocus
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className="inp"
          aria-label={tr('Project')}
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        >
          <option value="any">{tr('All projects')}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="rc-pick-list" role="list">
        {shown.map((x) => (
          <button
            key={`${x.kind}:${x.id}`}
            role="listitem"
            className="rc-pick"
            onClick={() =>
              onPick({
                kind: x.kind,
                id: x.id,
                projectId: x.projectId,
                label: x.label,
              })
            }
          >
            <span className="mono muted">{x.no || '—'}</span>
            <span className="grow">
              <b>{x.title}</b>
              <small className="muted">{x.project}</small>
            </span>
            <span className="rc-proj">
              {x.kind === 'ticket' ? tr('Ticket') : tr('Discussion')}
            </span>
          </button>
        ))}
        {all && !shown.length && (
          <p className="muted">{tr('Nothing matches.')}</p>
        )}
      </div>
    </Modal>
  );
}

/** Adds or changes a recipe. */
function RecipeEditor({
  recipe,
  projectId,
  onClose,
  onSaved,
  onDeleted,
}: {
  recipe: Recipe | null;
  projectId: string | null;
  onClose: () => void;
  onSaved: (r: Recipe) => void;
  onDeleted: () => Promise<void>;
}) {
  const { attempt, projects, toast } = useApp();
  const [name, setName] = useState(recipe?.name ?? '');
  const [pid, setPid] = useState<string | null>(
    recipe ? recipe.projectId : projectId,
  );
  const [description, setDescription] = useState(recipe?.description ?? '');
  const [instructions, setInstructions] = useState(recipe?.instructions ?? '');
  const [blanks, setBlanks] = useState<Blank[]>(recipe?.blanks ?? []);
  const [sections, setSections] = useState((recipe?.sections ?? []).join('\n'));
  const [followups, setFollowups] = useState(
    (recipe?.followups ?? DEFAULT_FOLLOWUPS).join('\n'),
  );
  const live = syncBlanks(instructions, blanks);
  const setBlank = (key: string, patch: Partial<Blank>) =>
    setBlanks(live.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  const lines = (s: string) =>
    s
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
  const input = {
    projectId: pid,
    name,
    description,
    instructions,
    blanks: live,
    sections: lines(sections),
    followups: lines(followups),
  };
  const preview = buildRequest(
    input,
    Object.fromEntries(live.map((b) => [b.key, b.last || `[${b.label}]`])),
  );

  const save = async () => {
    const r = await attempt(() =>
      window.worksync.saveRecipe(input, recipe?.id),
    );
    if (r) onSaved(r);
  };
  const duplicate = async () => {
    const r = await attempt(() =>
      window.worksync.saveRecipe({
        ...input,
        name: tr('{name} (copy)', { name: name.trim() || tr('Recipe') }),
      }),
    );
    if (r) onSaved(r);
  };
  const remove = async () => {
    if (!recipe) return;
    if (
      !(await confirmDelete({
        title: tr('Delete the recipe “{name}”?', { name: recipe.name }),
        text: tr('The recipe and its last runs are deleted.'),
        yes: tr('Delete recipe'),
      }))
    )
      return;
    if (
      await attempt(() =>
        window.worksync.deleteRecipe(recipe.id).then(() => true),
      )
    ) {
      toast(tr('Deleted “{name}”.', { name: recipe.name }));
      await onDeleted();
    }
  };
  const brace = (s: string) => `{{${s}}}`;

  return (
    <Modal
      title={recipe ? tr('Edit recipe') : tr('New recipe')}
      subtitle={tr(
        'Write what you want once. Put each part that changes in double braces, such as {example}: it becomes a blank.',
        { example: brace('customer') },
      )}
      onClose={onClose}
      wide
      footer={
        <>
          {recipe && (
            <>
              <button className="btn rc-del" onClick={() => void remove()}>
                <Icon name="trash" />
                {tr('Delete')}
              </button>
              <button className="btn" onClick={() => void duplicate()}>
                <Icon name="copy" />
                {tr('Duplicate')}
              </button>
            </>
          )}
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button
            className="btn primary"
            disabled={!name.trim()}
            onClick={() => void save()}
          >
            {tr('Save')}
          </button>
        </>
      }
    >
      <div className="rc-edit">
        <div className="form rc-edit-main">
          <div className="two">
            <label>
              {tr('Name')}
              <input
                className="inp"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              {tr('Project')}
              <select
                className="inp"
                value={pid ?? ''}
                onChange={(e) => setPid(e.target.value || null)}
              >
                <option value="">
                  {tr('No project (personal, usable anywhere)')}
                </option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            {tr('Short description')}
            <input
              className="inp"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label>
            {tr('Instructions for the AI')}
            <textarea
              className="inp mono"
              rows={9}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={tr(
                'Rewrite the message below for {who}, politely, and answer with the message only.\n\nMessage:\n{message}',
                { who: brace('customer'), message: brace('message') },
              )}
            />
            <small className="muted">
              {tr(
                'Sent to the AI as you write it. To get only what you want to copy, say so, such as “Answer with the email only.”',
              )}
            </small>
          </label>

          <div className="rc-edit-sec">
            <b>{tr('Blanks')}</b>
            {live.length ? (
              <div className="tbl-wrap">
                <table className="rc-blank-tbl">
                  <thead>
                    <tr>
                      <th>{tr('Blank')}</th>
                      <th>{tr('Shown as')}</th>
                      <th>{tr('Kind')}</th>
                      <th>{tr('Remember')}</th>
                      <th>{tr('From a linked ticket')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {live.map((b) => (
                      <tr key={b.key}>
                        <td className="mono">{brace(b.key)}</td>
                        <td>
                          <input
                            className="inp"
                            aria-label={tr('Label of {blank}', {
                              blank: b.key,
                            })}
                            value={b.label}
                            onChange={(e) =>
                              setBlank(b.key, { label: e.target.value })
                            }
                          />
                          {b.kind === 'choice' && (
                            <input
                              className="inp rc-choices"
                              aria-label={tr('Choices of {blank}', {
                                blank: b.key,
                              })}
                              placeholder={tr('Choices, separated by commas')}
                              value={b.choices.join(', ')}
                              onChange={(e) =>
                                setBlank(b.key, {
                                  choices: e.target.value
                                    .split(',')
                                    .map((x) => x.trimStart()),
                                })
                              }
                            />
                          )}
                        </td>
                        <td>
                          <select
                            className="inp"
                            aria-label={tr('Kind of {blank}', { blank: b.key })}
                            value={b.kind}
                            onChange={(e) =>
                              setBlank(b.key, {
                                kind: e.target.value as BlankKind,
                              })
                            }
                          >
                            {KINDS.map(([k, l]) => (
                              <option key={k} value={k}>
                                {tr(l)}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <button
                            className="switch"
                            role="switch"
                            aria-checked={b.remember}
                            aria-label={tr(
                              'Remember the last value of {blank}',
                              {
                                blank: b.key,
                              },
                            )}
                            onClick={() =>
                              setBlank(b.key, { remember: !b.remember })
                            }
                          >
                            <span />
                          </button>
                        </td>
                        <td>
                          <select
                            className="inp"
                            aria-label={tr(
                              'Filled from a linked ticket: {blank}',
                              {
                                blank: b.key,
                              },
                            )}
                            value={b.from}
                            onChange={(e) =>
                              setBlank(b.key, {
                                from: e.target.value as FillFrom,
                              })
                            }
                          >
                            {FILL_FROM.map(([k, l]) => (
                              <option key={k} value={k}>
                                {tr(l)}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">
                {tr(
                  'No blanks yet. Add one by writing {example} in the instructions.',
                  {
                    example: brace('name'),
                  },
                )}
              </p>
            )}
            <small className="muted">
              {tr(
                'Every blank must be filled before Run, unless its label ends with “(optional)”.',
              )}
            </small>
          </div>

          <div className="two">
            <label>
              {tr('Answer sections (optional, one per line)')}
              <textarea
                className="inp"
                rows={4}
                value={sections}
                onChange={(e) => setSections(e.target.value)}
                placeholder={tr('Corrected\nTranslation')}
              />
              <small className="muted">
                {tr(
                  'Each section gets its own Copy. None: the whole answer, with one Copy.',
                )}
              </small>
            </label>
            <label>
              {tr('Follow-up buttons (one per line)')}
              <textarea
                className="inp"
                rows={4}
                value={followups}
                onChange={(e) => setFollowups(e.target.value)}
              />
              <small className="muted">
                {tr(
                  'Shown under the answer. Yours are sent as you write them.',
                )}
              </small>
            </label>
          </div>
        </div>
        <aside className="rc-preview" aria-label={tr('What the AI gets')}>
          <b>{tr('What the AI gets')}</b>
          <pre className="prompt">{preview || '—'}</pre>
          <small className="muted">
            {tr(
              'With a linked ticket or a project, the glossary terms used are added too. Nothing else is sent.',
            )}
          </small>
        </aside>
      </div>
    </Modal>
  );
}
