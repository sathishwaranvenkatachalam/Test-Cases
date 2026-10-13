import { Router } from 'express';
import { getSettings, setSettings } from '../settings.js';
import { HttpError, wrap } from '../http.js';
import type { Settings } from '../../shared/types.js';

const router = Router();
const KEYS: (keyof Settings)[] = ['baseUrl', 'cdpUrl', 'claudeModel', 'claudeRunArgs'];

router.get('/settings', wrap((_req, res) => {
  res.json(getSettings());
}));

router.put('/settings', wrap((req, res) => {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be an object');
  const patch: Partial<Settings> = {};
  for (const k of KEYS) {
    if (k in body) {
      const v = body[k];
      if (typeof v !== 'string') throw new HttpError(400, `${k} must be a string`);
      patch[k] = v;
    }
  }
  res.json(setSettings(patch));
}));

export default router;
