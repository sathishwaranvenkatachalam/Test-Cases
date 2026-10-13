import { useEffect, useRef, useState } from 'react';
import { api, jsonInit, type Settings } from '../api';

type Key = keyof Settings;

export default function BaseUrlBar() {
  const [values, setValues] = useState<Settings | null>(null);
  const [savedKey, setSavedKey] = useState<Key | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    api<Settings>('/settings')
      .then(setValues)
      .catch((e: Error) => setError(e.message));
    return () => window.clearTimeout(timer.current);
  }, []);

  if (!values) return <div className="baseurl">{error ? <span className="err">{error}</span> : null}</div>;

  const set = (key: Key, value: string) => setValues({ ...values, [key]: value });

  const save = async (key: Key) => {
    try {
      const next = await api<Settings>('/settings', jsonInit('PUT', { [key]: values[key] }));
      setValues(next);
      setError(null);
      setSavedKey(key);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setSavedKey(null), 1500);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const field = (key: Key, label: string, placeholder?: string) => (
    <label className="field">
      <span>{label}</span>
      <input
        type="text"
        value={values[key]}
        placeholder={placeholder}
        onChange={e => set(key, e.target.value)}
        onBlur={() => save(key)}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
      {savedKey === key ? <small className="saved">saved ✓</small> : null}
    </label>
  );

  return (
    <div className="baseurl">
      {field('baseUrl', 'Target Base URL', 'https://app.example.test')}
      <button type="button" className="link" onClick={() => setOpen(!open)}>
        {open ? 'Hide advanced' : 'Advanced'}
      </button>
      {open ? (
        <div className="advanced">
          {field('cdpUrl', 'CDP URL', 'http://localhost:9222')}
          {field('claudeModel', 'Claude model', 'sonnet')}
          {field('claudeRunArgs', 'Claude run args')}
        </div>
      ) : null}
      {error ? <span className="err">{error}</span> : null}
    </div>
  );
}
