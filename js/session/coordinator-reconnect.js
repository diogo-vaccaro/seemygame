/** Own one bounded coordinator reconnect attempt at a time, including silence. */
export function createCoordinatorReconnect(session, { roomManager, getConnection, connect, onConnected = () => {} }) {
  let retryTimer = null, openTimer = null, pending = null, attempts = 0;
  const maxAttempts = 15;
  const isLive = () => !session.isDisposed && roomManager.isInRoom && !roomManager.isMaster;
  const clearAttempt = () => {
    clearTimeout(openTimer); openTimer = null; pending = null;
  };
  const schedule = () => {
    if (!isLive() || retryTimer !== null || pending || getConnection()?.open || attempts >= maxAttempts) return;
    retryTimer = setTimeout(attempt, attempts ? Math.min(1000 + 500 * attempts, 4000) : 1000);
  };
  const attempt = () => {
    retryTimer = null;
    if (!isLive() || getConnection()?.open) return;
    attempts++;
    console.log(`[Room] Tentando reconectar ao Coordenador Master (${attempts}/${maxAttempts})...`);
    const conn = connect();
    if (!conn) { schedule(); return; }
    pending = conn;
    const failed = () => {
      if (pending !== conn) return;
      clearAttempt();
      // Closing can synchronously call schedule through the Room lifecycle;
      // the shared guards prevent duplicate timers or overlapping attempts.
      try { conn.close(); } catch (_) {}
      schedule();
    };
    openTimer = setTimeout(failed, 5000);
    conn.on('open', () => {
      if (pending !== conn || !isLive()) return;
      clearAttempt(); attempts = 0;
      console.log('[Room] Reconectado com sucesso ao Coordenador Master!');
      onConnected(conn);
    });
    conn.on('error', failed);
    conn.on('close', failed);
  };
  session.registerCleanup(() => {
    clearTimeout(retryTimer); retryTimer = null;
    const conn = pending; clearAttempt();
    try { conn?.close(); } catch (_) {}
  });
  return schedule;
}
