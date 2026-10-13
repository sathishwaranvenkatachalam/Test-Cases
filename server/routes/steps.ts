import { Router } from 'express';
import { db } from '../db.js';
import { HttpError, parseId, wrap } from '../http.js';
import type { Mutability } from '../../shared/types.js';

const router = Router();
const MUTABILITIES: Mutability[] = ['safe', 'mutating', 'reset'];

router.get('/steps', wrap((_req, res) => {
  const rows = db.prepare(
    `SELECT s.id AS id, s.canonical_text AS text, s.mutability AS mutability,
            (SELECT COUNT(DISTINCT case_id) FROM case_steps WHERE step_id = s.id) AS usedBy,
            EXISTS(SELECT 1 FROM recordings r WHERE r.step_id = s.id AND r.kind = 'action') AS hasRecording
       FROM steps s ORDER BY s.canonical_text COLLATE NOCASE`,
  ).all() as { id: number; text: string; mutability: Mutability; usedBy: number; hasRecording: number }[];
  res.json(rows.map(r => ({ ...r, hasRecording: r.hasRecording === 1 })));
}));

router.patch('/steps/:id', wrap((req, res) => {
  const id = parseId(req.params.id);
  const mutability = (req.body as { mutability?: unknown } | undefined)?.mutability;
  if (typeof mutability !== 'string' || !MUTABILITIES.includes(mutability as Mutability)) {
    throw new HttpError(400, 'mutability must be safe, mutating or reset');
  }
  const exists = db.prepare('SELECT id FROM steps WHERE id = ?').get(id);
  if (!exists) throw new HttpError(404, 'step not found');
  db.prepare('UPDATE steps SET mutability = ? WHERE id = ?').run(mutability, id);
  res.json(db.prepare('SELECT id, canonical_text AS text, mutability FROM steps WHERE id = ?').get(id));
}));

export default router;
