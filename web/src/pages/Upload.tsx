import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ColumnMapping } from '../../../shared/types';
import {
  api, jsonInit, type CommitResult, type IngestPayloadView, type ParseResponse, type ParsedSheetView,
} from '../api';
import Badge from '../components/Badge';

type Step = 'upload' | 'map' | 'preview' | 'done';

const FIELDS: { key: Exclude<keyof ColumnMapping, 'mode'>; label: string }[] = [
  { key: 'caseId', label: 'Case ID' },
  { key: 'title', label: 'Title' },
  { key: 'flow', label: 'Flow' },
  { key: 'steps', label: 'Steps' },
  { key: 'expected', label: 'Expected' },
  { key: 'stepNo', label: 'Step number' },
];

export default function Upload() {
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  const [sheetName, setSheetName] = useState<string>('');
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);

  const [preview, setPreview] = useState<IngestPayloadView | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);

  const sheet: ParsedSheetView | undefined = parsed?.sheets.find(s => s.name === sheetName);

  const reset = () => {
    setStep('upload'); setFile(null); setError(null); setBusy(null);
    setParsed(null); setSheetName(''); setMapping(null); setPreview(null); setResult(null);
  };

  const upload = async () => {
    if (!file) return;
    setError(null);
    setBusy('Uploading…');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api<ParseResponse>('/ingest/parse', { method: 'POST', body: fd });
      if (res.sheets.length === 0) throw new Error('no sheets with data found in this file');
      setParsed(res);
      setSheetName(res.sheets[0].name);
      setMapping(res.sheets[0].mapping);
      setStep('map');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const chooseSheet = (name: string) => {
    setSheetName(name);
    const s = parsed?.sheets.find(x => x.name === name);
    if (s) setMapping(s.mapping);
  };

  const detect = async () => {
    if (!parsed) return;
    setError(null);
    setBusy('Asking Claude to detect columns…');
    try {
      const m = await api<ColumnMapping>(`/ingest/${parsed.sessionId}/detect-mapping`, jsonInit('POST', { sheet: sheetName }));
      setMapping(m);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const analyze = async () => {
    if (!parsed || !mapping) return;
    setError(null);
    setBusy('Analyzing… this can take a minute');
    try {
      const p = await api<IngestPayloadView>(
        `/ingest/${parsed.sessionId}/preview`,
        jsonInit('POST', { sheet: sheetName, mapping }),
      );
      setPreview(p);
      setStep('preview');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const commit = async () => {
    if (!parsed) return;
    setError(null);
    setBusy('Committing…');
    try {
      const r = await api<CommitResult>(`/ingest/${parsed.sessionId}/commit`, { method: 'POST' });
      setResult(r);
      setStep('done');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <h1>Upload test cases</h1>
      <p className="muted">Step {['upload', 'map', 'preview', 'done'].indexOf(step) + 1} of 4</p>
      {error ? <div className="banner err-banner">{error}</div> : null}
      {busy ? <div className="banner">{busy}</div> : null}

      {step === 'upload' && (
        <div className="card">
          <input
            type="file"
            accept=".xlsx,.xls,.csv,.html,.htm"
            onChange={e => setFile(e.target.files?.[0] ?? null)}
          />
          <div className="row">
            <button type="button" disabled={!file || busy !== null} onClick={upload}>Upload</button>
          </div>
        </div>
      )}

      {step === 'map' && parsed && sheet && mapping && (
        <div className="card">
          {parsed.sheets.length > 1 ? (
            <label className="field">
              <span>Sheet</span>
              <select value={sheetName} onChange={e => chooseSheet(e.target.value)}>
                {parsed.sheets.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
            </label>
          ) : null}

          <label className="field">
            <span>Mode</span>
            <select value={mapping.mode} onChange={e => setMapping({ ...mapping, mode: e.target.value as ColumnMapping['mode'] })}>
              <option value="per-row-case">one row per case (steps in one cell)</option>
              <option value="per-row-step">one row per step</option>
            </select>
          </label>

          <div className="grid">
            {FIELDS.map(f => (
              <label className="field" key={f.key}>
                <span>{f.label}</span>
                <select
                  value={mapping[f.key] ?? ''}
                  onChange={e => setMapping({ ...mapping, [f.key]: e.target.value === '' ? null : e.target.value })}
                >
                  <option value="">(none)</option>
                  {sheet.headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </label>
            ))}
          </div>

          <div className="row">
            <button type="button" disabled={busy !== null} onClick={detect}>Detect with Claude</button>
            <button type="button" disabled={busy !== null} onClick={analyze}>Analyze with Claude</button>
            <button type="button" className="link" onClick={reset}>Start over</button>
          </div>

          <h3>Sample rows</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>{sheet.headers.map(h => <th key={h}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {sheet.sample.map((row, i) => (
                  <tr key={i}>{sheet.headers.map(h => <td key={h}>{row[h]}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {step === 'preview' && preview && (
        <div className="card">
          <div className="chips">
            <span className="chip">new {preview.summary.new}</span>
            <span className="chip">changed {preview.summary.changed}</span>
            <span className="chip">unchanged {preview.summary.unchanged}</span>
            <span className="chip">review needed {preview.summary.reviewNeeded}</span>
            <span className="chip">new steps {preview.summary.newSteps}</span>
            <span className="chip">reused steps {preview.summary.reusedSteps}</span>
          </div>

          <table>
            <thead>
              <tr><th>ID</th><th>Title</th><th>Flow</th><th>Status</th><th>Steps</th></tr>
            </thead>
            <tbody>
              {preview.cases.map(c => (
                <tr key={c.idx}>
                  <td>{c.externalId ?? '—'}</td>
                  <td>{c.title}</td>
                  <td>{c.flowName}</td>
                  <td><Badge status={c.status} /></td>
                  <td>
                    {c.status === 'changed' && c.before ? (
                      <div className="diff">
                        <div>
                          <div className="muted">before</div>
                          <pre>{c.before.join('\n')}</pre>
                        </div>
                        <div>
                          <div className="muted">after</div>
                          <pre>{c.after.join('\n')}</pre>
                        </div>
                      </div>
                    ) : (
                      <ol className="steps">
                        {c.after.map((t, i) => <li key={i}>{t}</li>)}
                      </ol>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="row">
            <button type="button" disabled={busy !== null} onClick={commit}>Commit</button>
            <button type="button" className="link" onClick={() => setStep('map')}>Back</button>
          </div>
        </div>
      )}

      {step === 'done' && result && (
        <div className="card">
          <h2>Imported</h2>
          <ul>
            <li>Created cases: {result.createdCases}</li>
            <li>Updated cases: {result.updatedCases}</li>
            <li>New steps: {result.newSteps}</li>
            <li>Merge reviews queued: {result.reviews}</li>
          </ul>
          <p>
            <Link to="/">View flows</Link> · <Link to="/reviews">Review merges</Link>
          </p>
          <button type="button" onClick={reset}>Upload another file</button>
        </div>
      )}
    </section>
  );
}
