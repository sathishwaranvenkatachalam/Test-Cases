import { guessMapping } from './parse.js';
import { normalizeKey } from './util.js';
import type { RawCase, CanonCase, CanonStep } from '../shared/types.js';

export interface StubExisting { id: number; text: string; key: string; }

const SAFE_RE = /^(open|go to|navigate|visit|login|log in|sign in|view|check|verify)/i;

export function stubJson(kind: 'canonicalize' | 'detect-mapping' | string, input: unknown): unknown {
  if (kind === 'detect-mapping') {
    const i = input as { headers: string[]; rows: Record<string, string>[] };
    return guessMapping(i.headers, i.rows);
  }
  if (kind === 'canonicalize') {
    const i = input as { cases: (RawCase & { index?: number })[]; existing: StubExisting[] };
    const cases: CanonCase[] = i.cases.map((c, idx) => {
      const steps: CanonStep[] = c.steps.map(s => {
        const text = s.text.trim();
        const key = normalizeKey(s.text);
        const found = i.existing.find(e => e.key === key);
        return {
          existingStepId: found ? found.id : null,
          canonicalText: text,
          params: {},
          mutability: SAFE_RE.test(text) ? 'safe' : 'mutating',
          expected: s.expected ?? null,
          confidence: 1,
        };
      });
      if (c.finalExpected && steps.length > 0 && !steps[steps.length - 1].expected) {
        steps[steps.length - 1].expected = c.finalExpected;
      }
      return { index: idx, flow: c.flowName ?? 'General', steps };
    });
    return { cases };
  }
  throw new Error(`stub: unknown kind ${kind}`);
}

function assistantLine(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
}

export function stubRunLines(prompt: string): string[] {
  const start = prompt.indexOf('<<<PLAN');
  const end = prompt.indexOf('PLAN>>>');
  if (start < 0 || end < 0) throw new Error('stub: plan markers not found in prompt');
  const body = prompt.slice(start + '<<<PLAN'.length, end).trim();
  const plan = JSON.parse(body) as { ops: { type: string; [k: string]: any }[] };
  const lines: string[] = [];
  for (const op of plan.ops) {
    if (op.type !== 'step') continue;
    const result = {
      nodeId: op.nodeId,
      status: 'pass',
      actionCode: 'await page.getByText(' + JSON.stringify(op.text) + ').click();',
      checks: (op.checks as { caseId: number }[]).map(c => ({
        caseId: c.caseId,
        status: 'pass',
        observed: 'stub',
        assertCode: 'await expect(page.locator("body")).toBeVisible();',
      })),
      note: '',
    };
    lines.push(assistantLine('@@RESULT ' + JSON.stringify(result) + '@@'));
  }
  lines.push(assistantLine('@@DONE@@'));
  return lines;
}
