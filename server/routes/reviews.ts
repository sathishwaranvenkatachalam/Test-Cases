import { Router } from 'express';
import { db } from '../db.js';
import { HttpError, parseId, wrap } from '../http.js';
import { regenerateFlowScripts } from '../scriptgen.js';

const router = Router();
const STATUSES = ['pending', 'approved', 'rejected'];

function usedBy(stepId: number): number {
  return (db.prepare('SELECT COUNT(DISTINCT case_id) AS n FROM case_steps WHERE step_id = ?').get(stepId) as { n: number }).n;
}

router.get('/reviews', wrap((req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
  if (!STATUSES.includes(status)) throw new HttpError(400, 'invalid status');
  const rows = db.prepare(
    `SELECT mr.id AS id, mr.confidence AS confidence, mr.status AS status,
            ns.id AS newId, ns.canonical_text AS newText,
            cs.id AS candId, cs.canonical_text AS candText
       FROM merge_reviews mr
       JOIN steps ns ON ns.id = mr.new_step_id
       JOIN steps cs ON cs.id = mr.candidate_step_id
      WHERE mr.status = ? ORDER BY mr.id`,
  ).all(status) as {
    id: number; confidence: number; status: string; newId: number; newText: string; candId: number; candText: string;
  }[];
  res.json(rows.map(r => ({
    id: r.id,
    confidence: r.confidence,
    status: r.status,
    newStep: { id: r.newId, text: r.newText, usedBy: usedBy(r.newId) },
    candidateStep: { id: r.candId, text: r.candText, usedBy: usedBy(r.candId) },
  })));
}));

router.post('/reviews/:id/approve', wrap((req, res) => {
  const id = parseId(req.params.id);
  const review = db.prepare('SELECT id, new_step_id, candidate_step_id, status FROM merge_reviews WHERE id = ?').get(id) as
    | { id: number; new_step_id: number; candidate_step_id: number; status: string } | undefined;
  if (!review) throw new HttpError(404, 'review not found');
  if (review.status !== 'pending') throw new HttpError(409, 'review is not pending');

  const flowIds = (db.prepare(
    `SELECT DISTINCT c.flow_id AS flowId FROM case_steps cs JOIN cases c ON c.id = cs.case_id WHERE cs.step_id = ?`,
  ).all(review.new_step_id) as { flowId: number }[]).map(r => r.flowId);

  db.transaction(() => {
    db.prepare('UPDATE case_steps SET step_id = ? WHERE step_id = ?').run(review.candidate_step_id, review.new_step_id);
    // Deleting the new step cascades its recordings and any reviews that point at it (including this one).
    db.prepare('DELETE FROM steps WHERE id = ?').run(review.new_step_id);
    db.prepare("UPDATE merge_reviews SET status = 'approved' WHERE id = ?").run(id);
  })();

  for (const flowId of flowIds) {
    try { regenerateFlowScripts(flowId); } catch { /* ignore script generation failures */ }
  }
  res.json({ ok: true });
}));

router.post('/reviews/:id/reject', wrap((req, res) => {
  const id = parseId(req.params.id);
  const info = db.prepare("UPDATE merge_reviews SET status = 'rejected' WHERE id = ?").run(id);
  if (info.changes === 0) throw new HttpError(404, 'review not found');
  res.json({ ok: true });
}));

export default router;
