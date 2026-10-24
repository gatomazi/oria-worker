// npm run dev: build + servidores locais (Node) + Worker local (wrangler dev).
import { spawn } from 'node:child_process';

const children = [];
function run(label, cmd, args, env = {}) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const prefix = (chunk) => chunk.toString().split('\n').filter(Boolean).map((l) => `[${label}] ${l}`).join('\n') + '\n';
  child.stdout.on('data', (c) => process.stdout.write(prefix(c)));
  child.stderr.on('data', (c) => process.stderr.write(prefix(c)));
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`[dev] ${label} saiu (código ${code}); encerrando.`);
      stop(code ?? 1);
    }
  });
  children.push(child);
  return child;
}

let stopping = false;
function stop(code = 0) {
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500).unref();
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

await new Promise((resolve, reject) =>
  spawn(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' }).on('exit', (c) => (c === 0 ? resolve() : reject(new Error('build falhou')))),
);
run('node', process.execPath, ['src/platform/main.ts']);
run('worker', 'npx', ['wrangler', 'dev', '--log-level', 'warn'], { WRANGLER_SEND_METRICS: 'false' });
console.log(`
[dev] Pronto em alguns segundos:
  Painel:              http://127.0.0.1:4000/
  Lojas (via Worker):  http://<loja>.localhost:8787/<caminho>  (lista abaixo, linhas [local])
  Primeiro acesso:     link de convite impresso abaixo (só na primeira vez)
`);
