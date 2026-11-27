import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AiCancelled,
  AiError,
  ask,
  baseUrl,
  claudeArgs,
  dropThinking,
  findCli,
  fullTest,
  listLocalModels,
  quickCheck,
  readClaudeOutput,
  runCli,
  type ProviderSettings,
} from './aiProvider';
import { failureReason, isLocalAddress } from '../shared/ai';

const posix = process.platform !== 'win32';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worksync-ai-test-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A stand-in command: a Node script the test writes. */
function standIn(name: string, body: string): string {
  const f = path.join(dir, name);
  fs.writeFileSync(f, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return f;
}

const base: ProviderSettings = {
  aiProvider: 'claude',
  claudePath: null,
  codexPath: null,
  claudeModel: '',
  codexModel: '',
  localUrl: 'http://localhost:11434',
  localModel: '',
  aiTimeoutSec: 60,
};

describe('finding the command', () => {
  it('looks on PATH first, then where the installers put it', () => {
    const have = new Set([
      'C:\\Users\\k\\AppData\\Roaming\\npm\\claude.cmd',
      'C:\\Tools\\codex.exe',
    ]);
    const env = {
      PATH: 'C:\\Windows;C:\\Tools',
      USERPROFILE: 'C:\\Users\\k',
      APPDATA: 'C:\\Users\\k\\AppData\\Roaming',
    };
    expect(findCli('claude', env, 'win32', (p) => have.has(p))).toBe(
      'C:\\Users\\k\\AppData\\Roaming\\npm\\claude.cmd',
    );
    expect(findCli('codex', env, 'win32', (p) => have.has(p))).toBe(
      'C:\\Tools\\codex.exe',
    );
    // The native installer's place wins over npm when both are there.
    have.add('C:\\Users\\k\\.local\\bin\\claude.exe');
    expect(findCli('claude', env, 'win32', (p) => have.has(p))).toBe(
      'C:\\Users\\k\\.local\\bin\\claude.exe',
    );
    expect(
      findCli(
        'claude',
        { PATH: '/usr/bin', HOME: '/home/k' },
        'linux',
        (p) => p === '/home/k/.local/bin/claude',
      ),
    ).toBe('/home/k/.local/bin/claude');
    expect(findCli('codex', { PATH: '' }, 'linux', () => false)).toBeNull();
  });
});

describe('Claude Code', () => {
  it('runs with every tool off, no MCP servers and no saved session', () => {
    const a = claudeArgs('sonnet');
    expect(a.slice(0, 5)).toEqual([
      '-p',
      '--output-format',
      'json',
      '--tools',
      '',
    ]);
    expect(a).toContain('--strict-mcp-config');
    expect(a).toContain('--no-session-persistence');
    expect(a.slice(-2)).toEqual(['--model', 'sonnet']);
    expect(claudeArgs('')).not.toContain('--model');
  });

  it('reads the result, and says why it failed', () => {
    expect(
      readClaudeOutput({
        code: 0,
        stdout: JSON.stringify({
          type: 'result',
          is_error: false,
          result: 'OK',
        }),
        stderr: '',
      }),
    ).toBe('OK');
    expect(() =>
      readClaudeOutput({
        code: 1,
        stdout: JSON.stringify({
          type: 'result',
          is_error: true,
          result: 'Invalid API key · Please run /login',
        }),
        stderr: '',
      }),
    ).toThrow(/Claude Code is signed out/);
    expect(() =>
      readClaudeOutput({
        code: 1,
        stdout: '',
        stderr: 'Claude AI usage limit reached',
      }),
    ).toThrow(/usage limit/);
  });

  it.runIf(posix)(
    'sends the request on standard input from an empty folder and reads the answer',
    async () => {
      const f = standIn(
        'claude',
        `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
          const files=require('fs').readdirSync(process.cwd());
          process.stdout.write(JSON.stringify({type:'result',is_error:false,
            result: JSON.stringify({args:process.argv.slice(2),input:s,files})}));
        });`,
      );
      const out = JSON.parse(
        await ask(
          { ...base, claudePath: f, claudeModel: 'haiku' },
          'Translate this, ほんやく',
        ),
      );
      expect(out.input).toBe('Translate this, ほんやく');
      expect(out.files).toEqual([]);
      expect(out.args).toEqual(claudeArgs('haiku'));
    },
  );

  it.runIf(posix)('checks the version without sending anything', async () => {
    const f = standIn('claude-v', `console.log('2.1.330 (Claude Code)')`);
    expect(await quickCheck({ ...base, claudePath: f })).toBe(
      'Claude Code 2.1.330',
    );
  });

  it.runIf(posix)('the test fails when it is signed out', async () => {
    const f = standIn(
      'claude-out',
      `if (process.argv.includes('--version')) { console.log('2.1.330'); process.exit(0) }
       process.stdin.resume(); process.stdin.on('end',()=>{
       console.log(JSON.stringify({type:'result',is_error:true,result:'Not logged in · Please run /login'}));
       process.exit(1) })`,
    );
    await expect(fullTest({ ...base, claudePath: f })).rejects.toThrow(
      /signed out/,
    );
  });

  it('says so when it is not found', async () => {
    await expect(
      ask({ ...base, claudePath: path.join(dir, 'missing-claude') }, 'x'),
    ).rejects.toThrow(/Not found/);
  });

  it('refuses a model name that is not a plain name', async () => {
    await expect(
      ask({ ...base, claudeModel: 'x" & del *' }, 'x'),
    ).rejects.toThrow(/not valid/);
  });
});

describe('Codex', () => {
  it.runIf(posix)(
    'runs read-only and reads the last message from its file',
    async () => {
      const f = standIn(
        'codex',
        `const a=process.argv.slice(2);let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
          const out=a[a.indexOf('--output-last-message')+1];
          require('fs').writeFileSync(out, JSON.stringify({a,s}));
          console.log('progress on stdout');});`,
      );
      const out = JSON.parse(
        await ask({ ...base, aiProvider: 'codex', codexPath: f }, 'Hello'),
      );
      expect(out.s).toBe('Hello');
      expect(out.a.slice(0, 5)).toEqual([
        'exec',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--color',
      ]);
      expect(out.a.at(-1)).toBe('-');
    },
  );

  it.runIf(posix)('fails with what Codex printed', async () => {
    const f = standIn(
      'codex-bad',
      `process.stdin.resume();process.stdin.on('end',()=>{console.error('You are not logged in. Run codex login.');process.exit(1)})`,
    );
    await expect(
      ask({ ...base, aiProvider: 'codex', codexPath: f }, 'Hello'),
    ).rejects.toThrow(/Codex is signed out/);
  });
});

describe('running a command', () => {
  it.runIf(posix)('stops it when the time is up', async () => {
    const f = standIn('slow', `setTimeout(()=>{}, 60000)`);
    await expect(
      runCli(f, [], '', { cwd: dir, timeoutMs: 300 }),
    ).rejects.toThrow(/No answer within/);
  });

  it.runIf(posix)('stops it on Cancel', async () => {
    const f = standIn('slow2', `setTimeout(()=>{}, 60000)`);
    const ctl = new AbortController();
    const p = runCli(f, [], '', {
      cwd: dir,
      timeoutMs: 10_000,
      signal: ctl.signal,
    });
    setTimeout(() => ctl.abort(), 100);
    await expect(p).rejects.toBeInstanceOf(AiCancelled);
  });
});

describe('a local model', () => {
  let server: http.Server;
  let url = '';
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  let ollama = true;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        seen.push({ path: req.url ?? '', body: body ? JSON.parse(body) : {} });
        const json = (x: unknown, code = 200) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(x));
        };
        if (req.url === '/api/version')
          return ollama
            ? json({ version: '0.9.0' })
            : json({ error: 'no' }, 404);
        if (req.url === '/api/tags')
          return json({ models: [{ name: 'qwen2.5:7b' }] });
        if (req.url === '/api/chat')
          return json({
            message: {
              content: '<think>Let me see.</think>\n=== TICKET 1 ===',
            },
          });
        if (req.url === '/v1/models')
          return json({ data: [{ id: 'gemma-3' }] });
        if (req.url === '/v1/chat/completions')
          return json({ choices: [{ message: { content: 'OK' } }] });
        json({ error: 'not found' }, 404);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  it('talks to Ollama with a context big enough for the request', async () => {
    ollama = true;
    expect(await listLocalModels(`${url}/v1/`)).toEqual(['qwen2.5:7b']);
    const s = {
      ...base,
      aiProvider: 'local' as const,
      localUrl: url,
      localModel: 'qwen2.5:7b',
    };
    expect(await quickCheck(s)).toBe(`qwen2.5:7b at ${url}`);
    const answer = await ask(s, 'x'.repeat(30_000));
    expect(answer).toBe('=== TICKET 1 ===');
    const chat = seen.find((x) => x.path === '/api/chat')!;
    expect(chat.body).toMatchObject({
      model: 'qwen2.5:7b',
      stream: false,
      options: { num_ctx: 15_000 },
    });
    await expect(quickCheck({ ...s, localModel: 'llama3' })).rejects.toThrow(
      /not on the local server/,
    );
  });

  it('talks to LM Studio and others in the OpenAI format', async () => {
    ollama = false;
    expect(await listLocalModels(url)).toEqual(['gemma-3']);
    const s = {
      ...base,
      aiProvider: 'local' as const,
      localUrl: url,
      localModel: 'gemma-3',
    };
    expect(await fullTest(s)).toMatch(/^gemma-3 at .* · answered in \d+ s$/);
  });

  it('says so when nothing answers at the address', async () => {
    await expect(listLocalModels('http://127.0.0.1:9')).rejects.toBeInstanceOf(
      AiError,
    );
    await expect(listLocalModels('ftp://x')).rejects.toThrow(/http/);
  });
});

describe('small helpers', () => {
  it('cleans addresses and answers', () => {
    expect(baseUrl(' http://localhost:1234/v1/ ')).toBe(
      'http://localhost:1234',
    );
    expect(dropThinking('<think>a\nb</think>\nAnswer')).toBe('Answer');
    expect(isLocalAddress('http://localhost:11434')).toBe(true);
    expect(isLocalAddress('http://127.0.0.1:1234')).toBe(true);
    expect(isLocalAddress('http://gpu-server.corp:11434')).toBe(false);
  });

  it('turns what a provider printed into a reason', () => {
    // Words that only look like sign-in or limit problems are not taken for them.
    expect(
      failureReason(
        'Error: failed to read ~/.codex/login-state.json: permission denied',
        'codex',
      ),
    ).toMatch(/^Codex stopped with: /);
    expect(failureReason('Ticket 4012 has no title', 'claude')).toMatch(
      /stopped with/,
    );
    expect(failureReason('Request failed with status 401', 'local')).toMatch(
      /signed out/,
    );
    expect(
      failureReason('Not logged in · Please run /login', 'claude'),
    ).toMatch(/signed out/);
    expect(failureReason('Error: 429 Too Many Requests', 'codex')).toBe(
      'Codex reached its usage limit. Try again later.',
    );
    expect(failureReason('fetch failed ECONNREFUSED', 'local')).toBe(
      'The local model is not running at that address.',
    );
    expect(failureReason('\n  Something odd\nmore', 'claude')).toBe(
      'Claude Code stopped with: Something odd',
    );
  });
});
