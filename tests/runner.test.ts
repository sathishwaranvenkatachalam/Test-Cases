import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from '../server/db.js';
import { setSettings } from '../server/settings.js';
import { parseWorkbook, guessMapping } from '../server/parse.js';
import { buildPreview, commitPreview } from '../server/ingest.js';
import {
  parseResultLine, deriveCaseStatuses, parsePlaywrightJson, startRun, bus,
} from '../server/runner.js';
import { buildPlan, type PlannerCase } from '../server/planner.js';
import type { Mutability, Plan } from '../shared/types.js';

const GEN = path.resolve('playwright', 'generated');

const n = (stepId: number, mutability: Mutability) => ({ stepId, text: `step ${stepId}`, params: {}, mutability, expected: null });

describe('parseResultLine', () => {
  it('parses a raw RESULT line', () => {
    const events = parseResultLine('@@RESULT {"nodeId":"n1","status":"pass","checks":[]}@@');
    expect(events).toEqual([{ kind: 'result', result: { nodeId: 'n1', status: 'pass', checks: [] } }]);
  });

  it('parses two RESULT lines inside a stream-json assistant message', () => {
    const text = '@@RESULT {"nodeId":"n1","status":"pass"}@@\n@@RESULT {"nodeId":"n2","status":"fail","note":"x"}@@';
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    const events = parseResultLine(line);
    expect(events.length).toBe(2);
    expect(events[1]).toEqual({ kind: 'result', result: { nodeId: 'n2', status: 'fail', note: 'x' } });
  });

  it('returns an empty array for garbage and detects DONE', () => {
    expect(parseResultLine('just some log output')).toEqual([]);
    expect(parseResultLine('@@DONE@@')).toEqual([{ kind: 'done' }]);
  });
});

describe('deriveCaseStatuses', () => {
  const cases: PlannerCase[] = [
    { caseId: 1, nodes: [n(1, 'safe'), n(2, 'mutating'), n(3, 'mutating')] },
    { caseId: 2, nodes: [n(1, 'safe'), n(2, 'mutating'), n(4, 'safe')] },
  ];
  const plan = buildPlan(cases);

  it('marks both cases failed when the shared node fails', () => {
    const statuses = deriveCaseStatuses(plan, new Map([['n1', 'pass'], ['n2', 'fail']]), new Map());
    expect(statuses.get(1)?.status).toBe('fail');
    expect(statuses.get(2)?.status).toBe('fail');
  });

  it('fails only the branch whose node fails', () => {
    const statuses = deriveCaseStatuses(plan, new Map([['n1', 'pass'], ['n2', 'pass'], ['n3', 'fail'], ['n4', 'pass']]), new Map());
    expect(statuses.get(1)?.status).toBe('fail');
    expect(statuses.get(2)?.status).toBe('pass');
  });

  it('marks a case skipped when an ancestor failed and the node has no result', () => {
    const manual = {
      ops: [
        { type: 'step', nodeId: 'n5', stepId: 5, text: 'a', params: {}, mutability: 'safe', ancestors: ['n0'], caseIds: [2], checks: [], endsCases: [] },
        { type: 'step', nodeId: 'n6', stepId: 6, text: 'b', params: {}, mutability: 'safe', ancestors: ['n0', 'n5'], caseIds: [2], checks: [], endsCases: [2] },
      ],
      casePaths: { 2: ['n5', 'n6'] },
      emptyCases: [],
      stats: { originalSteps: 2, plannedSteps: 2, savedPct: 0 },
    } as unknown as Plan;
    const statuses = deriveCaseStatuses(manual, new Map([['n0', 'fail']]), new Map());
    expect(statuses.get(2)?.status).toBe('skipped');
  });
});

describe('parsePlaywrightJson', () => {
  it('maps passing and failing specs by case id', () => {
    const json = {
      suites: [{
        title: 'login.spec.ts',
        suites: [{
          title: 'Login',
          specs: [
            { title: 'C1 Valid login', ok: true, tests: [{ results: [{ status: 'passed' }] }] },
            { title: 'C2 Bad login', ok: false, tests: [{ results: [{ status: 'failed', error: { message: '\u001b[31mExpected visible\u001b[39m' } }] }] },
          ],
        }],
      }],
    };
    const map = parsePlaywrightJson(json);
    expect(map.get(1)).toEqual({ status: 'pass' });
    expect(map.get(2)).toEqual({ status: 'fail', note: 'Expected visible' });
  });
});

describe('full stub run', () => {
  afterAll(() => {
    for (const f of ['steps.ts', 'login.spec.ts', 'cart.spec.ts']) fs.rmSync(path.join(GEN, f), { force: true });
  });

  it('runs the ingested flow in claude mode with the stub and records results', async () => {
    const csv = [
      'ID,Title,Module,Steps,Expected',
      'TC-1,Valid login,Login,"Open login page\nLogin as admin",Dashboard shown',
      'TC-2,Guest login,Login,"Open login page\nLogin as guest",',
    ].join('\n');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfm-runner-'));
    const file = path.join(dir, 'run.csv');
    fs.writeFileSync(file, csv, 'utf8');

    const sessionId = Number(db.prepare('INSERT INTO ingest_sessions (filename, file_path) VALUES (?, ?)').run('run.csv', file).lastInsertRowid);
    const sheet = parseWorkbook(file)[0];
    await buildPreview(sessionId, sheet.name, guessMapping(sheet.headers, sheet.rows));
    commitPreview(sessionId);

    const flowId = (db.prepare("SELECT id FROM flows WHERE name = 'Login'").get() as { id: number }).id;
    setSettings({ baseUrl: 'http://example.test' });

    const events: string[] = [];
    const runId = startRun({ flowIds: [flowId], mode: 'claude', scope: 'all' });
    const listener = (ev: { type: string }) => events.push(ev.type);
    bus.on(`run:${runId}`, listener);

    let status = 'running';
    const deadline = Date.now() + 5000;
    while (status === 'running' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 25));
      status = (db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }).status;
    }
    bus.off(`run:${runId}`, listener);

    expect(status).toBe('passed');
    const results = db.prepare('SELECT status FROM run_case_results WHERE run_id = ?').all(runId) as { status: string }[];
    expect(results.length).toBe(2);
    expect(results.every(r => r.status === 'pass')).toBe(true);

    const recCount = (db.prepare('SELECT COUNT(*) AS n FROM recordings').get() as { n: number }).n;
    expect(recCount).toBeGreaterThan(0);
    const assertCount = (db.prepare("SELECT COUNT(*) AS n FROM recordings WHERE kind = 'assert'").get() as { n: number }).n;
    expect(assertCount).toBeGreaterThan(0);

    expect(fs.existsSync(path.join(GEN, 'login.spec.ts'))).toBe(true);
    expect(events).toContain('done');
  });
});
