import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveDesktopTestProfile, readInstanceProfileEvidence } from '../tools/e2e/harness/desktop-profile.mjs';

describe('desktop E2E profile isolation', () => {
  const root = path.resolve('test-project');
  it('keeps the fresh run profile by default', () => {
    expect(resolveDesktopTestProfile(root, null, 'fresh')).toBe('fresh');
  });
  it('allows an explicitly shared test profile', () => {
    expect(resolveDesktopTestProfile(root, 'output/playwright/shared', 'fresh'))
      .toBe(path.join(root, 'output/playwright/shared'));
  });
  it.each(['output/playwright', 'output/playwright/../../personal', '../personal', 'output/playwright-other/profile'])('rejects external or root profiles: %s', requested => {
    expect(() => resolveDesktopTestProfile(root, requested, 'fresh')).toThrow('inside output/playwright');
  });
  it('requires actual startup evidence rather than inferring isolation from the requested folder', () => {
    expect(readInstanceProfileEvidence('[123] [InstanceProfile] isolated secondary slot=2 directory=profile-instances/instance-2\r\n'))
      .toEqual({ mode: 'isolated-secondary', slot: 2, directory: 'profile-instances/instance-2' });
    expect(readInstanceProfileEvidence('[123] [InstanceProfile] primary profile preserved slot=1'))
      .toEqual({ mode: 'primary', slot: 1 });
    expect(readInstanceProfileEvidence('capture started')).toBeNull();
  });
});
