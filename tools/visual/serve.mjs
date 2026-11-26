#!/usr/bin/env node
// Serve a folder over HTTP on this machine only, for looking at the progress gallery or a build
// in a browser while work goes on.
//
//   node tools/visual/serve.mjs [folder] [port]      (defaults: artifacts/gallery, 4190)

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const folder = resolve(process.argv[2] ?? join(root, 'artifacts', 'gallery'));
const port = Number(process.argv[3] ?? 4190);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

createServer((req, res) => {
  let file = normalize(join(folder, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!file.startsWith(folder)) return void res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('Nothing here yet.');
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`serving ${folder} at http://127.0.0.1:${port}/`);
});
