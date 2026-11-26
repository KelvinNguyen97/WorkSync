import {
  AI_PROVIDER_NAME,
  aiUsable,
  type AiJob,
  type AiProviderKind,
  type AiRunResult,
} from '../shared/ai';
import { translateMessage } from '../shared/i18n';
import { useApp } from './appState';
import { Icon } from './Icon';
import { tr, uiLanguage } from './i18n';
import { workChanged } from './work';

/** Asks the window to open Settings at AI provider. */
export const OPEN_AI_SETTINGS = 'worksync:open-ai-settings';
export const openAiSettings = () =>
  window.dispatchEvent(new Event(OPEN_AI_SETTINGS));

/** The provider as a sentence starts with it: "Claude Code filled in…". */
const who = (p: AiProviderKind) =>
  tr(p === 'local' ? 'The local model' : AI_PROVIDER_NAME[p]);

const DONE: Record<AiJob['kind'], [string, string]> = {
  translate: ['{who} filled in {n} ticket.', '{who} filled in {n} tickets.'],
  notes: [
    '{who} translated your notes on {n} ticket.',
    '{who} translated your notes on {n} tickets.',
  ],
  remarks: ['{who} translated {n} remark.', '{who} translated {n} remarks.'],
  summary: [
    '{who} brought {n} progress ticket up to date.',
    '{who} brought {n} progress tickets up to date.',
  ],
};

const DOING: Record<AiJob['kind'], string> = {
  translate: 'Translating and summarizing {n} tickets',
  notes: 'Translating your notes on {n} tickets',
  remarks: 'Translating {n} remarks',
  summary: 'Summarizing {n} discussions into progress',
};

/**
 * The one-click AI (doc 11): whether it can be used, and running a job with
 * its messages, Undo, and the fall back to Copy for AI when it fails.
 */
export function useAi() {
  const { ai, toast, attempt, reloadTasks } = useApp();
  const status = ai?.status ?? null;
  const usable = aiUsable(status);
  const busy = !!ai?.progress;

  const undo = async (undoId: string) => {
    const ids = await attempt(() => window.worksync.aiUndo(undoId));
    if (!ids) return;
    await reloadTasks();
    workChanged();
    toast(tr('Undone. Changes made since are kept.'));
  };

  const run = async (job: AiJob): Promise<AiRunResult | undefined> => {
    if (!status) return undefined;
    const name = who(status.provider);
    const r = await attempt(() => window.worksync.aiRun(job));
    if (!r) return undefined;
    if (r.taskIds.length || job.kind === 'summary') {
      await reloadTasks();
      workChanged();
    }
    const done = r.applied
      ? tr(DONE[job.kind][r.applied === 1 ? 0 : 1], { who: name, n: r.applied })
      : '';
    const missing = r.missing
      ? tr(
          r.missing === 1
            ? '{n} was missing from the answer and stays as it was.'
            : '{n} were missing from the answer and stay as they were.',
          { n: r.missing },
        )
      : '';
    const undoAction = r.undoId
      ? { label: 'Undo', run: () => void undo(r.undoId!) }
      : undefined;
    if (r.failure) {
      toast(
        [
          done,
          translateMessage(uiLanguage(), r.failure),
          tr('Until it works again, use Copy for AI.'),
        ]
          .filter(Boolean)
          .join(' '),
        { label: 'Open settings', run: openAiSettings },
        true,
      );
    } else if (r.cancelled)
      toast([tr('Cancelled.'), done].filter(Boolean).join(' '), undoAction);
    else if (!r.applied && !r.missing) toast(tr('Nothing needed doing.'));
    else
      toast(
        [done || tr('Nothing was filled in.'), missing]
          .filter(Boolean)
          .join(' '),
        undoAction,
      );
    return r;
  };

  return { status, usable, busy, run };
}

/** The progress of the job running, with Cancel; shown at the bottom of the window. */
export function AiJobBar() {
  const { ai } = useApp();
  const p = ai?.progress;
  if (!p || !ai) return null;
  return (
    <div className="ai-jobbar" role="status">
      <span className="ai-spin" aria-hidden="true" />
      <span className="ai-jobbar-text">
        <b>{who(ai.status.provider)}</b> · {tr(DOING[p.job], { n: p.items })}
        {p.of > 1
          ? ` · ${tr('request {at} of {of}', { at: p.at, of: p.of })}`
          : ''}
      </span>
      <button
        className="btn sm"
        onClick={() => void window.worksync.aiCancel()}
      >
        {tr('Cancel')}
      </button>
    </div>
  );
}

/** Shown beside Copy for AI while the provider can't be used; opens Settings. */
export function AiNotWorking() {
  const { ai } = useApp();
  if (ai?.status.state !== 'failed') return null;
  const reason = ai.status.reason
    ? translateMessage(uiLanguage(), ai.status.reason)
    : '';
  return (
    <button
      className="ai-bad"
      title={`${reason} ${tr('Click to open Settings › AI provider.')}`}
      onClick={openAiSettings}
    >
      <span className="ai-dot bad" aria-hidden="true" />
      {tr('AI not working')}
    </button>
  );
}

/** A one-click AI button, with a dot that says the provider works. */
export function AiButton({
  label,
  onClick,
  small,
  disabled,
  title,
}: {
  label: string;
  onClick: () => void;
  small?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  const { usable, busy, status } = useAi();
  if (!usable || !status) return null;
  return (
    <button
      className={`btn ${small ? 'sm ' : ''}primary ai-btn`}
      disabled={disabled || busy}
      title={
        title ??
        tr('{who} does it in the background. You can undo it afterwards.', {
          who: who(status.provider),
        })
      }
      onClick={onClick}
    >
      <Icon name="spark" />
      <span className="lbl">{label}</span>
      <span
        className={`ai-dot ${status.state === 'ok' ? 'ok' : 'checking'}`}
        aria-hidden="true"
      />
    </button>
  );
}
