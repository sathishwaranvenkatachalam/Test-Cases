import { z } from 'zod';
import { db } from './db.js';
import { parseWorkbook, extractRawCases } from './parse.js';
import { claudeJson } from './claude.js';
import { normalizeKey, renderStep, caseSignature } from './util.js';
import { regenerateFlowScripts } from './scriptgen.js';
import type { CanonCase, CanonStep, ColumnMapping, RawCase, Mutability } from '../shared/types.js';

export interface PreviewCase {
  idx: number; externalId: string | null; title: string; flowName: string;
  steps: CanonStep[];
  status: 'new' | 'changed' | 'unchanged';
  matchedCaseId: number | null;
  before: string[] | null;   // rendered old steps (changed only)
  after: string[];           // rendered new steps
}
export interface IngestPayload { cases: PreviewCase[]; summary: { new: number; changed: number; unchanged: number; reviewNeeded: number; newSteps: number; reusedSteps: number }; }

interface ExistingStep { id: number; text: string; key: string; }

const BATCH_SIZE = 15;
const PREFILTER_THRESHOLD = 300;
const PREFILTER_TOP = 60;

const CanonStepSchema = z.object({
  existingStepId: z.number().nullable().optional().transform(v => v ?? null),
  canonicalText: z.string(),
  params: z.record(z.string(), z.unknown()).optional().transform(r => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(r ?? {})) out[k] = String(v);
    return out;
  }),
  mutability: z.enum(['safe', 'mutating', 'reset']),
  expected: z.string().nullable().optional().transform(v => v ?? null),
  confidence: z.number().min(0).max(1).optional().transform(v => v ?? 1),
});
const CanonCaseSchema = z.object({
  index: z.number(),
  flow: z.string().nullable().optional(),
  steps: z.array(CanonStepSchema).min(1),
});
const CanonResponseSchema = z.object({ cases: z.array(CanonCaseSchema) });

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w !== ''));
}

function buildCanonPrompt(existingFlows: string[], existingSteps: ExistingStep[], batch: unknown[]): string {
  return [
    'You normalize manual QA test cases into atomic, reusable UI test steps. Respond with ONLY a JSON object, no prose, no markdown fences, and do not use any tools.',
    '',
    'Rules:',
    '1. Split each case into atomic steps (one user action each). Keep the original order. You may split or merge the raw steps provided.',
    '2. Write each step as a short imperative canonicalText. Replace variable data (usernames, passwords, emails, quantities, names, search text, amounts) with {placeholders} (snake_case) and put the actual values in "params". Never put real secrets in canonicalText.',
    '3. Two steps that mean the same action must have IDENTICAL canonicalText and the same placeholder names. Prefer reusing an existing step from the list EXISTING_STEPS: set existingStepId to its id, and key "params" by THAT step\'s placeholders. Only set existingStepId when the meaning is the same; set "confidence" (0..1) = how sure you are that it is the same step. If nothing fits, existingStepId = null and confidence = 1.',
    '4. mutability: "safe" = read-only or idempotent setup (open page, navigate, login with an already-logged-in session, view, search); "mutating" = changes app data/state (create, edit, delete, submit, add to cart); "reset" = returns the app to a known baseline (navigate home/dashboard, logout, clear cart, close dialog).',
    '5. expected: the expected result that should be observable right AFTER that step, or null. If the case only has an overall expected result, attach it to the last step.',
    '6. flow: the functional flow/feature name for the case. If the case has flowName use it unchanged; otherwise infer a short Title Case name, preferring names from EXISTING_FLOWS.',
    '',
    'Output schema: {"cases":[{"index":<number>,"flow":<string>,"steps":[{"existingStepId":<number|null>,"canonicalText":<string>,"params":{<name>:<string>},"mutability":"safe|mutating|reset","expected":<string|null>,"confidence":<number>}]}]}',
    '',
    `EXISTING_FLOWS: ${JSON.stringify(existingFlows)}`,
    `EXISTING_STEPS: ${JSON.stringify(existingSteps.map(s => ({ id: s.id, text: s.text })))}`,
    `CASES: ${JSON.stringify(batch)}`,
  ].join('\n');
}

export async function buildPreview(sessionId: number, sheet: string, mapping: ColumnMapping): Promise<IngestPayload> {
  const session = db.prepare('SELECT id, file_path FROM ingest_sessions WHERE id = ?').get(sessionId) as
    | { id: number; file_path: string } | undefined;
  if (!session) throw new Error('session not found');

  const sheets = parseWorkbook(session.file_path);
  const found = sheets.find(s => s.name === sheet);
  if (!found) throw new Error('sheet not found');
  const rawCases: RawCase[] = extractRawCases(found, mapping);
  if (rawCases.length === 0) throw new Error('no test cases found with this mapping');

  const allExisting = db.prepare('SELECT id, canonical_text AS text, key FROM steps').all() as ExistingStep[];
  const existingIds = new Set(allExisting.map(s => s.id));
  const existingKeys = new Set(allExisting.map(s => s.key));
  const existingFlows = (db.prepare('SELECT name FROM flows ORDER BY name').all() as { name: string }[]).map(r => r.name);

  const canonByIndex = new Map<number, CanonCase>();

  for (let batchStart = 0; batchStart < rawCases.length; batchStart += BATCH_SIZE) {
    const batch = rawCases.slice(batchStart, batchStart + BATCH_SIZE);
    const batchItems = batch.map((c, i) => ({
      index: i,
      externalId: c.externalId,
      title: c.title,
      flowName: c.flowName,
      steps: c.steps,
      finalExpected: c.finalExpected,
    }));

    let existingForBatch: ExistingStep[];
    if (allExisting.length <= PREFILTER_THRESHOLD) {
      existingForBatch = allExisting;
    } else {
      const batchWords = new Set<string>();
      for (const c of batch) for (const s of c.steps) for (const w of words(s.text)) batchWords.add(w);
      const scored = allExisting
        .map(e => {
          let overlap = 0;
          for (const w of words(e.text)) if (batchWords.has(w)) overlap++;
          return { e, overlap };
        })
        .sort((a, b) => b.overlap - a.overlap)
        .slice(0, PREFILTER_TOP)
        .map(x => x.e);
      const union = new Map<number, ExistingStep>();
      for (const e of scored) union.set(e.id, e);
      existingForBatch = [...union.values()];
    }

    const prompt = buildCanonPrompt(existingFlows, existingForBatch, batchItems);
    const raw = await claudeJson<unknown>('canonicalize', prompt, { cases: batchItems, existing: existingForBatch });
    const parsed = CanonResponseSchema.parse(raw);

    const byIdx = new Map<number, z.infer<typeof CanonCaseSchema>>();
    for (const c of parsed.cases) byIdx.set(c.index, c);

    for (let i = 0; i < batch.length; i++) {
      const got = byIdx.get(i);
      if (!got) throw new Error(`claude omitted case ${batchStart + i}`);
      const steps: CanonStep[] = got.steps.map(s => ({
        existingStepId: s.existingStepId !== null && existingIds.has(s.existingStepId) ? s.existingStepId : null,
        canonicalText: s.canonicalText,
        params: s.params,
        mutability: s.mutability as Mutability,
        expected: s.expected,
        confidence: s.confidence,
      }));
      canonByIndex.set(batchStart + i, { index: batchStart + i, flow: got.flow ?? null, steps });
    }
  }

  const findExisting = db.prepare('SELECT id, flow_id, title, signature FROM cases WHERE external_id = ? LIMIT 1');
  const findByTitle = db.prepare('SELECT id, flow_id, title, signature FROM cases WHERE lower(title) = lower(?) LIMIT 1');
  const oldSteps = db.prepare(
    'SELECT s.canonical_text AS text, cs.params_json AS params FROM case_steps cs JOIN steps s ON s.id = cs.step_id WHERE cs.case_id = ? ORDER BY cs.position',
  );

  const cases: PreviewCase[] = [];
  let reviewNeeded = 0;
  let reusedSteps = 0;
  const newKeys = new Set<string>();

  for (let idx = 0; idx < rawCases.length; idx++) {
    const raw = rawCases[idx];
    const canon = canonByIndex.get(idx);
    if (!canon) throw new Error(`claude omitted case ${idx}`);
    const flowName = raw.flowName && raw.flowName.trim() !== ''
      ? raw.flowName.trim()
      : (canon.flow?.trim() || 'General');

    const steps = canon.steps;
    for (const s of steps) {
      const key = normalizeKey(s.canonicalText);
      const reused = (s.existingStepId !== null && s.confidence >= 0.85) || existingKeys.has(key);
      if (s.existingStepId !== null && s.confidence >= 0.5 && s.confidence < 0.85) reviewNeeded++;
      if (reused) reusedSteps++;
      else if (!existingKeys.has(key)) newKeys.add(key);
    }

    const existing = raw.externalId !== null
      ? findExisting.get(raw.externalId) as { id: number; flow_id: number; title: string; signature: string } | undefined
      : findByTitle.get(raw.title) as { id: number; flow_id: number; title: string; signature: string } | undefined;

    const after = steps.map(s => renderStep(s.canonicalText, s.params));
    const signature = caseSignature(raw.title, steps.map(s => ({
      key: normalizeKey(s.canonicalText),
      params: s.params,
      expected: s.expected,
    })));

    if (!existing) {
      cases.push({ idx, externalId: raw.externalId, title: raw.title, flowName, steps, status: 'new', matchedCaseId: null, before: null, after });
    } else if (existing.signature === signature) {
      cases.push({ idx, externalId: raw.externalId, title: raw.title, flowName, steps, status: 'unchanged', matchedCaseId: existing.id, before: null, after });
    } else {
      const before = (oldSteps.all(existing.id) as { text: string; params: string }[])
        .map(r => renderStep(r.text, JSON.parse(r.params) as Record<string, string>));
      cases.push({ idx, externalId: raw.externalId, title: raw.title, flowName, steps, status: 'changed', matchedCaseId: existing.id, before, after });
    }
  }

  const summary = {
    new: cases.filter(c => c.status === 'new').length,
    changed: cases.filter(c => c.status === 'changed').length,
    unchanged: cases.filter(c => c.status === 'unchanged').length,
    reviewNeeded,
    newSteps: newKeys.size,
    reusedSteps,
  };
  const payload: IngestPayload = { cases, summary };
  db.prepare("UPDATE ingest_sessions SET payload_json = ?, status = 'previewed' WHERE id = ?")
    .run(JSON.stringify(payload), sessionId);
  return payload;
}

export function commitPreview(sessionId: number): { createdCases: number; updatedCases: number; newSteps: number; reviews: number; affectedFlowIds: number[] } {
  const session = db.prepare('SELECT id, status, payload_json FROM ingest_sessions WHERE id = ?').get(sessionId) as
    | { id: number; status: string; payload_json: string | null } | undefined;
  if (!session) throw new Error('session not found');
  if (session.status !== 'previewed' || !session.payload_json) throw new Error('session not previewed');
  const payload = JSON.parse(session.payload_json) as IngestPayload;

  const findFlow = db.prepare('SELECT id FROM flows WHERE name = ? COLLATE NOCASE');
  const insertFlow = db.prepare('INSERT INTO flows (name) VALUES (?)');
  const findStepById = db.prepare('SELECT id, key FROM steps WHERE id = ?');
  const findStepByKey = db.prepare('SELECT id, key FROM steps WHERE key = ?');
  const insertStep = db.prepare('INSERT INTO steps (key, canonical_text, mutability) VALUES (?, ?, ?)');
  const findPendingReview = db.prepare(
    "SELECT id FROM merge_reviews WHERE new_step_id = ? AND candidate_step_id = ? AND status = 'pending'",
  );
  const insertReview = db.prepare('INSERT INTO merge_reviews (new_step_id, candidate_step_id, confidence) VALUES (?, ?, ?)');
  const insertCase = db.prepare('INSERT INTO cases (flow_id, external_id, title, signature) VALUES (?, ?, ?, ?)');
  const updateCase = db.prepare(
    "UPDATE cases SET flow_id = ?, title = ?, signature = ?, updated_at = datetime('now') WHERE id = ?",
  );
  const deleteCaseSteps = db.prepare('DELETE FROM case_steps WHERE case_id = ?');
  const insertCaseStep = db.prepare(
    'INSERT INTO case_steps (case_id, position, step_id, params_json, expected) VALUES (?, ?, ?, ?, ?)',
  );
  const caseFlow = db.prepare('SELECT flow_id FROM cases WHERE id = ?');
  const markCommitted = db.prepare("UPDATE ingest_sessions SET status = 'committed' WHERE id = ?");

  const affected = new Set<number>();
  let createdCases = 0;
  let updatedCases = 0;
  let newSteps = 0;
  let reviews = 0;

  const result = db.transaction(() => {
    for (const pc of payload.cases) {
      if (pc.status === 'unchanged') continue;

      const flowRow = findFlow.get(pc.flowName) as { id: number } | undefined;
      const flowId = flowRow ? flowRow.id : Number(insertFlow.run(pc.flowName).lastInsertRowid);
      affected.add(flowId);

      if (pc.status === 'changed' && pc.matchedCaseId !== null) {
        const old = caseFlow.get(pc.matchedCaseId) as { flow_id: number } | undefined;
        if (old) affected.add(old.flow_id);
      }

      const resolved: { stepId: number; key: string; params: Record<string, string>; expected: string | null }[] = [];
      for (const s of pc.steps) {
        const key = normalizeKey(s.canonicalText);
        let stepId: number | null = null;

        if (s.existingStepId !== null && s.confidence >= 0.85) {
          const row = findStepById.get(s.existingStepId) as { id: number } | undefined;
          if (row) stepId = row.id;
        }
        if (stepId === null) {
          const row = findStepByKey.get(key) as { id: number } | undefined;
          if (row) stepId = row.id;
        }
        if (stepId === null) {
          stepId = Number(insertStep.run(key, s.canonicalText, s.mutability).lastInsertRowid);
          newSteps++;
          if (s.existingStepId !== null && s.confidence >= 0.5) {
            const candidate = findStepById.get(s.existingStepId) as { id: number } | undefined;
            if (candidate && !findPendingReview.get(stepId, candidate.id)) {
              insertReview.run(stepId, candidate.id, s.confidence);
              reviews++;
            }
          }
        }

        const stepRow = findStepById.get(stepId) as { id: number; key: string };
        resolved.push({ stepId, key: stepRow.key, params: s.params, expected: s.expected });
      }

      const signature = caseSignature(pc.title, resolved.map(r => ({ key: r.key, params: r.params, expected: r.expected })));

      let caseId: number;
      if (pc.status === 'new') {
        caseId = Number(insertCase.run(flowId, pc.externalId, pc.title, signature).lastInsertRowid);
        createdCases++;
      } else {
        caseId = pc.matchedCaseId as number;
        updateCase.run(flowId, pc.title, signature, caseId);
        deleteCaseSteps.run(caseId);
        updatedCases++;
      }

      resolved.forEach((r, position) => {
        insertCaseStep.run(caseId, position, r.stepId, JSON.stringify(r.params), r.expected);
      });
    }

    markCommitted.run(sessionId);
    return { createdCases, updatedCases, newSteps, reviews, affectedFlowIds: [...affected] };
  })();

  for (const flowId of result.affectedFlowIds) {
    try { regenerateFlowScripts(flowId); } catch { /* ignore script generation failures */ }
  }
  return result;
}
