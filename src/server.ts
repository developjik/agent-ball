import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { Board } from './core/board';

export interface ServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly loadBoard: () => Promise<Board>;
  /** Directory holding the built dashboard (`dist/web`). Null serves the API only. */
  readonly staticDir?: string | null;
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * A small dashboard server: the built UI plus one JSON endpoint. It reads the
 * board per request, so a refresh always shows the current ball positions.
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const staticDir = options.staticDir ? resolve(options.staticDir) : null;
  const server = createServer((request, response) => {
    handle(request, response, options, staticDir).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) sendJson(response, 502, { error: message });
      else response.end();
    });
  });

  await new Promise<void>((ready, failed) => {
    const onError = (error: Error): void => failed(error);
    server.once('error', onError);
    server.listen(options.port ?? 4747, host, () => {
      server.off('error', onError);
      ready();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port ?? 4747;
  return {
    url: `http://${host}:${port}`,
    port,
    close: () =>
      new Promise<void>((done, failed) => {
        server.close((error) => (error ? failed(error) : done()));
      }),
  };
}

async function handle(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
  options: ServerOptions,
  staticDir: string | null,
): Promise<void> {
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    sendJson(response, 405, { error: 'method not allowed' });
    return;
  }

  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/healthz') {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/board') {
    const board = await options.loadBoard();
    sendJson(response, 200, board);
    return;
  }

  if (!staticDir) {
    sendHtml(response, 200, placeholderPage());
    return;
  }

  const file = await resolveStatic(staticDir, url.pathname);
  if (!file) {
    sendHtml(response, 404, '<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not found.');
    return;
  }
  const body = await readFile(file);
  const type = CONTENT_TYPES[extname(file)] ?? 'application/octet-stream';
  response.writeHead(200, {
    'Content-Type': type,
    'Content-Length': String(body.byteLength),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (method === 'HEAD') response.end();
  else response.end(body);
}

async function resolveStatic(root: string, pathname: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const candidate = resolve(join(root, relative));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  if (await isFile(candidate)) return candidate;
  // A client-side route falls back to the app shell.
  const shell = join(root, 'index.html');
  return (await isFile(shell)) ? shell : null;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function sendJson(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload)),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(payload);
}

function sendHtml(response: import('node:http').ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(html)),
    'Cache-Control': 'no-store',
  });
  response.end(html);
}

function placeholderPage(): string {
  return [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<title>agent-ball</title>',
    '<style>body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:38rem;margin:12vh auto;padding:0 1.5rem;color:#14130f;background:#f4f1ea}code{background:#e8e3d6;padding:.1em .35em;border-radius:3px}</style>',
    '<h1>agent-ball</h1>',
    '<p>The API is live at <a href="/api/board"><code>/api/board</code></a>.',
    ' The dashboard has not been built yet: run <code>pnpm build:web</code>, or use <code>pnpm dev</code> for the Vite dev server.</p>',
  ].join('\n');
}
