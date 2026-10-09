// Serves the built web canvas (apps/web/dist) from the orchestrator's own port, so a production
// run is one process and one origin. Only GET/HEAD, only files inside the dist directory, and an
// unknown path falls back to index.html (the canvas is a single-page app).
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8',
};

/** The app shell talks only to its own origin and frames nothing but its own sandboxed previews. */
const SHELL_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
  + "font-src 'self' data:; connect-src 'self'; frame-src 'self' blob: data:; object-src 'none'; base-uri 'none'; "
  + "form-action 'none'; frame-ancestors 'none'";

export type StaticHandler = (req: IncomingMessage, res: ServerResponse) => void;

export function staticHandler(dir: string): StaticHandler | null {
  const root = path.resolve(dir);
  if (!existsSync(path.join(root, 'index.html'))) return null;
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://canvas.local').pathname); }
    catch { res.writeHead(400); res.end(); return; }
    let file = path.resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(root, 'index.html');
    const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const hashed = file.startsWith(path.join(root, 'assets') + path.sep);
    res.writeHead(200, {
      'content-type': type,
      'x-content-type-options': 'nosniff',
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(type.startsWith('text/html') ? { 'content-security-policy': SHELL_CSP, 'referrer-policy': 'no-referrer' } : {}),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  };
}
