/**
 * Talking to an AI provider (doc 11): Claude Code or Codex through their
 * command line in the background, or a model on this PC (Ollama, LM Studio)
 * through its local web address.
 *
 * Every call sends one request and reads one answer. The command-line tools
 * run in an empty temporary folder: Claude Code with every tool turned off,
 * Codex in its read-only sandbox, so neither can change a file. The request
 * goes in through standard input, never the command line, which on Windows
 * is limited to about 32,000 characters.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AI_PROVIDER_NAME,
  failureReason,
  validModelName,
  type AiProviderKind,
} from '../shared/ai';

export interface ProviderSettings {
  aiProvider: AiProviderKind;
  claudePath: string | null;
  codexPath: string | null;
  claudeModel: string;
  codexModel: string;
  localUrl: string;
  localModel: string;
  /** Per request. */
  aiTimeoutSec: number;
}

/** A failure the owner should see; the message is the reason, in English. */
export class AiError extends Error {}

/** Thrown when the owner pressed Cancel. */
export class AiCancelled extends Error {
  constructor() {
    super('Cancelled.');
  }
}

/** Sent as the system prompt, so the model answers only what was asked. */
export const SYSTEM_PROMPT =
  'You help a project manager with customer tickets: you translate and summarize text. Follow the instructions in the request exactly, and answer only in the format it asks for, with no introduction and no closing remarks.';

type Cli = 'claude' | 'codex';

/** Folders where the installers put the command, besides PATH. */
function knownFolders(platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  if (platform === 'win32')
    return [
      path.win32.join(home, '.local', 'bin'),
      env.APPDATA ? path.win32.join(env.APPDATA, 'npm') : '',
      path.win32.join(home, '.claude', 'local'),
      env.LOCALAPPDATA
        ? path.win32.join(env.LOCALAPPDATA, 'Programs', 'codex')
        : '',
    ].filter(Boolean);
  return [
    path.posix.join(home, '.local', 'bin'),
    path.posix.join(home, '.claude', 'local'),
    path.posix.join(home, '.npm-global', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
}

/** Finds Claude Code or Codex on this PC: PATH first, then where installers put it. */
export function findCli(
  cli: Cli,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const names = platform === 'win32' ? [`${cli}.exe`, `${cli}.cmd`] : [cli];
  const pathVar = env.PATH ?? env.Path ?? '';
  const dirs = [
    ...pathVar.split(platform === 'win32' ? ';' : ':'),
    ...knownFolders(platform, env),
  ].filter(Boolean);
  for (const dir of dirs)
    for (const n of names) {
      const f = p.join(dir, n);
      if (exists(f)) return f;
    }
  return null;
}

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Quotes a command-line argument for cmd.exe; ours never hold quotes. */
const winQuote = (a: string) =>
  a === '' || /[\s&|<>^()]/.test(a) ? `"${a}"` : a;

/**
 * Runs a command with the request on standard input. Stops it (and what it
 * started) on Cancel or when the time is up.
 */
export function runCli(
  file: string,
  args: string[],
  input: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<Ran> {
  if (opts.signal?.aborted) return Promise.reject(new AiCancelled());
  const win = process.platform === 'win32';
  // npm installs a .cmd file, which Windows runs only through cmd.exe.
  const viaShell = win && /\.(cmd|bat)$/i.test(file);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const child = viaShell
    ? spawn(`"${file}"`, args.map(winQuote), {
        cwd: opts.cwd,
        env,
        shell: true,
        windowsHide: true,
      })
    : spawn(file, args, {
        cwd: opts.cwd,
        env,
        windowsHide: true,
        detached: !win,
      });
  return new Promise<Ran>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const stop = () => {
      if (child.pid === undefined) return;
      try {
        if (win)
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
          });
        else process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill();
      }
    };
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      stop();
      finish(() => reject(new AiCancelled()));
    };
    const timer = setTimeout(() => {
      stop();
      finish(() =>
        reject(
          new AiError(
            `No answer within ${Math.round(opts.timeoutMs / 1000)} seconds. Give it more time in Settings › AI provider, or send smaller requests.`,
          ),
        ),
      );
    }, opts.timeoutMs);
    opts.signal?.addEventListener('abort', onAbort);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => (stdout += d));
    child.stderr?.on('data', (d: string) => {
      // Enough to say why it failed; a chatty tool can't fill the memory.
      if (stderr.length < 20_000) stderr += d;
    });
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          new AiError(
            e.code === 'ENOENT'
              ? `Not found: ${file}. Choose where it is in Settings › AI provider.`
              : `It could not be started: ${e.message}`,
          ),
        ),
      ),
    );
    child.on('close', (code) =>
      finish(() => resolve({ code, stdout, stderr })),
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input, 'utf8');
  });
}

function cliPath(s: ProviderSettings, cli: Cli): string {
  const set = cli === 'claude' ? s.claudePath : s.codexPath;
  const f = set || findCli(cli);
  if (!f)
    throw new AiError(
      `${AI_PROVIDER_NAME[cli]} was not found on this PC. Install it, or choose where it is in Settings › AI provider.`,
    );
  return f;
}

/** Runs a request in a new empty folder, removed afterwards. */
async function inEmptyFolder<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worksync-ai-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The arguments for Claude Code's background mode, with every tool off. */
export function claudeArgs(model: string): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--system-prompt',
    SYSTEM_PROMPT,
    ...(model ? ['--model', model] : []),
  ];
}

/** Reads Claude Code's JSON result; its text, or why it failed. */
export function readClaudeOutput(r: Ran): string {
  let parsed: { result?: unknown; is_error?: unknown } | null = null;
  try {
    parsed = JSON.parse(r.stdout.trim());
  } catch {
    parsed = null;
  }
  const text = typeof parsed?.result === 'string' ? parsed.result : '';
  if (r.code !== 0 || parsed?.is_error === true || (!parsed && !r.stdout))
    throw new AiError(
      failureReason(text || r.stderr || r.stdout || '', 'claude'),
    );
  return parsed ? text : r.stdout;
}

/** The arguments for Codex's background mode, in its read-only sandbox. */
export function codexArgs(model: string, outFile: string): string[] {
  return [
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '--output-last-message',
    outFile,
    ...(model ? ['--model', model] : []),
    '-',
  ];
}

/** Models that think out loud put it in <think> tags; only the answer is kept. */
export const dropThinking = (s: string) =>
  s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

/** The base address without a trailing slash or a /v1 the owner pasted. */
export const baseUrl = (url: string) =>
  url.trim().replace(/\/+$/, '').replace(/\/v1$/, '');

async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs: number; signal?: AbortSignal },
): Promise<unknown> {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  init.signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => ctl.abort(), init.timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    const body = await r.text();
    if (!r.ok)
      throw new AiError(
        failureReason(`${r.status} ${body.slice(0, 300)}`, 'local'),
      );
    return JSON.parse(body);
  } catch (e) {
    if (init.signal?.aborted) throw new AiCancelled();
    if (e instanceof AiError) throw e;
    if (ctl.signal.aborted)
      throw new AiError(
        `No answer within ${Math.round(init.timeoutMs / 1000)} seconds. Give it more time in Settings › AI provider, or send smaller requests.`,
      );
    throw new AiError(
      failureReason(
        e instanceof Error ? `${e.message} ${String(e.cause ?? '')}` : '',
        'local',
      ),
    );
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', onAbort);
  }
}

/** Ollama answers /api/version; LM Studio and others speak the OpenAI format. */
async function isOllama(base: string): Promise<boolean> {
  try {
    const v = (await fetchJson(`${base}/api/version`, {
      timeoutMs: 3000,
    })) as { version?: unknown };
    return typeof v.version === 'string';
  } catch {
    return false;
  }
}

/** The models the local server has. */
export async function listLocalModels(url: string): Promise<string[]> {
  const base = baseUrl(url);
  if (!/^https?:\/\//i.test(base))
    throw new AiError('The address should start with http:// or https://.');
  if (await isOllama(base)) {
    const r = (await fetchJson(`${base}/api/tags`, { timeoutMs: 5000 })) as {
      models?: { name?: string }[];
    };
    return (r.models ?? []).map((m) => String(m.name ?? '')).filter(Boolean);
  }
  const r = (await fetchJson(`${base}/v1/models`, { timeoutMs: 5000 })) as {
    data?: { id?: string }[];
  };
  return (r.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean);
}

async function askLocal(
  s: ProviderSettings,
  prompt: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const base = baseUrl(s.localUrl);
  if (!s.localModel)
    throw new AiError('Choose a model in Settings › AI provider.');
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];
  if (await isOllama(base)) {
    // Ollama's own call, because only it lets WorkSync raise the context
    // window: the default would cut a long request short without saying so.
    const r = (await fetchJson(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: s.localModel,
        messages,
        stream: false,
        options: {
          temperature: 0.2,
          num_ctx: Math.min(
            32768,
            Math.max(8192, Math.ceil(prompt.length / 2)),
          ),
        },
      }),
      timeoutMs,
      signal,
    })) as { message?: { content?: unknown } };
    return dropThinking(String(r.message?.content ?? ''));
  }
  const r = (await fetchJson(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: s.localModel,
      messages,
      stream: false,
      temperature: 0.2,
    }),
    timeoutMs,
    signal,
  })) as { choices?: { message?: { content?: unknown } }[] };
  return dropThinking(String(r.choices?.[0]?.message?.content ?? ''));
}

/** Sends one request to the chosen provider and returns its answer. */
export async function ask(
  s: ProviderSettings,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const timeoutMs = Math.max(30, s.aiTimeoutSec) * 1000;
  if (s.aiProvider === 'local') return askLocal(s, prompt, timeoutMs, signal);
  if (s.aiProvider === 'claude') {
    if (!validModelName(s.claudeModel))
      throw new AiError('The model name is not valid.');
    const file = cliPath(s, 'claude');
    return inEmptyFolder(async (cwd) =>
      readClaudeOutput(
        await runCli(file, claudeArgs(s.claudeModel), prompt, {
          cwd,
          timeoutMs,
          signal,
        }),
      ),
    );
  }
  if (s.aiProvider === 'codex') {
    if (!validModelName(s.codexModel))
      throw new AiError('The model name is not valid.');
    const file = cliPath(s, 'codex');
    return inEmptyFolder(async (cwd) => {
      const out = path.join(cwd, 'answer.txt');
      const r = await runCli(file, codexArgs(s.codexModel, out), prompt, {
        cwd,
        timeoutMs,
        signal,
      });
      const answer = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
      if (r.code !== 0 || !answer.trim())
        throw new AiError(
          failureReason(r.stderr || r.stdout || answer, 'codex'),
        );
      return answer;
    });
  }
  throw new AiError('No AI provider is chosen.');
}

/**
 * A quick check that sends nothing to the AI: the command is there and
 * starts, or the local server answers and has the model.
 */
export async function quickCheck(s: ProviderSettings): Promise<string> {
  if (s.aiProvider === 'local') {
    const models = await listLocalModels(s.localUrl);
    if (!s.localModel)
      throw new AiError('Choose a model in Settings › AI provider.');
    if (!models.includes(s.localModel))
      throw new AiError(
        `The model ${s.localModel} is not on the local server. Choose one of its models in Settings › AI provider.`,
      );
    return `${s.localModel} at ${baseUrl(s.localUrl)}`;
  }
  if (s.aiProvider !== 'claude' && s.aiProvider !== 'codex')
    throw new AiError('No AI provider is chosen.');
  const file = cliPath(s, s.aiProvider);
  const r = await inEmptyFolder((cwd) =>
    runCli(file, ['--version'], '', { cwd, timeoutMs: 20_000 }),
  );
  if (r.code !== 0)
    throw new AiError(failureReason(r.stderr || r.stdout, s.aiProvider));
  const v = (r.stdout.match(/\d+\.\d+\.\d+[\w.-]*/) ?? [''])[0];
  return `${AI_PROVIDER_NAME[s.aiProvider]}${v ? ` ${v}` : ''}`;
}

/** The test in Settings: one tiny request, so sign-in and limits are checked too. */
export async function fullTest(s: ProviderSettings): Promise<string> {
  const what = await quickCheck(s);
  const start = Date.now();
  const answer = await ask(
    s,
    'This is a connection test. Reply with exactly the word OK and nothing else.',
  );
  if (!/\bok\b/i.test(answer))
    throw new AiError(
      `It answered, but not as asked: “${answer.trim().slice(0, 80)}”. A bigger model may follow the format better.`,
    );
  return `${what} · answered in ${Math.max(1, Math.round((Date.now() - start) / 1000))} s`;
}
