import { describe, it, expect } from 'vitest';
import { buildPlan, type PlannerCase } from '../server/planner.js';
import type { Mutability } from '../shared/types.js';

const n = (stepId: number, mutability: Mutability, expected: string | null = null) => ({
  stepId, text: `step ${stepId}`, params: {}, mutability, expected,
});

describe('buildPlan', () => {
  it('shares a safe prefix between cases', () => {
    const cases: PlannerCase[] = [
      { caseId: 1, nodes: [n(1, 'safe'), n(2, 'safe'), n(3, 'mutating')] },
      { caseId: 2, nodes: [n(1, 'safe'), n(2, 'safe'), n(4, 'mutating')] },
      { caseId: 3, nodes: [n(1, 'safe'), n(5, 'safe')] },
    ];
    const plan = buildPlan(cases);
    const stepOps = plan.ops.filter(o => o.type === 'step');
    expect(stepOps.length).toBe(5);
    expect(plan.ops.filter(o => o.type === 'replay').length).toBe(0);
    expect(plan.stats).toEqual({ originalSteps: 8, plannedSteps: 5, savedPct: 37 });
  });

  it('adds a replay with base URL after a mutating fork', () => {
    const cases: PlannerCase[] = [
      { caseId: 1, nodes: [n(1, 'safe'), n(2, 'mutating'), n(3, 'mutating')] },
      { caseId: 2, nodes: [n(1, 'safe'), n(2, 'mutating'), n(4, 'safe')] },
    ];
    const plan = buildPlan(cases);
    expect(plan.ops.map(o => o.type)).toEqual(['step', 'step', 'step', 'replay', 'step']);
    const replay = plan.ops[3];
    expect(replay.type === 'replay' && replay.fromBaseUrl).toBe(true);
    if (replay.type === 'replay') {
      expect(replay.steps.map(s => s.stepId)).toEqual([1, 2]);
    }
    expect(plan.stats).toEqual({ originalSteps: 6, plannedSteps: 6, savedPct: 0 });
  });

  it('replays from the last reset checkpoint', () => {
    const cases: PlannerCase[] = [
      { caseId: 1, nodes: [n(1, 'safe'), n(2, 'reset'), n(3, 'mutating'), n(4, 'mutating')] },
      { caseId: 2, nodes: [n(1, 'safe'), n(2, 'reset'), n(3, 'mutating'), n(5, 'mutating')] },
    ];
    const plan = buildPlan(cases);
    const replay = plan.ops.find(o => o.type === 'replay');
    expect(replay).toBeDefined();
    if (replay && replay.type === 'replay') {
      expect(replay.fromBaseUrl).toBe(false);
      expect(replay.steps.map(s => s.stepId)).toEqual([2, 3]);
    }
  });

  it('reports empty cases separately', () => {
    const plan = buildPlan([{ caseId: 9, nodes: [] }]);
    expect(plan.emptyCases).toEqual([9]);
    expect(plan.ops.length).toBe(0);
    expect(plan.stats.savedPct).toBe(0);
  });
});
