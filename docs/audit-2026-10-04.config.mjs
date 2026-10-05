import { fileURLToPath } from 'node:url';
export default {
  root: fileURLToPath(new URL('../', import.meta.url)),
  test: {
    include: ['docs/audit-2026-10-04.probes.test.js'],
    environment: 'jsdom',
    setupFiles: ['./tests/setup.js'],
    pool: 'threads'
  }
};
