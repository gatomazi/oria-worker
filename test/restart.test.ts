// Reinício real: processo morto com SIGKILL e iniciado de novo; tudo continua.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers.ts';

async function start(env: Record<string, string>): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['src/platform/main.ts'], { env: { ...process.env, ...env, START_ORIGINS: '0' }, stdio: 'pipe' });
  await new Promise<void>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (c) => {
      out += c;
      if (out.includes('[local] painel')) resolve();
    });
    child.on('exit', (code) => reject(new Error(`saiu (${code}): ${out}`)));
  });
  return child;
}
const kill = async (c: ChildProcess) => {
  const done = new Promise((r) => c.once('exit', r));
  c.kill('SIGKILL');
  await done;
};

test('reiniciar preserva lojas, rascunho, publicação e acessos', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pink-restart-'));
  const [ap, pp] = [await freePort(), await freePort()];
  const env = { DATA_DIR: dir, ADMIN_PORT: String(ap), PUBLIC_PORT: String(pp), OPERATOR_EMAIL: 'op@exemplo.com', OPERATOR_PASSWORD: 'senha-do-operador' };
  const A = `http://127.0.0.1:${ap}`;
  let child = await start(env);
  try {
    const login = await fetch(`${A}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: A }, body: JSON.stringify({ email: 'op@exemplo.com', password: 'senha-do-operador' }) });
    const { csrf } = (await login.json()) as { csrf: string };
    const h = { 'content-type': 'application/json', origin: A, cookie: login.headers.get('set-cookie')!.split(';')[0]!, 'x-csrf-token': csrf };
    const v = (await (await fetch(`${A}/api/stores/demo-aurora`, { headers: h })).json()) as any;
    const cfg = v.draft.config;
    cfg.modules.share.enabled = true;
    const saved = (await (await fetch(`${A}/api/stores/demo-aurora/draft`, { method: 'PUT', headers: h, body: JSON.stringify({ config: cfg, expectedUpdatedAt: v.draft.updatedAt }) })).json()) as any;
    assert.equal((await fetch(`${A}/api/stores/demo-aurora/publish`, { method: 'POST', headers: h, body: JSON.stringify({ expectedDraftUpdatedAt: saved.draft.updatedAt }) })).status, 200);
  } finally {
    await kill(child);
  }
  child = await start(env);
  try {
    const cfg = (await (await fetch(`http://127.0.0.1:${pp}/api/v1/stores/demo-aurora/config`)).json()) as any;
    assert.equal(cfg.version, 1);
    assert.ok(cfg.modules.share);
    const login = await fetch(`${A}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: A }, body: JSON.stringify({ email: 'op@exemplo.com', password: 'senha-do-operador' }) });
    assert.equal(login.status, 200, 'acesso continua');
  } finally {
    await kill(child);
    rmSync(dir, { recursive: true, force: true });
  }
});
