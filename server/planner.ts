import { db } from './db.js';
import { stableStringify } from './util.js';
import type { Mutability, Plan, PlanOp, PlanNodeRef, StepOp, ReplayOp } from '../shared/types.js';

export interface PlannerCase {
  caseId: number;
  nodes: { stepId: number; text: string; params: Record<string, string>; mutability: Mutability; expected: string | null }[];
}

interface TrieNode {
  nodeId: string;
  key: string;
  stepId: number;
  text: string;
  params: Record<string, string>;
  mutability: Mutability;
  parent: TrieNode | null;
  children: TrieNode[];
  caseIds: number[];
  checks: { caseId: number; expected: string }[];
  endsCases: number[];
}

function nodeKey(stepId: number, params: Record<string, string>): string {
  return stepId + '|' + stableStringify(params);
}

export function buildPlan(cases: PlannerCase[]): Plan {
  const emptyCases: number[] = [];
  const remaining: PlannerCase[] = [];
  for (const c of cases) {
    if (c.nodes.length === 0) emptyCases.push(c.caseId);
    else remaining.push(c);
  }

  const sorted = remaining
    .map(c => ({ c, k: c.nodes.map(n => nodeKey(n.stepId, n.params)).join('\u0001') }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.c.caseId - b.c.caseId))
    .map(x => x.c);

  let counter = 0;
  const root: TrieNode = {
    nodeId: 'root', key: '', stepId: -1, text: '', params: {}, mutability: 'safe',
    parent: null, children: [], caseIds: [], checks: [], endsCases: [],
  };
  const casePaths: Record<number, string[]> = {};

  for (const c of sorted) {
    let cur = root;
    const path: string[] = [];
    for (const n of c.nodes) {
      const key = nodeKey(n.stepId, n.params);
      let child = cur.children.find(ch => ch.key === key);
      if (!child) {
        counter++;
        child = {
          nodeId: 'n' + counter, key, stepId: n.stepId, text: n.text, params: n.params, mutability: n.mutability,
          parent: cur, children: [], caseIds: [], checks: [], endsCases: [],
        };
        cur.children.push(child);
      }
      child.caseIds.push(c.caseId);
      if (n.expected && n.expected !== '') child.checks.push({ caseId: c.caseId, expected: n.expected });
      path.push(child.nodeId);
      cur = child;
    }
    cur.endsCases.push(c.caseId);
    casePaths[c.caseId] = path;
  }

  const ops: PlanOp[] = [];

  const toRef = (n: TrieNode): PlanNodeRef => ({ nodeId: n.nodeId, stepId: n.stepId, text: n.text, params: n.params });

  const emit = (node: TrieNode, pathFromRoot: TrieNode[]) => {
    const stepOp: StepOp = {
      type: 'step',
      nodeId: node.nodeId,
      stepId: node.stepId,
      text: node.text,
      params: node.params,
      mutability: node.mutability,
      ancestors: pathFromRoot.slice(0, -1).map(n => n.nodeId),
      caseIds: node.caseIds,
      checks: node.checks,
      endsCases: node.endsCases,
    };
    ops.push(stepOp);

    node.children.forEach((child, i) => {
      if (node.mutability === 'mutating' && i >= 1) {
        let r = -1;
        for (let j = pathFromRoot.length - 1; j >= 0; j--) {
          if (pathFromRoot[j].mutability === 'reset') { r = j; break; }
        }
        const replaySteps = r >= 0 ? pathFromRoot.slice(r) : pathFromRoot;
        const replay: ReplayOp = {
          type: 'replay',
          fromBaseUrl: r < 0,
          steps: replaySteps.map(toRef),
        };
        ops.push(replay);
      }
      emit(child, [...pathFromRoot, child]);
    });
  };

  for (const child of root.children) emit(child, [child]);

  let originalSteps = 0;
  for (const c of remaining) originalSteps += c.nodes.length;
  let plannedSteps = 0;
  for (const op of ops) {
    if (op.type === 'step') plannedSteps += 1;
    else plannedSteps += op.steps.length;
  }
  const savedPct = originalSteps === 0 ? 0 : Math.max(0, Math.floor(((originalSteps - plannedSteps) / originalSteps) * 100));

  return {
    ops,
    casePaths,
    emptyCases,
    stats: { originalSteps, plannedSteps, savedPct },
  };
}

export function loadPlannerCases(caseIds: number[]): PlannerCase[] {
  const stmt = db.prepare(
    `SELECT cs.step_id AS stepId, cs.params_json AS params, cs.expected AS expected,
            s.canonical_text AS text, s.mutability AS mutability
       FROM case_steps cs JOIN steps s ON s.id = cs.step_id
      WHERE cs.case_id = ? ORDER BY cs.position`,
  );
  return caseIds.map(caseId => {
    const rows = stmt.all(caseId) as {
      stepId: number; params: string; expected: string | null; text: string; mutability: Mutability;
    }[];
    return {
      caseId,
      nodes: rows.map(r => ({
        stepId: r.stepId,
        text: r.text,
        params: JSON.parse(r.params) as Record<string, string>,
        mutability: r.mutability,
        expected: r.expected,
      })),
    };
  });
}
