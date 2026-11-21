import { build } from 'esbuild';
import { chmod, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  logLevel: 'info',
});

await chmod('dist/cli.js', 0o755);
