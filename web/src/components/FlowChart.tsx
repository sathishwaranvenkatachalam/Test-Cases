import { useMemo, useState, useCallback, type ReactNode } from 'react';
import type { PlanOpView } from '../api';

const STEP_W = 210;
const STEP_H_BASE = 32;
const STEP_LINE_H = 13;
const TC_W = 130;
const TC_H = 52;
const HGAP = 20;
const VGAP = 52;
const ROOT_W = 160;
const ROOT_H = 44;

interface FlowChartProps {
  flowId: number;
  flowName: string;
  ops: PlanOpView[];
  cases: Array<{
    id: number;
    externalId: string | null;
    title: string;
    lastStatus: string | null;
  }>;
  onRunCase: (caseId: number) => void;
  onCaseClick: (caseId: number) => void;
}

interface StepNode {
  id: string;
  type: 'root' | 'step';
  label: string;
  mutability?: string;
  isShared: boolean;
  sharedCount: number;
  ancestorIds: string[];
  children: TreeNode[];
  x: number;
  y: number;
  subtreeW: number;
  h: number;
}

interface TcNode {
  id: string;
  type: 'tc';
  caseId: number;
  label: string;
  title: string;
  lastStatus: string | null;
  children: TreeNode[];
  x: number;
  y: number;
  subtreeW: number;
  h: number;
}

type TreeNode = StepNode | TcNode;

function computeStepH(text: string): number {
  const charW = 6.1;
  const usable = STEP_W - 18;
  const words = text.split(' ');
  let lines = 1, cur = 0;
  for (const w of words) {
    const ww = (w.length + 1) * charW;
    if (cur + ww > usable && cur > 0) { lines++; cur = ww; }
    else cur += ww;
  }
  return Math.max(STEP_H_BASE, lines * STEP_LINE_H + 10);
}

function wrapText(text: string, maxW: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (test.length * 6.2 > maxW - 16) {
      if (cur) lines.push(cur);
      cur = w;
    } else { cur = test; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function layoutSubtree(node: TreeNode): void {
  for (const c of node.children) layoutSubtree(c);
  const selfW = node.type === 'root' ? ROOT_W : node.type === 'step' ? STEP_W : TC_W;
  if (node.children.length === 0) {
    node.subtreeW = selfW;
    return;
  }
  const total = node.children.reduce((s, c) => s + c.subtreeW, 0)
    + Math.max(0, node.children.length - 1) * HGAP;
  node.subtreeW = Math.max(selfW, total);
}

function assignX(node: TreeNode, startX: number): void {
  node.x = startX + node.subtreeW / 2;
  let cx = startX;
  for (const c of node.children) {
    assignX(c, cx);
    cx += c.subtreeW + HGAP;
  }
}

function assignY(node: TreeNode, y: number): void {
  node.y = y;
  for (const c of node.children) {
    assignY(c, y + node.h + VGAP);
  }
}

function getBounds(node: TreeNode): { maxX: number; maxY: number } {
  const hw = node.type === 'root' ? ROOT_W / 2 : node.type === 'step' ? STEP_W / 2 : TC_W / 2;
  let maxX = node.x + hw;
  let maxY = node.y + node.h;
  for (const c of node.children) {
    const b = getBounds(c);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  return { maxX, maxY };
}

function statusColor(status: string | null): { fill: string; stroke: string; text: string } {
  if (status === 'pass')    return { fill: '#052e16', stroke: '#22c55e', text: '#86efac' };
  if (status === 'fail')    return { fill: '#2d0a0a', stroke: '#ef4444', text: '#fca5a5' };
  if (status === 'error')   return { fill: '#2d0a0a', stroke: '#ef4444', text: '#fca5a5' };
  if (status === 'skipped') return { fill: '#1c1306', stroke: '#f59e0b', text: '#fcd34d' };
  return { fill: '#0f3058', stroke: '#3b82f6', text: '#93c5fd' };
}

function buildTree(
  flowName: string,
  ops: PlanOpView[],
  cases: FlowChartProps['cases'],
): StepNode {
  const root: StepNode = {
    id: 'root', type: 'root', label: flowName,
    isShared: false, sharedCount: 0, ancestorIds: [],
    children: [], x: 0, y: 0, subtreeW: 0, h: ROOT_H,
  };
  const nodeMap = new Map<string, StepNode>();
  nodeMap.set('root', root);

  const caseMap = new Map(cases.map(c => [c.id, c]));

  for (const op of ops) {
    if (op.type !== 'step') continue;
    const node: StepNode = {
      id: op.nodeId,
      type: 'step',
      label: op.text,
      mutability: op.mutability,
      isShared: op.caseIds.length > 1,
      sharedCount: op.caseIds.length,
      ancestorIds: op.ancestors,
      children: [],
      x: 0, y: 0, subtreeW: 0, h: 0,
    };
    node.h = computeStepH(op.text);
    nodeMap.set(op.nodeId, node);
  }

  for (const op of ops) {
    if (op.type !== 'step') continue;
    const parentId = op.ancestors.length > 0 ? op.ancestors[op.ancestors.length - 1] : 'root';
    const parent = nodeMap.get(parentId);
    const self = nodeMap.get(op.nodeId);
    if (parent && self) {
      parent.children.push(self);
      for (const caseId of op.endsCases) {
        const c = caseMap.get(caseId);
        if (!c) continue;
        const tcNode: TcNode = {
          id: `tc_${caseId}`,
          type: 'tc',
          caseId,
          label: c.externalId ?? `C${c.id}`,
          title: c.title,
          lastStatus: c.lastStatus,
          children: [],
          x: 0, y: 0, subtreeW: 0, h: TC_H,
        };
        self.children.push(tcNode);
      }
    }
  }

  return root;
}

export default function FlowChart({ flowId: _flowId, flowName, ops, cases, onRunCase, onCaseClick }: FlowChartProps) {
  const [hoveredPath, setHoveredPath] = useState<Set<string>>(new Set());

  const root = useMemo(() => {
    const r = buildTree(flowName, ops, cases);
    layoutSubtree(r);
    assignX(r, 0);
    assignY(r, 40);
    return r;
  }, [flowName, ops, cases]);

  const { maxX, maxY } = useMemo(() => getBounds(root), [root]);
  const svgW = maxX + 40;
  const svgH = maxY + 40;

  const getPath = useCallback((nodeId: string): Set<string> => {
    const ids = new Set<string>();
    const find = (n: TreeNode, path: string[]): boolean => {
      const cur = [...path, n.id];
      if (n.id === nodeId) { cur.forEach(id => ids.add(id)); return true; }
      return n.children.some(c => find(c, cur));
    };
    find(root, []);
    return ids;
  }, [root]);

  const links = useMemo(() => {
    const result: Array<{ fromId: string; toId: string; fromNode: TreeNode; toNode: TreeNode }> = [];
    const walk = (n: TreeNode) => {
      for (const c of n.children) {
        result.push({ fromId: n.id, toId: c.id, fromNode: n, toNode: c });
        walk(c);
      }
    };
    walk(root);
    return result;
  }, [root]);

  const makePath = (n1: TreeNode, n2: TreeNode): string => {
    const x1 = n1.x, y1 = n1.y + n1.h;
    const x2 = n2.x, y2 = n2.y;
    const mid = (y1 + y2) / 2;
    return `M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`;
  };

  const renderNode = (node: TreeNode): ReactNode => {
    if (node.type === 'root') {
      const lines = wrapText(node.label, ROOT_W);
      return (
        <g key={node.id}>
          <ellipse
            cx={node.x} cy={node.y + ROOT_H / 2}
            rx={ROOT_W / 2} ry={ROOT_H / 2}
            fill="#1e3a5f" stroke="#60a5fa" strokeWidth={2}
          />
          {lines.map((l, i) => (
            <text key={i}
              x={node.x} y={node.y + ROOT_H / 2 - (lines.length - 1) * 7 + i * 14}
              textAnchor="middle" dominantBaseline="middle"
              fill="#bfdbfe" fontSize={12} fontWeight={700}
            >{l}</text>
          ))}
        </g>
      );
    }

    if (node.type === 'step') {
      const isHovered = hoveredPath.size > 0;
      const inPath = hoveredPath.has(node.id);
      const opacity = isHovered && !inPath ? 0.25 : 1;
      const fillColor = isHovered && inPath ? '#1a3a5c' : '#1e2533';
      const strokeColor = isHovered && inPath ? '#60a5fa' : node.isShared ? '#2563eb' : '#334155';
      const strokeWidth = isHovered && inPath ? 2 : 1.5;
      const lines = wrapText(node.label, STEP_W);

      return (
        <g
          key={node.id}
          style={{ opacity, cursor: 'default' }}
          onMouseEnter={() => setHoveredPath(getPath(node.id))}
          onMouseLeave={() => setHoveredPath(new Set())}
        >
          <rect
            x={node.x - STEP_W / 2} y={node.y}
            width={STEP_W} height={node.h} rx={5}
            fill={fillColor} stroke={strokeColor} strokeWidth={strokeWidth}
          />
          {node.isShared && (
            <>
              <rect
                x={node.x - STEP_W / 2} y={node.y}
                width={3} height={node.h} rx={2}
                fill="#3b82f6" opacity={0.7}
              />
              <rect
                x={node.x + STEP_W / 2 - 26} y={node.y + 2}
                width={24} height={13} rx={3}
                fill="#1e3a5f"
              />
              <text
                x={node.x + STEP_W / 2 - 14} y={node.y + 8.5}
                textAnchor="middle" dominantBaseline="middle"
                fill="#60a5fa" fontSize={8} fontWeight={700}
              >×{node.sharedCount}</text>
            </>
          )}
          {lines.map((l, i) => (
            <text key={i}
              x={node.x + (node.isShared ? 3 : 0)}
              y={node.y + node.h / 2 - (lines.length - 1) * STEP_LINE_H / 2 + i * STEP_LINE_H}
              textAnchor="middle" dominantBaseline="middle"
              fill="#cbd5e1" fontSize={11}
            >{l}</text>
          ))}
        </g>
      );
    }

    if (node.type === 'tc') {
      const st = node.lastStatus;
      const col = statusColor(st);
      const isHovered = hoveredPath.size > 0;
      const inPath = hoveredPath.has(node.id);
      const opacity = isHovered && !inPath ? 0.2 : 1;
      const labelShort = node.label.length > 12 ? node.label.slice(0, 12) + '…' : node.label;
      const titleShort = node.title.length > 18 ? node.title.slice(0, 18) + '…' : node.title;
      const btnY = node.y + TC_H - 18;
      const btnW = 70;
      const btnH = 14;

      return (
        <g
          key={node.id}
          style={{ opacity, cursor: 'pointer' }}
          onMouseEnter={() => setHoveredPath(getPath(node.id))}
          onMouseLeave={() => setHoveredPath(new Set())}
        >
          <rect
            x={node.x - TC_W / 2} y={node.y}
            width={TC_W} height={TC_H - 18} rx={5}
            fill={col.fill} stroke={col.stroke} strokeWidth={2}
            onClick={() => onCaseClick(node.caseId)}
          />
          <text
            x={node.x} y={node.y + 13}
            textAnchor="middle" dominantBaseline="middle"
            fill={col.text} fontSize={11} fontWeight={700}
            onClick={() => onCaseClick(node.caseId)}
            style={{ cursor: 'pointer' }}
          >{labelShort}</text>
          <text
            x={node.x} y={node.y + 25}
            textAnchor="middle" dominantBaseline="middle"
            fill={col.text} fontSize={9} opacity={0.8}
            onClick={() => onCaseClick(node.caseId)}
            style={{ cursor: 'pointer' }}
          >{titleShort}</text>
          <rect
            x={node.x - btnW / 2} y={btnY}
            width={btnW} height={btnH} rx={3}
            fill="#1d4ed8" stroke="#3b82f6" strokeWidth={1}
            style={{ cursor: 'pointer' }}
            onClick={(e) => { e.stopPropagation(); onRunCase(node.caseId); }}
          />
          <text
            x={node.x} y={btnY + btnH / 2}
            textAnchor="middle" dominantBaseline="middle"
            fill="#bfdbfe" fontSize={9} fontWeight={600}
            style={{ cursor: 'pointer' }}
            onClick={(e) => { e.stopPropagation(); onRunCase(node.caseId); }}
          >▶ Run Test</text>
        </g>
      );
    }

    return null;
  };

  const renderAllNodes = (n: TreeNode): ReactNode[] => {
    const result: ReactNode[] = [renderNode(n)];
    for (const c of n.children) result.push(...renderAllNodes(c));
    return result;
  };

  return (
    <div style={{ overflowX: 'auto', background: '#0f1117', borderRadius: 8, padding: '16px 0' }}>
      <svg
        width={svgW}
        height={svgH}
        style={{ display: 'block', margin: '0 auto', overflow: 'visible' }}
      >
        <g>
          {links.map(l => (
            <path
              key={`${l.fromId}-${l.toId}`}
              d={makePath(l.fromNode, l.toNode)}
              fill="none"
              stroke={
                hoveredPath.size > 0
                  ? hoveredPath.has(l.fromId) && hoveredPath.has(l.toId)
                    ? '#3b82f6'
                    : '#1a2230'
                  : '#2a3a50'
              }
              strokeWidth={
                hoveredPath.size > 0 && hoveredPath.has(l.fromId) && hoveredPath.has(l.toId)
                  ? 2.5
                  : 1.5
              }
            />
          ))}
        </g>
        <g>
          {renderAllNodes(root)}
        </g>
      </svg>
    </div>
  );
}
