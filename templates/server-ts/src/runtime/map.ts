// Dot-path lookup and field mapping. Mapping makes every tool return the same
// shape whatever extra fields the company API sends: unmapped fields are
// dropped, missing ones become null.

export function getPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let cur: any = value;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(part) ? cur[Number(part)] : cur[part];
  }
  return cur;
}

export function applyFields(record: unknown, fields: Record<string, string> | undefined): Record<string, unknown> {
  if (!fields) {
    return record && typeof record === "object" && !Array.isArray(record) ? (record as Record<string, unknown>) : { value: record ?? null };
  }
  const out: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(fields)) {
    const v = getPath(record, path);
    out[name] = v === undefined ? null : v;
  }
  return out;
}
