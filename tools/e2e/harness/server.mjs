import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.wav': 'audio/wav' };
/** Serve product assets and explicit fixtures only, from an ephemeral port. */
export async function startAssetServer({ root, fixtures = {}, port = 0 } = {}) {
  const absoluteRoot = path.resolve(root);
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname === '/api/rooms') {
        const { default: roomsHandler } = await import('../../../api/rooms.js');
        await roomsHandler(request, response);
        return;
      }
      if (pathname === '/api/turn') {
        const { default: turnHandler } = await import('../../../api/turn.js');
        await turnHandler(request, response);
        return;
      }
      if (Object.hasOwn(fixtures, pathname)) {
        response.setHeader('Content-Type', mime[path.extname(pathname)] || 'text/html');
        response.end(fixtures[pathname]);
        return;
      }
      if (!/^\/(?:index|lobby|room|streamer|viewer)\.html$|^\/(?:js|css|assets|fixtures)\/[a-zA-Z0-9_./-]+$/.test(pathname)) throw new Error('Asset not allowed');
      const filename = path.resolve(absoluteRoot, '.' + pathname);
      if (!filename.startsWith(absoluteRoot + path.sep)) throw new Error('Invalid asset path');
      response.setHeader('Content-Type', mime[path.extname(filename)] || 'application/octet-stream');
      response.end(await fs.readFile(filename));
    } catch (_) { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    server, origin: `http://127.0.0.1:${server.address().port}`,
    close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); }
  };
}
