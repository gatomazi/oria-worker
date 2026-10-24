// Gera o carregador (ESM, um arquivo por módulo), o painel e o Worker para testes.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
const common = { bundle: true, legalComments: 'none', logLevel: 'warning' };

await Promise.all([
  // Carregador + módulos: import dinâmico vira arquivo separado (só baixa o que a página usa).
  build({
    ...common,
    entryPoints: { loader: 'src/client/loader.ts' },
    outdir: 'dist/client',
    format: 'esm',
    splitting: true,
    target: 'es2020',
    minify: true,
    chunkNames: 'm/[name]-[hash]',
  }),
  build({ ...common, entryPoints: ['src/panel/panel.ts'], outfile: 'dist/panel/panel.js', format: 'iife', target: 'es2020' }),
  // Para os testes em jsdom: o mesmo carregador num arquivo só (imports dinâmicos embutidos).
  build({ ...common, entryPoints: ['src/client/loader.ts'], outfile: 'dist/test/loader.iife.js', format: 'iife', target: 'es2020' }),
  // Mesmo código que o wrangler empacota; usado pelos testes com Miniflare (workerd).
  build({ ...common, entryPoints: ['src/worker/index.ts'], outfile: 'dist/worker.js', format: 'esm', target: 'es2022' }),
]);
console.log('[build] dist/client (carregador + módulos), dist/panel/panel.js, dist/worker.js');
