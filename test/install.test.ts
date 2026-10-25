import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installArtifacts, installStatus, zoneOf } from '../src/platform/install.ts';
import { stack, VISTA, IDENTITY } from './helpers.ts';

test('artefatos de instalação: rota <domínio>/* (cobre /__pink/*), ADMIN_ORIGIN, sem KV nem PINK_STORE_DOMAIN', () => {
  const s = stack();
  try {
    const store = s.stores.createStore({ ...VISTA, packages: ['vitrine'] }, IDENTITY, null);
    const files = installArtifacts(store, s.stores.view(store.id), {
      workerPort: 8787,
      publicPort: 4001,
      publicOrigin: 'https://api.oria.exemplo',
      panelOrigin: 'https://painel.oria.exemplo',
      hosted: true,
      stores: s.stores,
      auth: s.auth,
    });
    assert.deepEqual(files.map((f) => f.name), [`instalacao-${store.id}.md`, 'wrangler.oria.toml', `verificacao-${store.id}.sh`]);
    const toml = files[1]!.content;
    assert.match(toml, /# \{ pattern = "www\.vistaentrenos\.com\.br\/\*", zone_name = "vistaentrenos\.com\.br" \}/, 'rota do domínio inteiro, comentada até aprovar');
    assert.match(toml, /CONFIG_SERVICE_URL = "https:\/\/api\.oria\.exemplo"/);
    assert.match(toml, /ADMIN_ORIGIN = "https:\/\/painel\.oria\.exemplo"/);
    assert.match(toml, /\[env\.teste\.vars\][\s\S]*ORIGIN_MODE = "dev-origin"/);
    assert.doesNotMatch(toml, /PINK_STORE_DOMAIN|kv_namespaces/);
    assert.doesNotMatch(files.map((f) => f.content).join('\n'), /\bKV\b/);
    assert.match(files[0]!.content, /preparado para instalação; validação remota pendente/);
    assert.match(files[2]!.content, /__pink\/client\/loader\.js/);
    assert.equal(zoneOf('www.loja.com.br'), 'loja.com.br');
    assert.equal(zoneOf('loja.example.com'), 'example.com');
  } finally {
    s.close();
  }
});

test('wrangler.oria.toml gerado é aceito pelo wrangler (deploy --dry-run, produção e teste)', { timeout: 120_000 }, () => {
  const s = stack();
  const out = mkdtempSync(join(tmpdir(), 'oria-dry-'));
  const file = 'wrangler.oria.teste-gerado.toml';
  try {
    const store = s.stores.createStore({ ...VISTA, packages: ['vitrine'] }, IDENTITY, null);
    const toml = installArtifacts(store, s.stores.view(store.id), { workerPort: 8787, publicPort: 4001, publicOrigin: 'https://api.oria.exemplo', panelOrigin: 'https://painel.oria.exemplo', hosted: true, stores: s.stores, auth: s.auth })[1]!.content;
    writeFileSync(file, toml);
    for (const env of [[], ['--env', 'teste']]) {
      const log = execFileSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', out, '-c', file, ...env], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
      assert.match(log, /--dry-run: exiting now/);
    }
    assert.ok(readFileSync(join(out, 'index.js'), 'utf8').length > 1000, 'Worker empacotado');
  } finally {
    rmSync(file, { force: true });
    rmSync(out, { recursive: true, force: true });
    s.close();
  }
});

test('estado da instalação: teste local não conta como instalado; domínio só "ok" com o carregador na página pública', async () => {
  const s = stack();
  try {
    const store = s.stores.createStore({ ...VISTA, packages: ['vitrine'] }, IDENTITY, null);
    const base = { workerPort: 8787, publicPort: 4001, stores: s.stores, auth: s.auth, probe: async () => ({ status: 200, body: '<script data-pink-loader="3"></script>' }) };
    let checks = await installStatus(store, s.stores.view(store.id), { ...base, remote: async () => ({ status: 200, body: '<html>loja</html>' }) });
    assert.equal(checks.find((c) => c.id === 'teste')!.label, 'Teste local pelo proxy (não é instalação)');
    const prod = checks.find((c) => c.id === 'producao')!;
    assert.equal(prod.state, 'pending');
    assert.match(prod.detail, /validação remota pendente/);
    checks = await installStatus(store, s.stores.view(store.id), { ...base, remote: async () => ({ status: 200, body: '<script data-pink-loader="3"></script>' }) });
    assert.equal(checks.find((c) => c.id === 'producao')!.state, 'ok');
    checks = await installStatus(store, s.stores.view(store.id), { ...base, remote: async () => Promise.reject(new Error('sem rede')) });
    assert.match(checks.find((c) => c.id === 'producao')!.detail, /validação remota pendente/);
  } finally {
    s.close();
  }
});
