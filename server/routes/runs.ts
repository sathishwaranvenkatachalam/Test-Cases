import { Router } from 'express';
import { db } from '../db.js';
import { HttpError, parseId, wrap } from '../http.js';
import { bus, startRun, cancelRun } from '../runner.js';

const router = Router();
const MODES = ['claude', 'playwright'];
const SCOPES = ['all', 'unverified', 'failed'];

interface RunRow {
  id: number; mode: string; scope: string; flow_ids: string; base_url: string; status: string;
  error: string | null; stats_json: string | null; started_at: string; finished_at: string | null;
}

function runWithParsedFlows(row: RunRow) {
  return { ...row, flow_ids: JSON.parse(row.flow_ids) as number[], stats: row.stats_json ? JSON.parse(row.stats_json) : null };
}

function buildRunPayload(runId: number) {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
  if (!row) throw new HttpError(404, 'run not found');
  const caseResults = db.prepare(
    `SELECT rcr.case_id AS caseId, c.title AS title, rcr.status AS status, rcr.note AS note
       FROM run_case_results rcr LEFT JOIN cases c ON c.id = rcr.case_id
      WHERE rcr.run_id = ? ORDER BY rcr.case_id`,
  ).all(runId);
  const stepResults = db.prepare(
    `SELECT id, flow_id AS flowId, node_id AS nodeId, step_text AS text, status, observed, note
       FROM run_step_results WHERE run_id = ? ORDER BY id`,
  ).all(runId);
  const logs = (db.prepare('SELECT line FROM run_logs WHERE run_id = ? ORDER BY id DESC LIMIT 200')
    .all(runId) as { line: string }[]).map(r => r.line).reverse();
  return { run: runWithParsedFlows(row), caseResults, stepResults, logs };
}

router.post('/runs', wrap((req, res) => {
  const body = (req.body ?? {}) as { flowIds?: unknown; mode?: unknown; scope?: unknown; caseIds?: unknown };
  if (!Array.isArray(body.flowIds) || body.flowIds.length === 0 || !body.flowIds.every((x: unknown) => Number.isInteger(x))) {
    throw new HttpError(400, 'flowIds required');
  }
  if (typeof body.mode !== 'string' || !MODES.includes(body.mode)) throw new HttpError(400, 'invalid mode');
  if (typeof body.scope !== 'string' || !SCOPES.includes(body.scope)) throw new HttpError(400, 'invalid scope');
  const caseIds: number[] | undefined =
    body.caseIds === undefined
      ? undefined
      : Array.isArray(body.caseIds) && body.caseIds.every((x: unknown) => Number.isInteger(x))
        ? (body.caseIds as number[])
        : (() => { throw new HttpError(400, 'invalid caseIds'); })();
  try {
    const id = startRun({
      flowIds: body.flowIds as number[],
      mode: body.mode as 'claude' | 'playwright',
      scope: body.scope as 'all' | 'unverified' | 'failed',
      caseIds,
    });
    res.json({ id });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === 'a run is already in progress') throw new HttpError(409, msg);
    throw new HttpError(400, msg);
  }
}));

router.get('/runs', wrap((_req, res) => {
  const rows = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 50').all() as RunRow[];
  res.json(rows.map(runWithParsedFlows));
}));

router.get('/runs/:id', wrap((req, res) => {
  res.json(buildRunPayload(parseId(req.params.id)));
}));

router.get('/runs/:id/events', (req, res, next) => {
  try {
    const runId = parseId(req.params.id);
    const snapshot = buildRunPayload(runId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

    const listener = (ev: unknown) => {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    bus.on(`run:${runId}`, listener);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);

    req.on('close', () => {
      clearInterval(ping);
      bus.off(`run:${runId}`, listener);
    });
  } catch (e) {
    next(e);
  }
});

router.post('/runs/:id/cancel', wrap((req, res) => {
  const id = parseId(req.params.id);
  res.json({ cancelled: cancelRun(id) });
}));

export default router;
