import { useEffect, useRef, useState } from 'react';

interface Props {
  lines: string[];
  live?: boolean;
}

interface LogCard {
  idx: number;
  source: 'system' | 'stderr' | 'claude' | 'result' | 'done';
  level: 'info' | 'warn' | 'error' | 'debug' | 'result-pass' | 'result-fail' | 'done';
  body: string;
  detail?: { nodeId?: string; status?: string; note?: string };
}

function parseLine(raw: string, idx: number): LogCard {
  const base = (level: LogCard['level'], body: string, detail?: LogCard['detail']): LogCard =>
    ({ idx, source: 'system', level, body, detail });

  // @@DONE@@
  if (/^\s*@@DONE@@\s*$/.test(raw)) {
    return { idx, source: 'done', level: 'done', body: 'Run finished' };
  }

  // @@RESULT {...}@@
  const rm = /^\s*@@RESULT (\{.*\})@@\s*$/.exec(raw);
  if (rm) {
    try {
      const r = JSON.parse(rm[1]) as { nodeId?: string; status?: string; note?: string };
      const level: LogCard['level'] = r.status === 'pass' ? 'result-pass' : 'result-fail';
      const body = r.nodeId ? `Step ${r.nodeId}: ${r.status ?? '?'}` : `Result: ${r.status ?? '?'}`;
      return { idx, source: 'result', level, body, detail: { nodeId: r.nodeId, status: r.status, note: r.note } };
    } catch { /* fall through */ }
  }

  // [stderr] ...
  if (raw.startsWith('[stderr]')) {
    return { idx, source: 'stderr', level: 'warn', body: raw.slice('[stderr]'.length).trim() };
  }

  // Claude JSON envelope: {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
  if (raw.trimStart().startsWith('{')) {
    try {
      const obj = JSON.parse(raw) as { type?: unknown; message?: { content?: unknown } };
      if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        const text = (obj.message!.content as { type?: unknown; text?: unknown }[])
          .filter(c => c.type === 'text' && typeof c.text === 'string')
          .map(c => c.text as string)
          .join('\n')
          .trim();
        if (text) return { idx, source: 'claude', level: 'info', body: text };
      }
    } catch { /* not JSON */ }
  }

  // Plain text — detect level from keywords
  const u = raw.toUpperCase();
  if (u.includes('ERROR') || u.includes(' ERR ') || u.includes('[ERR]')) return base('error', raw);
  if (u.includes('WARN') || u.includes('[WARN]')) return base('warn', raw);
  if (u.includes('DEBUG') || u.includes('[DEBUG]')) return base('debug', raw);
  return base('info', raw);
}

const LEVEL_LABEL: Record<LogCard['level'], string> = {
  info: 'INFO', warn: 'WARN', error: 'ERROR', debug: 'DEBUG',
  'result-pass': 'PASS', 'result-fail': 'FAIL', done: 'DONE',
};

export default function LogPanel({ lines, live = false }: Props) {
  const [filter, setFilter] = useState('');
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (follow && live && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, follow, live]);

  useEffect(() => {
    if (!live && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [live]);

  const cards = lines.map((l, i) => parseLine(l, i));
  const filterLow = filter.toLowerCase();
  const visible = filter ? cards.filter(c => c.body.toLowerCase().includes(filterLow)) : cards;

  const copy = () => {
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const toggle = (idx: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  return (
    <div className="log-panel">
      <div className="log-toolbar">
        <input
          className="log-search"
          placeholder="Filter logs…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <span className="log-count">
          {filter ? `${visible.length} / ${cards.length}` : `${cards.length}`} entries
        </span>
        {live && (
          <button
            type="button"
            className={`log-follow-btn${follow ? ' active' : ''}`}
            onClick={() => setFollow(f => !f)}
          >
            {follow ? '⬇ Following' : '⬇ Follow'}
          </button>
        )}
        <button type="button" className="log-copy-btn" onClick={copy}>
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <div className="log-body" ref={scrollRef}>
        {visible.length === 0 ? (
          <span className="log-empty">
            {filter ? 'No entries match.' : 'No output yet.'}
          </span>
        ) : (
          <div className="log-cards">
            {visible.map(card => {
              const isExpanded = expanded.has(card.idx);
              const long = card.body.length > 100 || card.body.includes('\n');
              return (
                <div
                  key={card.idx}
                  className={`log-card lc-${card.level}`}
                  onClick={long ? () => toggle(card.idx) : undefined}
                  style={long ? { cursor: 'pointer' } : undefined}
                >
                  <div className="log-card-header">
                    <span className={`log-card-badge lcb-${card.level}`}>
                      {LEVEL_LABEL[card.level]}
                    </span>
                    {card.source === 'stderr' && (
                      <span className="log-card-src">stderr</span>
                    )}
                    {card.source === 'claude' && (
                      <span className="log-card-src">claude</span>
                    )}
                    <span className="log-card-idx">#{card.idx + 1}</span>
                  </div>
                  <div className={`log-card-body${long && !isExpanded ? ' truncated' : ''}`}>
                    {card.body}
                  </div>
                  {card.detail && (card.detail.nodeId || card.detail.note) && (
                    <div className="log-card-detail">
                      {card.detail.nodeId && (
                        <span className="log-chip">node: {card.detail.nodeId}</span>
                      )}
                      {card.detail.note && (
                        <span className="log-chip">{card.detail.note}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
