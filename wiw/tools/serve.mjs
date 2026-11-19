import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {extname, resolve, sep} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {relayArchive} from '../archive_gateway.mjs';

const root = fileURLToPath(new URL('../dist', import.meta.url));
const host = process.env.WILLITWASM_HOST || '127.0.0.1';
const port = Number(process.env.WILLITWASM_PORT || 8327);
const mime = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript',
  '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
}));

createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {response.writeHead(405).end();return;}
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/wiw') {
      response.writeHead(302, {Location:'/wiw/' + url.search}).end();
      return;
    }
    if (['/api/archive', '/wiw/api/archive'].includes(url.pathname)) {
      const controller = new AbortController();
      response.on('close', () => controller.abort());
      const result = await relayArchive(new Request(url, {method:request.method, headers:request.headers,
        signal:AbortSignal.any([controller.signal, AbortSignal.timeout(90000)])}));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) await pipeline(Readable.fromWeb(result.body), response);
      else response.end();
      return;
    }
    const path = url.pathname.replace(/^\/wiw(?=\/|$)/, '') || '/';
    const file = resolve(root, '.' + decodeURIComponent(path === '/' ? '/index.html' : path));
    if (!file.startsWith(root + sep)) {response.writeHead(404).end();return;}
    const info = await stat(file);
    if (!info.isFile()) {response.writeHead(404).end();return;}
    const cache = /\/(?:alpine|compiler|projects|clang-seed|binaryen|web-plans)\//.test(url.pathname) && /\.(bin|wasm)$/.test(url.pathname);
    response.writeHead(200, {'Content-Type': mime.get(extname(file)) || 'application/octet-stream',
      'Content-Length': info.size, 'Cache-Control': cache ? 'public, max-age=86400' : 'no-cache'});
    if (request.method === 'HEAD') response.end();
    else await pipeline(createReadStream(file), response);
  } catch (error) {
    if (!response.headersSent) response.writeHead(error.code === 'ENOENT' ? 404 : 502).end(
      error.code === 'ENOENT' ? 'File not found. Stage the local build inputs first.' : 'Request failed.');
    else response.destroy();
  }
}).listen(port, host, () => console.log(`Will it Wasm? http://${host}:${port}`));
