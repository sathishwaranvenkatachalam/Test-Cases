import crypto from 'node:crypto';

export function normalizeKey(text: string): string { return text.toLowerCase().replace(/\s+/g, ' ').trim(); }

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export function stableStringify(v: unknown): string {
  // JSON.stringify with object keys sorted recursively; arrays keep order
  return JSON.stringify(sortKeys(v));
}

export function sha1(s: string): string { return crypto.createHash('sha1').update(s).digest('hex'); }

export function slugify(s: string): string {
  // lowercase, non [a-z0-9] -> '-', collapse, trim '-', fallback 'flow'
  const r = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return r || 'flow';
}

export function renderStep(text: string, params: Record<string, string>): string {
  // replace each {name} in text with params[name] when present. For every param key NOT present as {key} in text,
  // append ` [key=value]` to the end.
  let out = text.replace(/\{([A-Za-z0-9_]+)\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? params[name] : m);
  for (const key of Object.keys(params)) {
    if (!text.includes(`{${key}}`)) out += ` [${key}=${params[key]}]`;
  }
  return out;
}

export function caseSignature(
  title: string,
  steps: { key: string; params: Record<string, string>; expected: string | null }[],
): string {
  return sha1(stableStringify({
    title: normalizeKey(title),
    steps: steps.map(s => ({ k: s.key, p: s.params, e: s.expected ? normalizeKey(s.expected) : null })),
  }));
}
