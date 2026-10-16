export function scrub(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => scrub(item, key));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([name]) => !/authorization|api.?key|secret|^(reasoning|reasoning_content)$/i.test(name))
        .map(([name, item]) => [name, scrub(item, key)]),
    );
  return typeof value === 'string' && key ? value.split(key).join('[REDACTED]') : value;
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
export async function wireHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
