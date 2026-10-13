import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { HttpError, parseId, wrap } from '../http.js';
import { parseWorkbook, guessMapping, type ParsedSheet } from '../parse.js';
import { claudeJson } from '../claude.js';
import { buildPreview, commitPreview } from '../ingest.js';
import type { ColumnMapping } from '../../shared/types.js';

const router = Router();
const UPLOAD_DIR = 'data/uploads';
const ALLOWED_EXT = ['.xlsx', '.xls', '.csv'];
const MAPPING_FIELDS = ['caseId', 'title', 'flow', 'steps', 'expected', 'stepNo'] as const;

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      cb(null, UPLOAD_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT.includes(ext)) cb(null, true);
    else cb(new HttpError(400, 'unsupported file type'));
  },
});

function getSession(id: number): { id: number; file_path: string } {
  const s = db.prepare('SELECT id, file_path FROM ingest_sessions WHERE id = ?').get(id) as
    | { id: number; file_path: string } | undefined;
  if (!s) throw new HttpError(404, 'session not found');
  return s;
}

function findSheet(sheets: ParsedSheet[], name: unknown): ParsedSheet {
  const sheet = sheets.find(s => s.name === name);
  if (!sheet) throw new HttpError(400, 'sheet not found');
  return sheet;
}

// Keeps only values that are real header names (or null); unknown mode falls back to per-row-case.
function sanitizeMapping(raw: unknown, headers: string[]): ColumnMapping {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const headerSet = new Set(headers);
  const mapping: ColumnMapping = {
    mode: obj.mode === 'per-row-step' ? 'per-row-step' : 'per-row-case',
    caseId: null, title: null, flow: null, steps: null, expected: null, stepNo: null,
  };
  for (const f of MAPPING_FIELDS) {
    const v = obj[f];
    mapping[f] = typeof v === 'string' && headerSet.has(v) ? v : null;
  }
  return mapping;
}

router.post('/ingest/parse', upload.single('file'), wrap((req, res) => {
  if (!req.file) throw new HttpError(400, 'file required');
  const sheets = parseWorkbook(req.file.path);
  const info = db.prepare('INSERT INTO ingest_sessions (filename, file_path) VALUES (?, ?)')
    .run(req.file.originalname, req.file.path);
  res.json({
    sessionId: Number(info.lastInsertRowid),
    filename: req.file.originalname,
    sheets: sheets.map(s => ({
      name: s.name,
      headers: s.headers,
      rowCount: s.rows.length,
      sample: s.rows.slice(0, 5),
      mapping: guessMapping(s.headers, s.rows),
    })),
  });
}));

router.post('/ingest/:id/detect-mapping', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const session = getSession(id);
  const sheet = findSheet(parseWorkbook(session.file_path), (req.body as { sheet?: unknown } | undefined)?.sheet);
  const prompt = "Given spreadsheet headers and sample rows, return ONLY a JSON ColumnMapping object "
    + "{mode:'per-row-case'|'per-row-step', caseId,title,flow,steps,expected,stepNo: header name or null}. "
    + `Headers: ${JSON.stringify(sheet.headers)}. `
    + `Sample rows: ${JSON.stringify(sheet.rows.slice(0, 5))}.`;
  const raw = await claudeJson<unknown>('detect-mapping', prompt, { headers: sheet.headers, rows: sheet.rows });
  res.json(sanitizeMapping(raw, sheet.headers));
}));

router.post('/ingest/:id/preview', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const session = getSession(id);
  const body = (req.body ?? {}) as { sheet?: unknown; mapping?: unknown };
  const sheet = findSheet(parseWorkbook(session.file_path), body.sheet);
  const mapping = sanitizeMapping(body.mapping, sheet.headers);
  res.json(await buildPreview(id, sheet.name, mapping));
}));

router.post('/ingest/:id/commit', wrap((req, res) => {
  const id = parseId(req.params.id);
  getSession(id);
  res.json(commitPreview(id));
}));

export default router;
