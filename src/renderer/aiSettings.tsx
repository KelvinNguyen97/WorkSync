import { useEffect, useState } from 'react';
import {
  AI_PROVIDER_NAME,
  AI_REQUEST_SIZES,
  isLocalAddress,
  type AiProviderKind,
} from '../shared/ai';
import { translateMessage } from '../shared/i18n';
import type { AppSettings } from '../shared/settings';
import { useApp } from './appState';
import { Icon } from './Icon';
import { tr, uiLanguage } from './i18n';

const PROVIDERS: { id: AiProviderKind; text: string }[] = [
  {
    id: 'claude',
    text: 'Uses the Claude Code on this PC, signed in with your account.',
  },
  {
    id: 'codex',
    text: 'Uses the Codex command line on this PC, signed in with your account.',
  },
  {
    id: 'local',
    text: 'A model running on this PC with Ollama or LM Studio. Nothing leaves the PC.',
  },
  {
    id: 'none',
    text: 'No AI connected. Copy each request and paste the answer yourself.',
  },
];

const SENT: Record<Exclude<AiProviderKind, 'none'>, string> = {
  claude:
    'Only the text an action needs is sent: the tickets’ text, your notes to translate, or a discussion’s new comments, with the project’s glossary. Claude Code runs in an empty folder with every tool turned off, so it can only answer: it can’t open or change files on this PC. Requests count against your own Claude plan.',
  codex:
    'Only the text an action needs is sent: the tickets’ text, your notes to translate, or a discussion’s new comments, with the project’s glossary. Codex runs in an empty folder in its read-only sandbox, so it can’t change files on this PC. Requests count against your own plan.',
  local:
    'The model only reads the request and writes an answer: it has no tools. A small model on a PC without a graphics card is slow and may not keep the answer format; WorkSync then fills nothing in. A 7B model or bigger, with Small requests, works best.',
};

const TIMES = [60, 120, 300, 600, 1200];

type Save = (patch: Partial<AppSettings>) => Promise<boolean>;

/** Settings › AI provider (doc 11): set up once, then the buttons do the job. */
export function AiSettings({ save }: { save: Save }) {
  const { settings, ai, attempt } = useApp();
  const p = settings.aiProvider;
  const status = ai?.status;
  const [testing, setTesting] = useState(false);
  const test = async () => {
    setTesting(true);
    await attempt(() => window.worksync.aiTest());
    setTesting(false);
  };
  const state =
    !status || status.provider !== p || p === 'none'
      ? null
      : testing || status.state === 'checking'
        ? 'checking'
        : status.state;
  return (
    <fieldset data-section="ai">
      <legend>{tr('AI provider')}</legend>
      <p className="set-intro">
        {tr(
          'The AI that Translate & summarize, Translate my notes and Summarize into progress use. Set it up once; the buttons then do the whole job, and you can undo it. If it stops working, the buttons go back to Copy for AI.',
        )}
      </p>
      <div className="ai-provs" role="group" aria-label={tr('AI provider')}>
        {PROVIDERS.map((x) => (
          <button
            key={x.id}
            className="ai-prov"
            aria-pressed={p === x.id}
            onClick={() => void save({ aiProvider: x.id })}
          >
            <b>
              <span className="ai-radio" aria-hidden="true" />
              {x.id === 'none'
                ? tr('None: Copy for AI')
                : tr(AI_PROVIDER_NAME[x.id])}
            </b>
            <small>{tr(x.text)}</small>
          </button>
        ))}
      </div>

      {(p === 'claude' || p === 'codex') && (
        <CliSetup key={p} cli={p} save={save} />
      )}
      {p === 'local' && <LocalSetup save={save} />}

      {p !== 'none' && (
        <>
          <div className="ai-test">
            <button
              className="btn primary sm"
              disabled={testing}
              onClick={() => void test()}
            >
              {testing ? tr('Testing…') : tr('Test')}
            </button>
            <span className={`ai-test-state ${state ?? ''}`} role="status">
              <span
                className={`ai-dot ${state === 'ok' ? 'ok' : state === 'failed' ? 'bad' : 'checking'}`}
                aria-hidden="true"
              />
              {state === 'ok'
                ? `${tr('Working')} · ${(status?.detail ?? '').replace(/answered in (\d+) s/, (_, n: string) => tr('answered in {n} s', { n }))}${status?.testedAt ? ` · ${tr('tested {time}', { time: new Date(status.testedAt).toLocaleString() })}` : ` · ${tr('not tested yet')}`}`
                : state === 'failed'
                  ? `${tr('Not working:')} ${translateMessage(uiLanguage(), status?.reason ?? '')}`
                  : tr('Checking…')}
            </span>
          </div>
          <small className="muted">
            {tr(
              'Test sends one tiny request, so it also checks that you are signed in.',
            )}
          </small>

          <div className="two">
            <label>
              {tr('Give up after')}
              <select
                className="inp"
                value={settings.aiTimeoutSec}
                onChange={(e) =>
                  void save({ aiTimeoutSec: Number(e.target.value) })
                }
              >
                {[...new Set([...TIMES, settings.aiTimeoutSec])]
                  .sort((a, b) => a - b)
                  .map((t) => (
                    <option key={t} value={t}>
                      {t < 120
                        ? tr('{n} seconds per request', { n: t })
                        : tr('{n} minutes per request', { n: t / 60 })}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              {tr('Request size')}
              <select
                className="inp"
                value={settings.aiRequestSize}
                onChange={(e) =>
                  void save({ aiRequestSize: Number(e.target.value) })
                }
              >
                {[...new Set([...AI_REQUEST_SIZES, settings.aiRequestSize])]
                  .sort((a, b) => a - b)
                  .map((n) => (
                    <option key={n} value={n}>
                      {n === 8000
                        ? tr('Small (8,000 characters)')
                        : n === 20000
                          ? tr('Normal (20,000 characters)')
                          : n === 40000
                            ? tr('Large (40,000 characters)')
                            : `${n.toLocaleString()}`}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <p className="set-warn ai-sent">
            <Icon name="alert" />
            <span>{tr(SENT[p])}</span>
          </p>
        </>
      )}
    </fieldset>
  );
}

/** Where Claude Code or Codex is, and its model. */
function CliSetup({ cli, save }: { cli: 'claude' | 'codex'; save: Save }) {
  const { settings, attempt, toast } = useApp();
  const key = cli === 'claude' ? 'claudePath' : 'codexPath';
  const modelKey = cli === 'claude' ? 'claudeModel' : 'codexModel';
  const chosen = settings[key];
  const [found, setFound] = useState<string | null | undefined>(undefined);
  const [path, setPath] = useState(chosen ?? '');
  const [model, setModel] = useState(settings[modelKey]);
  const find = async (tell = false) => {
    const f = (await attempt(() => window.worksync.aiFind(cli))) ?? null;
    setFound(f);
    if (tell)
      toast(
        f
          ? tr('Found {name} at {path}.', {
              name: tr(AI_PROVIDER_NAME[cli]),
              path: f,
            })
          : tr('{name} was not found on this PC.', {
              name: tr(AI_PROVIDER_NAME[cli]),
            }),
      );
    return f;
  };
  useEffect(() => {
    void find();
    // Once, when the provider is chosen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const browse = async () => {
    const f = await attempt(() => window.worksync.aiChooseFile(cli));
    if (!f) return;
    setPath(f);
    await save({ [key]: f });
  };
  const name = tr(AI_PROVIDER_NAME[cli]);
  return (
    <div className="ai-setup">
      <label>
        {tr('Where {name} is', { name })}
        <span className="ai-path">
          <input
            className="inp mono"
            value={path}
            placeholder={
              found
                ? tr('Found automatically: {path}', { path: found })
                : found === null
                  ? tr('Not found. Install it, or choose where it is.')
                  : tr('Looking…')
            }
            onChange={(e) => setPath(e.target.value)}
            onBlur={() =>
              void save({ [key]: path.trim() ? path.trim() : null })
            }
          />
          <button className="btn sm" onClick={() => void browse()}>
            {tr('Browse…')}
          </button>
          <button
            className="btn sm"
            onClick={() =>
              void find(true).then(() => {
                setPath('');
                return save({ [key]: null });
              })
            }
          >
            {tr('Find again')}
          </button>
        </span>
        <small className="muted">
          {cli === 'claude'
            ? tr(
                'Leave it empty to use the one WorkSync finds. Both claude.exe and the npm claude.cmd work.',
              )
            : tr(
                'Leave it empty to use the one WorkSync finds. Both codex.exe and the npm codex.cmd work.',
              )}
        </small>
      </label>
      <label>
        {tr('Model')}
        <input
          className="inp"
          list={`ai-models-${cli}`}
          value={model}
          placeholder={tr('{name}’s default', { name })}
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => void save({ [modelKey]: model.trim() })}
        />
        <datalist id={`ai-models-${cli}`}>
          {(cli === 'claude' ? ['sonnet', 'opus', 'haiku'] : []).map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
    </div>
  );
}

/** The local server's address and which of its models to use. */
function LocalSetup({ save }: { save: Save }) {
  const { settings, attempt } = useApp();
  const [url, setUrl] = useState(settings.localUrl);
  const [models, setModels] = useState<string[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = async (address = url) => {
    setProblem(null);
    try {
      setModels(await window.worksync.aiLocalModels(address));
    } catch (e) {
      setModels([]);
      setProblem(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void load(settings.localUrl);
    // Once, when Local model is chosen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const use = async (address: string) => {
    setUrl(address);
    if (await save({ localUrl: address })) await load(address);
  };
  return (
    <div className="ai-setup">
      <label>
        {tr('Address')}
        <span className="ai-path">
          <input
            className="inp mono"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => void use(url.trim())}
          />
          <button
            className="btn sm"
            onClick={() => void use('http://localhost:11434')}
          >
            Ollama
          </button>
          <button
            className="btn sm"
            onClick={() => void use('http://localhost:1234')}
          >
            LM Studio
          </button>
        </span>
        {!isLocalAddress(url) && (
          <small className="warn-text" role="alert">
            {tr(
              'This address is not on this PC: requests, with the tickets’ text, go over the network to it.',
            )}
          </small>
        )}
      </label>
      <label>
        {tr('Model')}
        <span className="ai-path">
          <select
            className="inp"
            value={settings.localModel}
            onChange={(e) => void save({ localModel: e.target.value })}
          >
            <option value="">{tr('Choose a model…')}</option>
            {[
              ...new Set([
                ...(models ?? []),
                ...(settings.localModel ? [settings.localModel] : []),
              ]),
            ].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button className="btn sm" onClick={() => void attempt(() => load())}>
            <Icon name="refresh" />
            {tr('Refresh')}
          </button>
        </span>
        <small className={problem ? 'warn-text' : 'muted'}>
          {problem
            ? translateMessage(uiLanguage(), problem)
            : models === null
              ? tr('Looking…')
              : models.length
                ? tr('{n} models on the server.', { n: models.length })
                : tr(
                    'The server has no models yet. Download one in Ollama or LM Studio first.',
                  )}
        </small>
      </label>
    </div>
  );
}
