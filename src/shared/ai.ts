/**
 * AI providers (doc 11): the AI that WorkSync's one-click actions use.
 * Free of Node.js and Electron imports.
 */

export type AiProviderKind = 'none' | 'claude' | 'codex' | 'local';

export const AI_PROVIDER_NAME: Record<AiProviderKind, string> = {
  none: 'Copy for AI',
  claude: 'Claude Code',
  codex: 'Codex',
  local: 'Local model',
};

/**
 * off: no provider chosen, the buttons copy and paste as before.
 * checking: being checked. ok: works. failed: can't be used; the buttons
 * fall back to Copy for AI until a test passes or WorkSync restarts.
 */
export type AiState = 'off' | 'checking' | 'ok' | 'failed';

export interface AiStatus {
  provider: AiProviderKind;
  state: AiState;
  /** Why it failed, in English (translated on screen). */
  reason: string | null;
  /** What the last check found, such as "Claude Code 2.1.330". */
  detail: string | null;
  /** When the last full test passed, as an ISO time. */
  testedAt: string | null;
}

/** True when the one-click buttons should be shown instead of Copy for AI. */
export const aiUsable = (s: AiStatus | null): boolean =>
  !!s && s.provider !== 'none' && (s.state === 'ok' || s.state === 'checking');

/** One-click jobs. Each builds the same request as Copy for AI. */
export type AiJob =
  | { kind: 'translate'; projectId: string; taskIds: string[] }
  | { kind: 'notes'; projectId: string; taskIds: string[] }
  | { kind: 'remarks'; taskIds: string[] }
  | { kind: 'summary'; discussionIds: string[] };

export interface AiProgress {
  job: AiJob['kind'];
  /** The request being sent, 1-based. */
  at: number;
  of: number;
  /** How many tickets or discussions the whole job covers. */
  items: number;
}

export interface AiRunResult {
  /** Tickets (or discussions) filled in. */
  applied: number;
  /** Asked for but missing from the answer; they stay as they were. */
  missing: number;
  /** For Undo; null when nothing changed. */
  undoId: string | null;
  /** The tickets changed, for refreshing the screen. */
  taskIds: string[];
  /** Set when the provider stopped working part-way. */
  failure: string | null;
  cancelled: boolean;
}

/** The request sizes offered in Settings, in characters. */
export const AI_REQUEST_SIZES = [8_000, 20_000, 40_000] as const;

/** Model names are passed to a command line, so only plain names are allowed. */
export const validModelName = (s: string): boolean =>
  s === '' || /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(s);

/** A local address keeps the data on this PC; any other sends it over the network. */
export function isLocalAddress(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || h.startsWith('127.');
  } catch {
    return false;
  }
}

/**
 * Turns what a provider printed when it failed into a short reason for the
 * owner. The patterns are loose on purpose: providers word these differently.
 */
export function failureReason(text: string, provider: AiProviderKind): string {
  const name =
    provider === 'local' ? 'The local model' : AI_PROVIDER_NAME[provider];
  const t = text.toLowerCase();
  if (
    /not logged in|log ?in|sign(ed)? ?(in|out)|unauthori[sz]ed|authenticat|credential|invalid api key|oauth|token (has )?expired|401/.test(
      t,
    )
  )
    return `${name} is signed out. Open it once and sign in with your account, then test again.`;
  if (
    /usage limit|rate limit|quota|too many requests|429|limit reached/.test(t)
  )
    return `${name} reached its usage limit. Try again later.`;
  if (/econnrefused|connection refused|fetch failed|could not connect/.test(t))
    return `${name} is not running at that address.`;
  const first = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l);
  return first
    ? `${name} stopped with: ${first.slice(0, 200)}`
    : `${name} stopped without saying why.`;
}
