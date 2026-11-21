import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { demoBoard } from '../src/core';
import { startServer } from '../src/server';
import { runCli } from '../src/cli/run';

describe('dashboard server', () => {
  it('serves the board and a health check', async () => {
    const server = await startServer({ port: 0, staticDir: null, loadBoard: () => demoBoard() });
    try {
      const board = await fetch(`${server.url}/api/board`);
      expect(board.status).toBe(200);
      expect(board.headers.get('content-type')).toContain('application/json');
      expect(board.headers.get('cache-control')).toBe('no-store');
      const body = (await board.json()) as { counts: { total: number }; source: string };
      expect(body.source).toBe('demo');
      expect(body.counts.total).toBeGreaterThan(0);

      const health = await fetch(`${server.url}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
    } finally {
      await server.close();
    }
  });

  it('serves the built dashboard and falls back to the shell for app routes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-ball-web-'));
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>board</title>', 'utf8');
    await writeFile(join(dir, 'assets', 'app.js'), 'console.log("board")', 'utf8');

    const server = await startServer({ port: 0, staticDir: dir, loadBoard: () => demoBoard() });
    try {
      const index = await fetch(`${server.url}/`);
      expect(index.status).toBe(200);
      expect(index.headers.get('content-type')).toContain('text/html');
      expect(await index.text()).toContain('board');

      const asset = await fetch(`${server.url}/assets/app.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get('content-type')).toContain('javascript');

      const route = await fetch(`${server.url}/issue/12`);
      expect(route.status).toBe(200);
      expect(await route.text()).toContain('<!doctype html>');

      const traversal = await fetch(`${server.url}/..%2fpackage.json`);
      expect(traversal.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('rejects writes', async () => {
    const server = await startServer({ port: 0, staticDir: null, loadBoard: () => demoBoard() });
    try {
      const response = await fetch(`${server.url}/api/board`, { method: 'POST' });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
    } finally {
      await server.close();
    }
  });

  it('reports a board read failure as a gateway error', async () => {
    const server = await startServer({
      port: 0,
      staticDir: null,
      loadBoard: async () => {
        throw new Error('gh is not signed in');
      },
    });
    try {
      const response = await fetch(`${server.url}/api/board`);
      expect(response.status).toBe(502);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('gh is not signed in');
    } finally {
      await server.close();
    }
  });
});

describe('agent-ball serve', () => {
  it('starts on demand and answers the board endpoint', async () => {
    const out: string[] = [];
    let served: { url: string; close(): Promise<void> } | null = null;
    const code = await runCli(['serve', '--demo', '--port', '0'], {
      io: { out: (line) => out.push(line), err: (line) => out.push(line) },
      webDir: null,
      onServed: (server) => {
        served = server;
      },
    });

    expect(code).toBe(0);
    expect(out.join('\n')).toContain('agent-ball dashboard: http://127.0.0.1:');
    expect(served).not.toBeNull();
    if (!served) return;
    try {
      const response = await fetch(`${(served as { url: string }).url}/api/board`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { issues: unknown[] };
      expect(body.issues.length).toBeGreaterThan(0);
    } finally {
      await (served as { close(): Promise<void> }).close();
    }
  });
});
