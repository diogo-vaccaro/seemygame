import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cell = value => String(value ?? 'N/D').replace(/[|\r\n]/g, ' ');
const number = value => Number.isFinite(value) ? value.toFixed(3) : 'N/D';
export function captureConfigurationMatches(run) {
  const actual = run.conditions?.condition, priority = run.conditions?.priority, expected = run.case;
  return Boolean(actual && priority && expected && actual.captureBackend === expected.backend &&
    actual.captureMode === expected.capture && actual.rawQueue === expected.rawQueue &&
    priority.applied && priority.cpuHighApplied && priority.effectiveGpuClass === (expected.priority === 'high' ? 4 : 2));
}
/** Tables use measured conditions, never case labels or proposed settings. */
export function captureComponentTable(reports) {
  const rows = reports.flatMap(({ source = '', report }) => (report.runs || []).map(run => {
    const condition = run.conditions?.condition || {}, priority = run.conditions?.priority || {};
    return [source, run.case?.id, run.status, condition.captureBackend, condition.captureMode,
      condition.rawQueue, priority.effectiveGpuClass, `${condition.width ?? '?'}×${condition.height ?? '?'}`,
      number(run.encodedFps), number(run.metrics?.captureToEncodedMs?.p50), number(run.metrics?.captureQueueMs?.p50)].map(cell).join(' | ');
  }));
  return '# Evidências de captura e encode\n\n' +
    'Escopo: componentes, sem receptor remoto, áudio, replay, preview ou WebRTC. FPS codificado não comprova cadência visual. Rodadas não qualificadas são exploratórias. Não atribuir ganhos de fila, prioridade ou API sem comparação controlada.\n\n' +
    '| Relatório | Caso | Status | Backend | Captura | Fila real | GPU efetiva | Resolução | FPS encoded | Captura→encode p50 ms | Fila p50 ms |\n' +
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n' + rows.map(row => `| ${row} |`).join('\n') + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), index = args.indexOf('--output');
  const output = index >= 0 ? args.splice(index, 2)[1] : null;
  if (!args.length) throw new Error('Informe os report.json de componentes');
  const reports = await Promise.all(args.map(async source => ({ source, report: JSON.parse(await readFile(source, 'utf8')) })));
  const markdown = captureComponentTable(reports);
  if (output) await writeFile(output, markdown); else console.log(markdown);
}
