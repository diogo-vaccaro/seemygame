/** Preferences are optional: blocked storage must not interrupt live sessions. */
export function readPreference(key) {
  try { return globalThis.localStorage?.getItem(key) ?? null; }
  catch (_) { return null; }
}
