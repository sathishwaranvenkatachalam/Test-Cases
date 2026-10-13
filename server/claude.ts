import { spawn, type ChildProcess } from 'node:child_process';
import { getSettings } from './settings.js';
import { stubJson, stubRunLines } from './stub.js';

const isStub = () => process.env.CLAUDE_STUB === '1';

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k.startsWith('CLAUDE_CODE_')) {
      delete env[k];
    }
  }
  return env;
}

function killProcess(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}

export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last < 0 || last < first) throw new SyntaxError('no JSON object found');
  return JSON.parse(cleaned.slice(first, last + 1));
}

export async function claudeJson<T>(
  kind: 'canonicalize' | 'detect-mapping',
  prompt: string,
  stubInput?: unknown,
): Promise<T> {
  if (isStub()) return stubJson(kind, stubInput) as T;

  const settings = getSettings();
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'json', '--model', settings.claudeModel], {
      shell: true,
      windowsHide: true,
      env: cleanEnv(),
    });
    let out = '';
    let err = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      killProcess(child);
      reject(new Error('claude timed out'));
    }, 300000);
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    child.on('error', (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${err.slice(0, 500)}`));
      } else {
        resolve(out);
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });

  let text: string;
  try {
    const outer = JSON.parse(stdout) as { result?: unknown };
    text = typeof outer.result === 'string' ? outer.result : stdout;
    return extractJson(text) as T;
  } catch {
    throw new Error(`claude returned invalid JSON: ${stdout.slice(0, 300)}`);
  }
}

export function spawnClaudeRun(
  prompt: string,
  onLine: (line: string) => void,
): { done: Promise<number>; kill: () => void } {
  if (isStub()) {
    for (const line of stubRunLines(prompt)) onLine(line);
    return { done: Promise.resolve(0), kill: () => {} };
  }

  const settings = getSettings();
  const args = [...settings.claudeRunArgs.split(/\s+/).filter(a => a !== ''), '--model', settings.claudeModel];
  const child = spawn('claude', args, { shell: true, windowsHide: true, env: cleanEnv() });

  const makeLineSplitter = (emit: (line: string) => void) => {
    let buf = '';
    return {
      push(chunk: string) {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          emit(line);
        }
      },
      flush() {
        if (buf.length > 0) emit(buf.replace(/\r$/, ''));
        buf = '';
      },
    };
  };

  const stdoutSplit = makeLineSplitter(onLine);
  const stderrSplit = makeLineSplitter(line => onLine('[stderr] ' + line));
  child.stdout.on('data', (d: Buffer) => stdoutSplit.push(d.toString('utf8')));
  child.stderr.on('data', (d: Buffer) => stderrSplit.push(d.toString('utf8')));

  const done = new Promise<number>((resolve) => {
    child.on('error', (e) => {
      onLine('[stderr] ' + e.message);
      resolve(1);
    });
    child.on('close', (code) => {
      stdoutSplit.flush();
      stderrSplit.flush();
      resolve(code ?? 1);
    });
  });

  child.stdin.write(prompt);
  child.stdin.end();

  return {
    done,
    kill: () => killProcess(child),
  };
}
