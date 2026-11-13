import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { app } from 'electron';
import {
  baseName,
  everythingQueries,
  folderOf,
  type EverythingAnswer,
} from '../shared/catalog';
import { log } from './log';

/**
 * File search with Everything (voidtools), Windows only, as FileManagement
 * does it: Everything's SDK DLL is called directly (through koffi), and
 * Everything is started when it isn't running: first normally, then once
 * with administrator rights, which Windows asks to allow.
 */

const LIMIT = 30;
const REQUEST_FULL_PATH = 0x00000004;

type Sdk = {
  reset: () => void;
  setSearch: (q: string) => void;
  setRequestFlags: (f: number) => void;
  setMax: (n: number) => void;
  setFlag: Record<
    'matchPath' | 'regex' | 'matchCase' | 'wholeWord',
    (on: number) => void
  >;
  query: {
    async: (wait: number, cb: (err: unknown, ok: number) => void) => void;
  };
  count: () => number;
  fullPath: (i: number, buf: Buffer, size: number) => number;
  dbLoaded: () => number;
  lastError: () => number;
};

let sdk: Sdk | null = null;
let sdkTried = false;
let starting: Promise<boolean> | null = null;
let triedAdmin = false;
/** Searches run one at a time: the SDK keeps one query at a time. */
let queue: Promise<unknown> = Promise.resolve();

/** Where the copy that comes with WorkSync is: beside the app, or in the source tree. */
const bundledFolder = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'everything')
    : path.join(app.getAppPath(), 'vendor', 'everything');

const firstExisting = (list: string[]) =>
  list.find((p) => fs.existsSync(p)) ?? null;

function dllPath(): string | null {
  return firstExisting([
    path.join(bundledFolder(), 'Everything64.dll'),
    path.join(
      process.env.ProgramFiles ?? 'C:\\Program Files',
      'Everything',
      'Everything64.dll',
    ),
  ]);
}

/** An Everything someone installed is used first; otherwise the bundled one. */
function exePath(): string | null {
  return firstExisting([
    path.join(
      process.env.ProgramFiles ?? 'C:\\Program Files',
      'Everything',
      'Everything.exe',
    ),
    path.join(
      process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      'Everything',
      'Everything.exe',
    ),
    path.join(bundledFolder(), 'Everything.exe'),
  ]);
}

function loadSdk(): Sdk | null {
  if (sdk || sdkTried) return sdk;
  sdkTried = true;
  const dll = dllPath();
  if (!dll) {
    log('info', 'Everything SDK DLL not found');
    return null;
  }
  try {
    const koffi = createRequire(__filename)('koffi') as typeof import('koffi');
    const lib = koffi.load(dll);
    const f = (sig: string) => lib.func(sig);
    sdk = {
      reset: f('void Everything_Reset()'),
      setSearch: f('void Everything_SetSearchW(const char16_t *s)'),
      setRequestFlags: f('void Everything_SetRequestFlags(uint32_t f)'),
      setMax: f('void Everything_SetMax(uint32_t n)'),
      setFlag: {
        matchPath: f('void Everything_SetMatchPath(int on)'),
        regex: f('void Everything_SetRegex(int on)'),
        matchCase: f('void Everything_SetMatchCase(int on)'),
        wholeWord: f('void Everything_SetMatchWholeWord(int on)'),
      },
      query: f('int Everything_QueryW(int wait)') as unknown as Sdk['query'],
      count: f('uint32_t Everything_GetNumResults()'),
      fullPath: f(
        'uint32_t Everything_GetResultFullPathNameW(uint32_t i, _Out_ uint16_t *buf, uint32_t size)',
      ),
      dbLoaded: f('int Everything_IsDBLoaded()'),
      lastError: f('uint32_t Everything_GetLastError()'),
    };
    log('info', 'Everything SDK loaded');
  } catch (error) {
    log('warn', `Everything SDK could not load: ${String(error)}`);
    sdk = null;
  }
  return sdk;
}

const ready = (s: Sdk) => {
  try {
    return s.dbLoaded() !== 0;
  } catch {
    return false;
  }
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitReady(s: Sdk): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (ready(s)) return true;
    await wait(250);
  }
  return false;
}

function start(exe: string, admin: boolean): void {
  const args = ['-startup', '-minimized', '-first-instance'];
  try {
    if (!admin) {
      spawn(exe, args, {
        cwd: path.dirname(exe),
        detached: true,
        stdio: 'ignore',
      }).unref();
      return;
    }
    // Windows asks the owner to allow this, as it does for FileManagement.
    const list = [...args, '-admin', '-app-data']
      .map((a) => `'${a}'`)
      .join(',');
    spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Start-Process -FilePath '${exe.replaceAll("'", "''")}' -ArgumentList ${list} -Verb RunAs -WindowStyle Minimized`,
      ],
      { detached: true, stdio: 'ignore', windowsHide: true },
    ).unref();
  } catch (error) {
    log('warn', `Everything could not start: ${String(error)}`);
  }
}

/** Starts Everything if it isn't running; true once its index is loaded. */
function ensureStarted(s: Sdk): Promise<boolean> {
  if (ready(s)) return Promise.resolve(true);
  if (starting) return starting;
  const exe = exePath();
  if (!exe) return Promise.resolve(false);
  starting = (async () => {
    start(exe, false);
    if (await waitReady(s)) return true;
    if (triedAdmin) return false;
    triedAdmin = true;
    start(exe, true);
    return waitReady(s);
  })().finally(() => {
    starting = null;
  });
  return starting;
}

function runQuery(s: Sdk, q: string, max: number): Promise<string[]> {
  s.reset();
  s.setSearch(q);
  s.setRequestFlags(REQUEST_FULL_PATH);
  s.setMax(max);
  s.setFlag.matchPath(0);
  s.setFlag.regex(0);
  s.setFlag.matchCase(0);
  s.setFlag.wholeWord(0);
  return new Promise((resolve) => {
    // On a worker thread, so the window never waits.
    s.query.async(1, (err, ok) => {
      if (err || !ok) {
        if (!err) log('info', `Everything query failed: ${s.lastError()}`);
        resolve([]);
        return;
      }
      const n = s.count();
      const buf = Buffer.alloc(32768 * 2);
      const out: string[] = [];
      for (let i = 0; i < n; i++) {
        const len = s.fullPath(i, buf, 32768);
        if (len) out.push(buf.toString('utf16le', 0, len * 2));
      }
      resolve(out);
    });
  });
}

/** Everything's state without searching, for Settings. */
export function everythingStatus(enabled: boolean): EverythingAnswer['state'] {
  if (process.platform !== 'win32') return 'unsupported';
  if (!enabled) return 'off';
  const s = loadSdk();
  if (!s || !exePath()) return 'unavailable';
  return ready(s) ? 'ok' : 'starting';
}

/**
 * Searches files and folders on this PC. `saved` tells which paths the
 * Catalog already has.
 */
export async function searchEverything(
  query: string,
  enabled: boolean,
  saved: (p: string) => boolean,
  limit = LIMIT,
): Promise<EverythingAnswer> {
  if (process.platform !== 'win32')
    return { state: 'unsupported', results: [] };
  if (!enabled) return { state: 'off', results: [] };
  const q = query.trim();
  const s = loadSdk();
  if (!s || !exePath()) return { state: 'unavailable', results: [] };
  if (!q) return { state: ready(s) ? 'ok' : 'starting', results: [] };
  if (!(await ensureStarted(s))) return { state: 'starting', results: [] };
  const job = queue.then(async () => {
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const v of everythingQueries(q)) {
      if (paths.length >= limit) break;
      for (const p of await runQuery(s, v, limit - paths.length)) {
        const k = p.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        paths.push(p);
        if (paths.length >= limit) break;
      }
    }
    return paths;
  });
  queue = job.catch(() => undefined);
  const paths = await job;
  return {
    state: 'ok',
    results: paths.map((p) => {
      let isFolder = false;
      try {
        isFolder = fs.statSync(p).isDirectory();
      } catch {
        // Gone since Everything indexed it.
      }
      return {
        path: p,
        name: baseName(p),
        folder: folderOf(p),
        isFolder,
        saved: saved(p),
      };
    }),
  };
}

/** For the end-to-end tests: koffi loads from inside the packaged app. */
export function koffiLoads(): string {
  try {
    const koffi = createRequire(__filename)('koffi') as typeof import('koffi');
    return `koffi ${koffi.version} ok`;
  } catch (error) {
    return `koffi failed: ${String(error)}`;
  }
}
