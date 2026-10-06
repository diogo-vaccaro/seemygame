import path from 'node:path';

// Shared-profile tests must never open or alter the user's installed profile.
export function resolveDesktopTestProfile(root, requested, fallback) {
  if (!requested) return fallback;
  const resolved = path.resolve(root, requested);
  const relative = path.relative(path.join(root, 'output/playwright'), resolved);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Desktop test profile must be inside output/playwright');
  }
  return resolved;
}

export function readInstanceProfileEvidence(log) {
  for (const line of log.split(/\r?\n/)) {
    const secondary = line.match(/\[InstanceProfile\] isolated secondary slot=(\d+) directory=(.+)$/);
    if (secondary) return { mode: 'isolated-secondary', slot: Number(secondary[1]), directory: secondary[2] };
    if (line.includes('[InstanceProfile] primary profile preserved slot=1')) return { mode: 'primary', slot: 1 };
  }
  return null;
}
