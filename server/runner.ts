import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { db } from './db.js';
import { getSettings } from './settings.js';
import { buildPlan, loadPlannerCases } from './planner.js';
import { spawnClaudeRun } from './claude.js';
import { caseIsFullyRecorded, saveRecording, regenerateFlowScripts } from './scriptgen.js';
import { renderStep, slugify } from './util.js';
import { checkCdpReachable } from './chrome.js';
import type { Plan, StepOp } from '../shared/types.js';

export const bus = new EventEmitter();
bus.setMaxListeners(0);

export type RunEvent =
  | { type: 'status'; status: string }
  | { type: 'step'; flowId: number; nodeId: string; text: string; status: string; observed?: string; note?: string }
  | { type: 'case'; caseId: number; status: string; note?: string }
  | { type: 'log'; line: string }
  | { type: 'done' };

export interface ResultCheck { caseId: number; status: 'pass' | 'fail'; observed?: string; assertCode?: string; }
export interface ResultPayload { nodeId: string; status: 'pass' | 'fail'; actionCode?: string; checks?: ResultCheck[]; note?: string; }
export type ParsedEvent = { kind: 'result'; result: ResultPayload } | { kind: 'done' };

type CaseStatus = 'pass' | 'fail' | 'skipped' | 'error';

interface ActiveRun { cancelled: boolean; kill: () => void; }
const activeRuns = new Map<number, ActiveRun>();
const logCounts = new Map<number, number>();
const LOG_CAP = 2000;

const emitEvent = (runId: number, ev: RunEvent) => bus.emit(`run:${runId}`, ev);

function appendLog(runId: number, rawLine: string): void {
  const line = rawLine.slice(0, 2000);
  const count = logCounts.get(runId) ?? 0;
  if (count < LOG_CAP) {
    db.prepare('INSERT INTO run_logs (run_id, line) VALUES (?, ?)').run(runId, line);
    logCounts.set(runId, count + 1);
  }
  emitEvent(runId, { type: 'log', line });
}

export function selectCases(flowId: number, scope: string): number[] {
  const ids = (db.prepare('SELECT id FROM cases WHERE flow_id = ? ORDER BY id').all(flowId) as { id: number }[])
    .map(r => r.id);
  if (scope === 'all') return ids;
  if (scope === 'unverified') return ids.filter(id => !caseIsFullyRecorded(id).ok);
  if (scope === 'failed') {
    const latest = db.prepare('SELECT status FROM run_case_results WHERE case_id = ? ORDER BY run_id DESC LIMIT 1');
    return ids.filter(id => {
      const row = latest.get(id) as { status: string } | undefined;
      return !!row && (row.status === 'fail' || row.status === 'error' || row.status === 'skipped');
    });
  }
  return ids;
}

export function buildClaudePrompt(baseUrl: string, plan: Plan, resolveText: (op: StepOp) => string): string {
  const reducedOps = plan.ops.map(op => {
    if (op.type === 'step') {
      return {
        type: 'step',
        nodeId: op.nodeId,
        text: resolveText(op),
        params: op.params,
        ancestors: op.ancestors,
        checks: op.checks,
      };
    }
    return {
      type: 'replay',
      fromBaseUrl: op.fromBaseUrl,
      steps: op.steps.map(s => ({ nodeId: s.nodeId, text: renderStep(s.text, s.params) })),
    };
  });
  const planJson = JSON.stringify({ ops: reducedOps }, null, 0);

  const template = [
    "You are executing a UI test plan in the user's ALREADY OPEN, ALREADY LOGGED-IN Chrome using your Claude in Chrome browser tools.",
    '',
    'Rules:',
    '- Open a NEW tab and go to <BASE_URL>. Do NOT log in, sign up, or type any credentials. If you hit a login wall, report the current step as failed with note "login required".',
    '- Execute "ops" in order. Do nothing that is not in the plan.',
    '- op.type "step": perform op.text in the browser (op.params has the exact values to use). Then look at the page and judge each item in op.checks (expected result for a specific caseId).',
    '- op.type "replay": the application state was changed by a previous branch. If fromBaseUrl is true, navigate to <BASE_URL> first. Then re-perform the listed steps quickly, in order. Do not print results for replay steps unless one fails (then print a RESULT with that step\'s nodeId and status "fail").',
    '- If a step cannot be performed, or the page is not in the state the step needs, mark that step "fail" with a short note and CONTINUE. Skip every later op whose "ancestors" array contains a nodeId that failed, and do not print results for skipped ops.',
    '- After each step op print exactly ONE line, on its own line, in this exact format (single line JSON, no line breaks inside):',
    '@@RESULT {"nodeId":"<nodeId>","status":"pass|fail","actionCode":"<TypeScript>","checks":[{"caseId":<number>,"status":"pass|fail","observed":"<short text>","assertCode":"<TypeScript>"}],"note":"<short text>"}@@',
    '- actionCode: Playwright TypeScript statements (no imports, no function wrapper) that repeat this step using the variables `page` (Playwright Page) and `p` (Record<string,string> of this step\'s params; reference values as p["name"]). Prefer getByRole / getByLabel / getByText / getByTestId over CSS. For navigation use `await page.goto(new URL("/path", process.env.BASE_URL!).toString());`. Include any waits needed (e.g. `await page.waitForLoadState()`). Only include actions you actually performed.',
    '- assertCode: one or more `await expect(...)` statements (variables `page`, `p` and `expect` available) that verify that check\'s expected result against what you observed. Keep them robust (prefer visible text / URL patterns over exact pixels).',
    '- All string values must be valid JSON strings (escape quotes and newlines as \\n).',
    '- When every op is finished print a final line: @@DONE@@',
    '- Do not print any other line that contains "@@".',
    '',
    '<<<PLAN',
    '<PLAN_JSON>',
    'PLAN>>>',
  ].join('\n');

  return template
    .split('<BASE_URL>').join(baseUrl)
    .split('<PLAN_JSON>').join(planJson);
}

export function parseResultLine(line: string): ParsedEvent[] {
  let text = line;
  try {
    const obj = JSON.parse(line) as { type?: unknown; message?: { content?: unknown } };
    if (obj && typeof obj === 'object' && obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
      text = (obj.message!.content as { type?: unknown; text?: unknown }[])
        .filter(c => c && c.type === 'text' && typeof c.text === 'string')
        .map(c => c.text as string)
        .join('\n');
    }
  } catch {
    // not JSON: treat the raw line as text
  }

  const events: ParsedEvent[] = [];
  for (const l of text.split('\n')) {
    if (/^\s*@@DONE@@\s*$/.test(l)) {
      events.push({ kind: 'done' });
      continue;
    }
    const m = /^\s*@@RESULT (\{.*\})@@\s*$/.exec(l);
    if (m) {
      try {
        events.push({ kind: 'result', result: JSON.parse(m[1]) as ResultPayload });
      } catch {
        // skip malformed result
      }
    }
  }
  return events;
}

export function deriveCaseStatuses(
  plan: Plan,
  nodeResults: Map<string, 'pass' | 'fail'>,
  checkResults: Map<string, 'pass' | 'fail'>,
): Map<number, { status: CaseStatus; note?: string }> {
  const opByNode = new Map<string, StepOp>();
  for (const op of plan.ops) if (op.type === 'step') opByNode.set(op.nodeId, op);

  const out = new Map<number, { status: CaseStatus; note?: string }>();
  for (const [caseIdStr, path] of Object.entries(plan.casePaths)) {
    const caseId = Number(caseIdStr);
    let result: { status: CaseStatus; note?: string } = { status: 'pass' };

    for (const nodeId of path) {
      const r = nodeResults.get(nodeId);
      if (r === 'fail') {
        result = { status: 'fail', note: `step failed at ${nodeId}` };
        break;
      }
      if (r === undefined) {
        const op = opByNode.get(nodeId);
        const ancestorFailed = (op?.ancestors ?? []).some(a => nodeResults.get(a) === 'fail');
        result = ancestorFailed
          ? { status: 'skipped', note: 'blocked by failed step' }
          : { status: 'error', note: `no result reported for ${nodeId}` };
        break;
      }

      const op = opByNode.get(nodeId);
      const checksForCase = (op?.checks ?? []).filter(c => c.caseId === caseId);
      let stop = false;
      for (const _c of checksForCase) {
        const key = `${nodeId}:${caseId}`;
        const cr = checkResults.get(key);
        if (cr === 'fail') {
          result = { status: 'fail', note: `expected result not met at ${nodeId}` };
          stop = true;
          break;
        }
        if (cr === undefined) {
          result = { status: 'error', note: `check not reported at ${nodeId}` };
          stop = true;
          break;
        }
      }
      if (stop) break;
    }
    out.set(caseId, result);
  }
  for (const caseId of plan.emptyCases) {
    out.set(caseId, { status: 'error', note: 'case has no steps' });
  }
  return out;
}

export function parsePlaywrightJson(json: unknown): Map<number, { status: 'pass' | 'fail'; note?: string }> {
  const out = new Map<number, { status: 'pass' | 'fail'; note?: string }>();
  const ansi = /\x1b\[[0-9;]*m/g;

  const visit = (suite: { title?: string; specs?: any[]; suites?: any[] }) => {
    for (const spec of suite.specs ?? []) {
      const m = /^C(\d+) /.exec(String(spec.title ?? ''));
      if (!m) continue;
      const caseId = Number(m[1]);
      if (spec.ok === true) {
        out.set(caseId, { status: 'pass' });
      } else {
        const msg: unknown = spec.tests?.[0]?.results?.[0]?.error?.message;
        const note = typeof msg === 'string' ? msg.replace(ansi, '').slice(0, 500) : undefined;
        out.set(caseId, { status: 'fail', note });
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };

  const root = json as { suites?: any[] };
  for (const s of root?.suites ?? []) visit(s);
  return out;
}

function runPlaywrightProcess(
  runId: number,
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(command, { shell: true, windowsHide: true, env });
    const entry = activeRuns.get(runId);
    if (entry) {
      entry.kill = () => {
        if (child.pid === undefined) return;
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else child.kill('SIGTERM');
      };
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', (e) => resolve({ stdout, stderr: stderr + e.message, code: 1 }));
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

async function executeClaudeFlow(
  runId: number,
  flowId: number,
  flowName: string,
  caseIds: number[],
  baseUrl: string,
  flowStats: { flowId: number; stats: Plan['stats'] | null }[],
  totals: Record<CaseStatus, number>,
  allStatuses: CaseStatus[],
): Promise<void> {
  const plan = buildPlan(loadPlannerCases(caseIds));
  flowStats.push({ flowId, stats: plan.stats });
  appendLog(runId, `plan for flow ${flowName}: ${plan.stats.originalSteps} steps -> ${plan.stats.plannedSteps} planned (${plan.stats.savedPct}% saved)`);

  const opMap = new Map<string, StepOp>();
  for (const op of plan.ops) if (op.type === 'step') opMap.set(op.nodeId, op);

  const nodeResults = new Map<string, 'pass' | 'fail'>();
  const checkResults = new Map<string, 'pass' | 'fail'>();

  const handleResult = (r: ResultPayload) => {
    const op = opMap.get(r.nodeId);
    if (!op) return;
    const status = r.status === 'pass' ? 'pass' : 'fail';
    const stepText = renderStep(op.text, op.params);
    const observed = (r.checks ?? []).map(c => c.observed).filter(Boolean).join(' | ') || null;
    const note = r.note && r.note !== '' ? r.note : null;
    db.prepare(
      'INSERT INTO run_step_results (run_id, flow_id, node_id, step_text, status, observed, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(runId, flowId, op.nodeId, stepText, status, observed, note);
    emitEvent(runId, {
      type: 'step', flowId, nodeId: op.nodeId, text: stepText, status,
      observed: observed ?? undefined, note: note ?? undefined,
    });
    nodeResults.set(op.nodeId, status);

    if (status === 'pass' && r.actionCode && r.actionCode.trim() !== '') {
      saveRecording(op.stepId, 'action', r.actionCode);
    }
    for (const check of r.checks ?? []) {
      const checkStatus = check.status === 'pass' ? 'pass' : 'fail';
      checkResults.set(`${op.nodeId}:${check.caseId}`, checkStatus);
      if (checkStatus === 'pass' && check.assertCode && check.assertCode.trim() !== '') {
        const expected = op.checks.find(c => c.caseId === check.caseId)?.expected;
        if (expected !== undefined) saveRecording(op.stepId, 'assert', check.assertCode, op.params, expected);
      }
    }
  };

  const onLine = (line: string) => {
    appendLog(runId, line);
    for (const ev of parseResultLine(line)) {
      if (ev.kind === 'result') handleResult(ev.result);
    }
  };

  const handle = spawnClaudeRun(buildClaudePrompt(baseUrl, plan, op => renderStep(op.text, op.params)), onLine);
  const entry = activeRuns.get(runId);
  if (entry) entry.kill = handle.kill;
  await handle.done;

  const statuses = deriveCaseStatuses(plan, nodeResults, checkResults);
  const upsert = db.prepare('INSERT OR REPLACE INTO run_case_results (run_id, case_id, status, note) VALUES (?, ?, ?, ?)');
  for (const caseId of caseIds) {
    const st = statuses.get(caseId) ?? { status: 'error' as CaseStatus, note: 'no result reported' };
    upsert.run(runId, caseId, st.status, st.note ?? null);
    totals[st.status]++;
    allStatuses.push(st.status);
    emitEvent(runId, { type: 'case', caseId, status: st.status, note: st.note });
  }

  try {
    regenerateFlowScripts(flowId);
  } catch (e) {
    appendLog(runId, `script generation failed for flow ${flowName}: ${(e as Error).message}`);
  }
}

async function executePlaywrightFlow(
  runId: number,
  flowId: number,
  flowName: string,
  caseIds: number[],
  baseUrl: string,
  flowStats: { flowId: number; stats: Plan['stats'] | null }[],
  totals: Record<CaseStatus, number>,
  allStatuses: CaseStatus[],
): Promise<void> {
  flowStats.push({ flowId, stats: null });
  try {
    regenerateFlowScripts(flowId);
  } catch (e) {
    appendLog(runId, `script generation failed for flow ${flowName}: ${(e as Error).message}`);
  }

  const slug = slugify(flowName);
  const specRel = `playwright/generated/${slug}.spec.ts`;
  const upsert = db.prepare('INSERT OR REPLACE INTO run_case_results (run_id, case_id, status, note) VALUES (?, ?, ?, ?)');

  const finishAll = (status: CaseStatus, note: string) => {
    for (const caseId of caseIds) {
      upsert.run(runId, caseId, status, note);
      totals[status]++;
      allStatuses.push(status);
      emitEvent(runId, { type: 'case', caseId, status, note });
    }
  };

  if (!fs.existsSync(path.resolve(specRel))) {
    appendLog(runId, `no generated script for flow ${flowName}`);
    finishAll('error', 'no generated script — run in Claude mode first');
    return;
  }

  const settings = getSettings();
  const reachable = await checkCdpReachable(settings.cdpUrl);
  if (!reachable) {
    appendLog(runId, `CDP not reachable at ${settings.cdpUrl} — start Chrome with: chrome --remote-debugging-port=9222`);
    finishAll('error', `Chrome not running with remote debugging. Start Chrome with: chrome --remote-debugging-port=9222`);
    return;
  }
  const env: NodeJS.ProcessEnv = { ...process.env, BASE_URL: baseUrl, CDP_URL: settings.cdpUrl };
  const proc = await runPlaywrightProcess(runId, `npx playwright test ${specRel} --reporter=json`, env);
  if (proc.stderr.trim() !== '') appendLog(runId, `[stderr] ${proc.stderr.trim().slice(-500)}`);

  let json: unknown = null;
  try {
    const start = proc.stdout.indexOf('{');
    json = JSON.parse(proc.stdout.slice(start, proc.stdout.lastIndexOf('}') + 1));
  } catch {
    json = null;
  }
  if (json === null) {
    finishAll('error', 'playwright produced no JSON report');
    return;
  }

  const results = parsePlaywrightJson(json);
  for (const caseId of caseIds) {
    const r = results.get(caseId);
    const status: CaseStatus = r ? r.status : 'error';
    const note = r ? r.note ?? null : 'not in generated script';
    upsert.run(runId, caseId, status, note);
    totals[status]++;
    allStatuses.push(status);
    emitEvent(runId, { type: 'case', caseId, status, note: note ?? undefined });
  }
}

async function execute(
  runId: number,
  flowIds: number[],
  mode: 'claude' | 'playwright',
  scope: 'all' | 'unverified' | 'failed',
  baseUrl: string,
  casesOverride?: number[],
): Promise<void> {
  const flowStats: { flowId: number; stats: Plan['stats'] | null }[] = [];
  const totals: Record<CaseStatus, number> = { pass: 0, fail: 0, skipped: 0, error: 0 };
  const allStatuses: CaseStatus[] = [];
  try {
    for (const flowId of flowIds) {
      const entry = activeRuns.get(runId);
      if (entry?.cancelled) break;
      const flow = db.prepare('SELECT name FROM flows WHERE id = ?').get(flowId) as { name: string } | undefined;
      const flowName = flow?.name ?? `#${flowId}`;
      const caseIds = casesOverride
        ? casesOverride.filter(id => {
            const row = db.prepare('SELECT id FROM cases WHERE id = ? AND flow_id = ?').get(id, flowId) as { id: number } | undefined;
            return !!row;
          })
        : selectCases(flowId, scope);
      if (caseIds.length === 0) {
        appendLog(runId, `no cases selected for flow ${flowName}`);
        continue;
      }
      if (mode === 'claude') {
        await executeClaudeFlow(runId, flowId, flowName, caseIds, baseUrl, flowStats, totals, allStatuses);
      } else {
        await executePlaywrightFlow(runId, flowId, flowName, caseIds, baseUrl, flowStats, totals, allStatuses);
      }
    }

    const cancelled = activeRuns.get(runId)?.cancelled === true;
    const finalStatus = cancelled
      ? 'cancelled'
      : allStatuses.length === 0
        ? 'failed'
        : allStatuses.every(s => s === 'pass') ? 'passed' : 'failed';
    db.prepare("UPDATE runs SET status = ?, stats_json = ?, finished_at = datetime('now') WHERE id = ?")
      .run(finalStatus, JSON.stringify({ flows: flowStats, totals }), runId);
    emitEvent(runId, { type: 'status', status: finalStatus });
    emitEvent(runId, { type: 'done' });
  } catch (e) {
    const message = (e as Error).message;
    db.prepare("UPDATE runs SET status = 'error', error = ?, finished_at = datetime('now') WHERE id = ?").run(message, runId);
    emitEvent(runId, { type: 'status', status: 'error' });
    emitEvent(runId, { type: 'done' });
  } finally {
    activeRuns.delete(runId);
    logCounts.delete(runId);
  }
}

export function startRun(opts: {
  flowIds: number[];
  mode: 'claude' | 'playwright';
  scope: 'all' | 'unverified' | 'failed';
  caseIds?: number[];
}): number {
  const running = db.prepare("SELECT id FROM runs WHERE status = 'running' LIMIT 1").get();
  if (running) throw new Error('a run is already in progress');

  const baseUrl = getSettings().baseUrl.trim();
  if (baseUrl === '') throw new Error('set the Base URL first');

  const info = db.prepare(
    "INSERT INTO runs (mode, scope, flow_ids, base_url, status) VALUES (?, ?, ?, ?, 'running')",
  ).run(opts.mode, opts.scope, JSON.stringify(opts.flowIds), baseUrl);
  const runId = Number(info.lastInsertRowid);

  activeRuns.set(runId, { cancelled: false, kill: () => {} });
  void execute(runId, opts.flowIds, opts.mode, opts.scope, baseUrl, opts.caseIds);
  return runId;
}

export function cancelRun(runId: number): boolean {
  const entry = activeRuns.get(runId);
  if (!entry) {
    // Orphaned run (server restarted) — force cancel via DB if still marked running.
    const row = db.prepare("SELECT id FROM runs WHERE id = ? AND status = 'running'").get(runId) as { id: number } | undefined;
    if (!row) return false;
    db.prepare(
      "UPDATE runs SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?"
    ).run(runId);
    bus.emit(`run:${runId}`, { type: 'status', status: 'cancelled' } satisfies RunEvent);
    bus.emit(`run:${runId}`, { type: 'done' } satisfies RunEvent);
    return true;
  }
  entry.cancelled = true;
  entry.kill();
  return true;
}
