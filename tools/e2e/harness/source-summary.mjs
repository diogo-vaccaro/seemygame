/** Serializable Playwright callback: read only small counters during the measurement.
 * Read/save the complete frame log once at the end, for optical provenance.
 */
export function readSourceStatsSummary(stats = globalThis.window?.__smgSourceStats) {
  if (!stats) return null;
  return {
    framesProduced: stats.framesProduced,
    fps: stats.fps,
    rafFps: stats.rafFps,
    rafTicks: stats.rafTicks,
    lastTime: stats.lastTime,
    sessionMagic: stats.sessionMagic,
    width: stats.width,
    height: stats.height,
    frameLogLength: stats.frameLog?.length ?? 0,
    workload: stats.workload ? {...stats.workload} : null
  };
}
