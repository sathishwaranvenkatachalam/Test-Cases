import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { HttpError, isUniqueViolation, parseId, wrap } from '../http.js';
import { flowCoverage, caseIsFullyRecorded, regenerateFlowScripts } from '../scriptgen.js';
import { buildPlan, loadPlannerCases } from '../planner.js';
import { renderStep, slugify, normalizeKey } from '../util.js';
import type { PlanOp, Mutability } from '../../shared/types.js';

const router = Router();
const GEN_DIR = path.resolve('playwright', 'generated');
const MUTABILITIES: Mutability[] = ['safe', 'mutating', 'reset'];

interface FlowRow { id: number; name: string; created_at: string; }

function specPathFor(name: string): string {
  return path.join(GEN_DIR, `${slugify(name)}.spec.ts`);
}

function getFlow(id: number): FlowRow {
  const f = db.prepare('SELECT id, name, created_at FROM flows WHERE id = ?').get(id) as FlowRow | undefined;
  if (!f) throw new HttpError(404, 'flow not found');
  return f;
}

function regenSafe(flowId: number): void {
  try { regenerateFlowScripts(flowId); } catch { /* ignore script generation failures */ }
}

function nameFrom(body: unknown): string {
  const name = (body as { name?: unknown } | undefined)?.name;
  if (typeof name !== 'string' || name.trim() === '') throw new HttpError(400, 'name required');
  return name.trim();
}

router.get('/flows', wrap((_req, res) => {
  const flows = db.prepare('SELECT id, name FROM flows ORDER BY name COLLATE NOCASE').all() as { id: number; name: string }[];
  const countCases = db.prepare('SELECT COUNT(*) AS n FROM cases WHERE flow_id = ?');
  const countSteps = db.prepare(
    'SELECT COUNT(DISTINCT cs.step_id) AS n FROM case_steps cs JOIN cases c ON c.id = cs.case_id WHERE c.flow_id = ?',
  );
  const runs = db.prepare('SELECT id, status, finished_at, flow_ids FROM runs ORDER BY id DESC')
    .all() as { id: number; status: string; finished_at: string | null; flow_ids: string }[];

  res.json(flows.map(f => {
    const last = runs.find(r => (JSON.parse(r.flow_ids) as number[]).includes(f.id));
    return {
      id: f.id,
      name: f.name,
      caseCount: (countCases.get(f.id) as { n: number }).n,
      stepCount: (countSteps.get(f.id) as { n: number }).n,
      coverage: flowCoverage(f.id),
      lastRun: last ? { id: last.id, status: last.status, finished_at: last.finished_at } : null,
    };
  }));
}));

router.post('/flows', wrap((req, res) => {
  const name = nameFrom(req.body);
  try {
    const info = db.prepare('INSERT INTO flows (name) VALUES (?)').run(name);
    res.json(getFlow(Number(info.lastInsertRowid)));
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'flow name already exists');
    throw e;
  }
}));

router.patch('/flows/:id', wrap((req, res) => {
  const id = parseId(req.params.id);
  const old = getFlow(id);
  const name = nameFrom(req.body);
  try {
    db.prepare('UPDATE flows SET name = ? WHERE id = ?').run(name, id);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'flow name already exists');
    throw e;
  }
  const oldSpec = specPathFor(old.name);
  if (fs.existsSync(oldSpec)) fs.rmSync(oldSpec, { force: true });
  regenSafe(id);
  res.json(getFlow(id));
}));

router.delete('/flows/:id', wrap((req, res) => {
  const id = parseId(req.params.id);
  const flow = getFlow(id);
  db.prepare('DELETE FROM flows WHERE id = ?').run(id);
  const spec = specPathFor(flow.name);
  if (fs.existsSync(spec)) fs.rmSync(spec, { force: true });
  res.json({ ok: true });
}));

router.get('/flows/:id', wrap((req, res) => {
  const id = parseId(req.params.id);
  const flow = getFlow(id);
  const caseRows = db.prepare('SELECT id, external_id, title FROM cases WHERE flow_id = ? ORDER BY id')
    .all(id) as { id: number; external_id: string | null; title: string }[];
  const lastStatusStmt = db.prepare('SELECT status FROM run_case_results WHERE case_id = ? ORDER BY run_id DESC LIMIT 1');
  const stepsStmt = db.prepare(
    `SELECT cs.position AS position, cs.step_id AS stepId, cs.params_json AS params, cs.expected AS expected,
            s.canonical_text AS text, s.mutability AS mutability
       FROM case_steps cs JOIN steps s ON s.id = cs.step_id
      WHERE cs.case_id = ? ORDER BY cs.position`,
  );

  const cases = caseRows.map(c => {
    const last = lastStatusStmt.get(c.id) as { status: string } | undefined;
    const steps = (stepsStmt.all(c.id) as {
      position: number; stepId: number; params: string; expected: string | null; text: string; mutability: string;
    }[]).map(s => ({
      position: s.position,
      stepId: s.stepId,
      text: renderStep(s.text, JSON.parse(s.params) as Record<string, string>),
      mutability: s.mutability,
      expected: s.expected,
    }));
    return {
      id: c.id,
      externalId: c.external_id,
      title: c.title,
      lastStatus: last ? last.status : null,
      recorded: caseIsFullyRecorded(c.id).ok,
      steps,
    };
  });

  const plan = buildPlan(loadPlannerCases(caseRows.map(c => c.id)));
  const ops: PlanOp[] = plan.ops.map(op => {
    if (op.type === 'step') return { ...op, text: renderStep(op.text, op.params) };
    return { ...op, steps: op.steps.map(s => ({ ...s, text: renderStep(s.text, s.params) })) };
  });

  res.json({ flow, cases, plan: { stats: plan.stats, ops } });
}));

router.post('/cases/:id/move', wrap((req, res) => {
  const caseId = parseId(req.params.id);
  const c = db.prepare('SELECT id, flow_id FROM cases WHERE id = ?').get(caseId) as { id: number; flow_id: number } | undefined;
  if (!c) throw new HttpError(404, 'case not found');
  const flowId = (req.body as { flowId?: unknown } | undefined)?.flowId;
  if (typeof flowId !== 'number' || !Number.isInteger(flowId)) throw new HttpError(400, 'flowId required');
  getFlow(flowId);
  db.prepare("UPDATE cases SET flow_id = ?, updated_at = datetime('now') WHERE id = ?").run(flowId, caseId);
  regenSafe(c.flow_id);
  regenSafe(flowId);
  res.json({ ok: true });
}));

router.delete('/cases/:id', wrap((req, res) => {
  const caseId = parseId(req.params.id);
  const c = db.prepare('SELECT id, flow_id FROM cases WHERE id = ?').get(caseId) as { id: number; flow_id: number } | undefined;
  if (!c) throw new HttpError(404, 'case not found');
  db.prepare('DELETE FROM cases WHERE id = ?').run(caseId);
  regenSafe(c.flow_id);
  res.json({ ok: true });
}));

router.patch('/cases/:caseId/steps/:position', wrap((req, res) => {
  const caseId = parseId(req.params.caseId);
  const position = parseId(req.params.position);

  const cs = db.prepare(
    'SELECT case_id, position, step_id, params_json, expected FROM case_steps WHERE case_id = ? AND position = ?'
  ).get(caseId, position) as { case_id: number; position: number; step_id: number; params_json: string; expected: string | null } | undefined;
  if (!cs) throw new HttpError(404, 'step not found');

  const caseRow = db.prepare('SELECT id, flow_id FROM cases WHERE id = ?').get(caseId) as { id: number; flow_id: number } | undefined;
  if (!caseRow) throw new HttpError(404, 'case not found');

  const body = req.body as { text?: unknown; expected?: unknown; mutability?: unknown } | undefined;

  let stepId = cs.step_id;

  if (typeof body?.text === 'string' && body.text.trim() !== '') {
    const newText = body.text.trim();
    const key = normalizeKey(newText);
    const existing = db.prepare('SELECT id FROM steps WHERE key = ?').get(key) as { id: number } | undefined;
    if (existing) {
      stepId = existing.id;
    } else {
      const info = db.prepare(
        "INSERT INTO steps (key, canonical_text, mutability) VALUES (?, ?, 'safe')"
      ).run(key, newText);
      stepId = Number(info.lastInsertRowid);
    }
    db.prepare(
      "UPDATE case_steps SET step_id = ?, params_json = '{}' WHERE case_id = ? AND position = ?"
    ).run(stepId, caseId, position);
  }

  if (body && 'expected' in body) {
    const exp = typeof body.expected === 'string' && body.expected.trim() !== '' ? body.expected.trim() : null;
    db.prepare('UPDATE case_steps SET expected = ? WHERE case_id = ? AND position = ?').run(exp, caseId, position);
  }

  if (typeof body?.mutability === 'string' && MUTABILITIES.includes(body.mutability as Mutability)) {
    db.prepare('UPDATE steps SET mutability = ? WHERE id = ?').run(body.mutability, stepId);
  }

  regenSafe(caseRow.flow_id);

  const updated = db.prepare(
    `SELECT cs.position AS position, cs.step_id AS stepId, cs.expected AS expected,
            s.canonical_text AS text, s.mutability AS mutability, cs.params_json AS params
       FROM case_steps cs JOIN steps s ON s.id = cs.step_id
      WHERE cs.case_id = ? AND cs.position = ?`
  ).get(caseId, position) as { position: number; stepId: number; expected: string | null; text: string; mutability: string; params: string };

  res.json({
    position: updated.position,
    stepId: updated.stepId,
    text: renderStep(updated.text, JSON.parse(updated.params) as Record<string, string>),
    mutability: updated.mutability,
    expected: updated.expected,
  });
}));

router.post('/flows/:id/generate-scripts', wrap((req, res) => {
  const id = parseId(req.params.id);
  getFlow(id);
  res.json(regenerateFlowScripts(id));
}));

router.get('/flows/:id/script', wrap((req, res) => {
  const id = parseId(req.params.id);
  const flow = getFlow(id);
  const p = specPathFor(flow.name);
  if (!fs.existsSync(p)) throw new HttpError(404, 'script not generated yet');
  res.json({
    path: path.relative(process.cwd(), p).split(path.sep).join('/'),
    content: fs.readFileSync(p, 'utf8'),
  });
}));

export default router;
