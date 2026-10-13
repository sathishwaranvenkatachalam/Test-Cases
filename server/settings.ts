import { db } from './db.js';
import type { Settings } from '../shared/types.js';

const DEFAULTS: Settings = {
  baseUrl: '',
  cdpUrl: 'http://localhost:9222',
  claudeModel: 'sonnet',
  claudeRunArgs: '-p --chrome --output-format stream-json --verbose --allowedTools mcp__claude-in-chrome',
};

const KEYS = Object.keys(DEFAULTS) as (keyof Settings)[];

export function getSettings(): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const out: Settings = { ...DEFAULTS };
  for (const r of rows) {
    if ((KEYS as string[]).includes(r.key)) out[r.key as keyof Settings] = r.value;
  }
  return out;
}

export function setSettings(patch: Partial<Settings>): Settings {
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => {
    for (const k of KEYS) {
      if (patch[k] !== undefined) up.run(k, String(patch[k]));
    }
  })();
  return getSettings();
}
