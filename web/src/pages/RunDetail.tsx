import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, jsonInit, type RunDetailPayload } from '../api';
import Badge from '../components/Badge';

type LiveEvent =
  | { type: 'status'; status: string }
  | { type: 'step'; flowId: number; nodeId: string; text: string; status: string; observed?: string; note?: string }
  | { type: 'case'; caseId: number; status: string; note?: string }
  | { type: 'log'; line: string }
  | { type: 'done' };

const LOG_CAP = 500;

export default function RunDetail() {
  const { id } = useParams();
  const runId = Number(id);
  const navigate = useNavigate();

  const [data, setData] = useState<RunDetailPayload | null>(null);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const liveIds = useRef(0);

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;

    api<RunDetailPayload>(`/runs/${runId}`)
      .then(d => {
        if (cancelled) return;
        setData(d);
        setLiveStatus(d.run.status);
        if (d.run.status !== 'running') return;

        es = new EventSource(`/api/runs/${runId}/events`);
        const source = es;
        source.addEventListener('snapshot', (e) => {
          const snap = JSON.parse((e as MessageEvent).data) as RunDetailPayload;
          setData(snap);
          setLiveStatus(snap.run.status);
        });
        source.onmessage = (e) => {
          const ev = JSON.parse(e.data) as LiveEvent;
          if (ev.type === 'step') {
            liveIds.current -= 1;
            const row = {
              id: liveIds.current, flowId: ev.flowId, nodeId: ev.nodeId, text: ev.text, status: ev.status,
              observed: ev.observed ?? null, note: ev.note ?? null,
            };
            setData(prev => (prev ? { ...prev, stepResults: [...prev.stepResults, row] } : prev));
          } else if (ev.type === 'case') {
            setData(prev => {
              if (!prev) return prev;
              const existing = prev.caseResults.find(c => c.caseId === ev.caseId);
              const row = { caseId: ev.caseId, title: existing?.title ?? null, status: ev.status, note: ev.note ?? null };
              const others = prev.caseResults.filter(c => c.caseId !== ev.caseId);
              return { ...prev, caseResults: [...others, row].sort((a, b) => a.caseId - b.caseId) };
            });
          } else if (ev.type === 'log') {
            setData(prev => (prev ? { ...prev, logs: [...prev.logs, ev.line].slice(-LOG_CAP) } : prev));
          } else if (ev.type === 'status') {
            setLiveStatus(ev.status);
          } else if (ev.type === 'done') {
            source.close();
            api<RunDetailPayload>(`/runs/${runId}`)
              .then(d => { setData(d); setLiveStatus(d.run.status); })
              .catch((err: Error) => setError(err.message));
          }
        };
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });

    return () => {
      cancelled = true;
      es?.close();
    };
  }, [runId]);

  const cancel = async () => {
    try {
      await api(`/runs/${runId}/cancel`, { method: 'POST' });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const rerunFailed = async () => {
    if (!data) return;
    try {
      const { id: newId } = await api<{ id: number }>(
        '/runs',
        jsonInit('POST', { flowIds: data.run.flow_ids, mode: 'claude', scope: 'failed' }),
      );
      navigate(`/runs/${newId}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error && !data) return <div className="banner err-banner">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;

  const running = liveStatus === 'running';
  const hasFailures = data.caseResults.some(c => c.status === 'fail' || c.status === 'error');
  const finished = !running && liveStatus !== null;

  return (
    <section>
      <p><Link to="/runs">← Runs</Link></p>
      <div className="row between">
        <div className="row">
          <h1>Run #{data.run.id}</h1>
          <Badge status={liveStatus} />
          <span className="muted">{data.run.mode} · scope {data.run.scope} · {data.run.base_url}</span>
        </div>
        <div className="row">
          {running ? <button type="button" className="danger" onClick={cancel}>Cancel</button> : null}
          {finished && data.run.mode === 'playwright' && hasFailures ? (
            <button type="button" onClick={rerunFailed}>Re-run failed with Claude</button>
          ) : null}
        </div>
      </div>

      {error ? <div className="banner err-banner">{error}</div> : null}
      {data.run.error ? <div className="banner err-banner">{data.run.error}</div> : null}

      <h2>Cases</h2>
      {data.caseResults.length === 0 ? <p className="muted">No case results yet.</p> : (
        <table>
          <thead>
            <tr><th>Case</th><th>Status</th><th>Note</th></tr>
          </thead>
          <tbody>
            {data.caseResults.map(c => (
              <tr key={c.caseId}>
                <td>{c.title ?? `C${c.caseId}`}</td>
                <td><Badge status={c.status} /></td>
                <td>{c.note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Steps</h2>
      {data.stepResults.length === 0 ? <p className="muted">No step results yet.</p> : (
        <ul className="live-steps">
          {data.stepResults.map(s => (
            <li key={s.id}>
              <Badge status={s.status} /> {s.text}
              {s.observed ? <div className="muted">observed: {s.observed}</div> : null}
              {s.note ? <div className="muted">note: {s.note}</div> : null}
            </li>
          ))}
        </ul>
      )}

      <h2>
        <button type="button" className="link" onClick={() => setShowLog(!showLog)}>
          {showLog ? 'Hide log' : 'Show log'}
        </button>
      </h2>
      {showLog ? <pre className="log">{data.logs.join('\n')}</pre> : null}
    </section>
  );
}
