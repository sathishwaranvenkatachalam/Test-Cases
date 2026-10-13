import { Router } from 'express';
import { wrap } from '../http.js';
import { getSettings } from '../settings.js';
import { checkCdpReachable, launchChromeWithDebugging } from '../chrome.js';

const router = Router();

router.get('/system/cdp-status', wrap(async (_req, res) => {
  const { cdpUrl } = getSettings();
  const reachable = await checkCdpReachable(cdpUrl);
  res.json({ reachable, cdpUrl });
}));

router.post('/system/launch-chrome', wrap(async (_req, res) => {
  const { cdpUrl } = getSettings();
  let port = 9222;
  try { port = Number(new URL(cdpUrl).port) || 9222; } catch { /* use default */ }
  const result = launchChromeWithDebugging(port);
  if (!result.ok) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
}));

export default router;
