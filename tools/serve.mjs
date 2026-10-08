import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json'
};

const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_PAGES = new Set(['index.html', 'lobby.html', 'room.html', 'streamer.html', 'viewer.html', 'test-audio.html']);
const PUBLIC_DIRECTORIES = new Set(['css', 'js']);

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let pathname;
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    // Windows treats backslashes as path separators too. Validate the same
    // representation that will be resolved by the filesystem below.
    pathname = decodeURIComponent(url.pathname).replace(/\\/g, '/');
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request: Invalid URI');
    return;
  }

  if (pathname === '/api/rooms') {
    try {
      const { default: roomsHandler } = await import('../api/rooms.js');
      await roomsHandler(req, res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname === '/api/turn') {
    try {
      const { default: turnHandler } = await import('../api/turn.js');
      await turnHandler(req, res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname === '/') pathname = '/index.html';

  // Bloqueia acesso a arquivos e pastas ocultos (.git, .env, etc.)
  if (pathname.includes('\0') || pathname.includes(':') || pathname.split('/').some(segment => segment.startsWith('.'))) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Acesso negado');
    return;
  }

  const filePath = path.normalize(path.join(root, pathname));
  const relative = path.relative(root, filePath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Acesso negado');
    return;
  }

  // Match the web assets shipped by build-dist; never expose the rest of the
  // checkout (native sources, test fixtures, reports or package metadata).
  const segments = relative.split(path.sep);
  if (!(segments.length === 1 && PUBLIC_PAGES.has(segments[0].toLowerCase())) &&
      !PUBLIC_DIRECTORIES.has(segments[0].toLowerCase())) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Acesso negado');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Arquivo não encontrado: ' + pathname);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[SeeMyGame Local Web] Servidor rodando em: http://${HOST}:${PORT}/room.html`);
});
