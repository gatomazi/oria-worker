import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import { createAdminServer } from '../src/platform/admin-server.ts';
import { createPublicServer } from '../src/platform/public-server.ts';
import { stack, freePort, listen, type Stack } from './helpers.ts';
import { previewToken } from '../src/platform/tokens.ts';

let s: Stack;
let admin: Server;
let pub: Server;
let A = '';
let P = '';

before(async () => {
  s = stack();
  s.auth.createUser({ email: 'op@exemplo.com', name: 'Operador', role: 'operator', storeId: null, password: 'senha-do-operador' });
  s.auth.createUser({ email: 'aurora@exemplo.com', name: 'Lojista Aurora', role: 'merchant', storeId: 'demo-aurora', password: 'senha-da-aurora' });
  const port = await freePort();
  A = `http://127.0.0.1:${port}`;
  admin = createAdminServer({
    auth: s.auth,
    stores: s.stores,
    media: s.media,
    catalog: s.catalog,
    secret: s.secret,
    panelOrigin: `http://127.0.0.1:${port}`,
    mailer: s.mailer,
    storeUrl: (x) => `http://${x.devHost}:8787${x.basePath}`,
    install: { workerPort: 8787, publicPort: 4001, stores: s.stores, auth: s.auth, probe: async () => ({ status: 200, body: '<html></html>' }), remote: async () => ({ status: 200, body: '<html></html>' }) },
    integration: s.integration,
  });
  await listen(admin, port);
  pub = createPublicServer({ stores: s.stores, media: s.media, secret: s.secret, assistant: s.assistant });
  P = `http://127.0.0.1:${await listen(pub)}`;
});

after(() => {
  admin.close();
  pub.close();
  s.close();
});

interface Session {
  cookie: string;
  csrf: string;
}

async function login(email: string, password: string): Promise<Session> {
  const res = await fetch(`${A}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: A }, body: JSON.stringify({ email, password }) });
  assert.equal(res.status, 200, `login ${email}`);
  const body = (await res.json()) as { csrf: string };
  return { cookie: res.headers.get('set-cookie')!.split(';')[0]!, csrf: body.csrf };
}

function call(sess: Session | null, method: string, path: string, json?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { origin: A, ...extra };
  if (sess) {
    headers.cookie = sess.cookie;
    if (method !== 'GET') headers['x-csrf-token'] = sess.csrf;
  }
  if (json !== undefined) headers['content-type'] = 'application/json';
  return fetch(A + path, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined });
}

test('sem sessão: 401; senha errada: 401', async () => {
  assert.equal((await call(null, 'GET', '/api/stores')).status, 401);
  const r = await fetch(`${A}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: A }, body: JSON.stringify({ email: 'op@exemplo.com', password: 'errada-errada' }) });
  assert.equal(r.status, 401);
});

test('lojista só alcança a própria loja, em todas as rotas por loja', async () => {
  const m = await login('aurora@exemplo.com', 'senha-da-aurora');
  const list = (await (await call(m, 'GET', '/api/stores')).json()) as { stores: { id: string }[] };
  assert.deepEqual(list.stores.map((x) => x.id), ['demo-aurora']);
  const own = (await (await call(m, 'GET', '/api/stores/demo-aurora')).json()) as { store: Record<string, unknown> };
  assert.equal(own.store.integration, undefined, 'lojista não vê integração técnica');

  const routes: [string, string, unknown?][] = [
    ['GET', '/api/stores/demo-trilha'],
    ['PUT', '/api/stores/demo-trilha/draft', { config: {} }],
    ['POST', '/api/stores/demo-trilha/publish', {}],
    ['POST', '/api/stores/demo-trilha/restore', { version: 1 }],
    ['POST', '/api/stores/demo-trilha/modules/coupons/state', { enabled: false }],
    ['POST', '/api/stores/demo-trilha/preview-token', {}],
    ['GET', '/api/stores/demo-trilha/catalog/sections'],
    ['GET', '/api/stores/demo-trilha/install'],
    ['GET', '/api/stores/demo-trilha/users'],
    ['GET', '/api/stores/demo-trilha/integration'],
    ['POST', '/api/stores/demo-trilha/integration/sync', {}],
    ['PUT', '/api/stores/demo-trilha/integration/ink-token', { token: 'x'.repeat(30) }],
    ['POST', '/api/stores/demo-trilha/integration/ink-test', {}],
  ];
  for (const [method, path, body] of routes) {
    assert.equal((await call(m, method, path, body)).status, 404, `${method} ${path}`);
  }
  const media = await fetch(`${A}/api/stores/demo-trilha/media`, { method: 'POST', headers: { origin: A, cookie: m.cookie, 'x-csrf-token': m.csrf, 'content-type': 'image/png' }, body: Buffer.from('x') });
  assert.equal(media.status, 404, 'upload em outra loja');
});

test('lojista não altera integração, liberação, pacotes, acessos nem cria loja', async () => {
  const m = await login('aurora@exemplo.com', 'senha-da-aurora');
  assert.equal((await call(m, 'PUT', '/api/stores/demo-aurora', { name: 'X', packages: ['conteudo'] })).status, 403);
  assert.equal((await call(m, 'POST', '/api/stores', { store: {} })).status, 403);
  assert.equal((await call(m, 'POST', '/api/packages', { id: 'x' })).status, 403);
  assert.equal((await call(m, 'GET', '/api/stores/demo-aurora/users')).status, 403);
  assert.equal((await call(m, 'POST', '/api/stores/demo-aurora/users', { name: 'X', email: 'x@x.com' })).status, 403);
  assert.equal((await call(m, 'GET', '/api/stores/demo-aurora/install')).status, 403);
  // mas pode publicar a própria loja
  const v = (await (await call(m, 'GET', '/api/stores/demo-aurora')).json()) as { draft: { config: unknown; updatedAt: string } };
  const saved = await call(m, 'PUT', '/api/stores/demo-aurora/draft', { config: v.draft.config, expectedUpdatedAt: v.draft.updatedAt });
  assert.equal(saved.status, 200);
  const draftAt = ((await saved.json()) as { draft: { updatedAt: string } }).draft.updatedAt;
  const published = await call(m, 'POST', '/api/stores/demo-aurora/publish', { expectedDraftUpdatedAt: draftAt });
  assert.equal(published.status, 200);
  const target = 'share';
  assert.equal((await call(m, 'POST', `/api/stores/demo-aurora/modules/${target}/state`, { enabled: true })).status, 200, 'liga sem o operador');
  const toggled = await call(m, 'POST', `/api/stores/demo-aurora/modules/${target}/state`, { enabled: false });
  assert.equal(toggled.status, 200, 'desliga sem o operador');
  // Nenhuma resposta de escrita devolve integração, notas internas ou origem técnica ao lojista.
  for (const body of [await published.json(), await toggled.json()] as { store: Record<string, unknown> }[]) {
    for (const k of ['integration', 'notes', 'devOrigin', 'devHost', 'extraModules']) assert.equal(body.store[k], undefined, k);
  }
  const back = (await (await call(m, 'GET', '/api/stores/demo-aurora')).json()) as { published: { config: { modules: Record<string, { enabled: boolean }> } } };
  assert.equal(back.published.config.modules[target]!.enabled, false, 'publicado na hora');
});

test('CSRF, Origin e Host', async () => {
  const op = await login('op@exemplo.com', 'senha-do-operador');
  const noCsrf = await fetch(`${A}/api/packages`, { method: 'POST', headers: { origin: A, cookie: op.cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noCsrf.status, 403);
  const evil = await fetch(`${A}/api/packages`, { method: 'POST', headers: { origin: 'http://evil.example', cookie: op.cookie, 'x-csrf-token': op.csrf, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(evil.status, 403);
  const port = new URL(A).port;
  const status = await new Promise<number>((resolve, reject) =>
    request({ host: '127.0.0.1', port, path: '/api/stores', headers: { host: `evil.example:${port}`, cookie: op.cookie } }, (r) => resolve(r.statusCode ?? 0)).on('error', reject).end(),
  );
  assert.equal(status, 421);
});

test('operador cria loja pelo painel, gera convite; lojista define senha e entra só nela', async () => {
  const op = await login('op@exemplo.com', 'senha-do-operador');
  const created = await call(op, 'POST', '/api/stores', {
    store: { id: 'terceira-loja', name: 'Terceira Loja', domain: 'www.terceira.com.br', basePath: '/terceira', ownerEmail: 'dono@terceira.com.br', packages: ['vitrine'] },
    identity: { logoUrl: '', primary: '#123456', accent: '#B45309', surface: '#FFFFFF', text: '#111111', font: 'sans', style: 'reto' },
  });
  assert.equal(created.status, 201);
  const inv = (await (await call(op, 'POST', '/api/stores/terceira-loja/users', { name: 'Dono', email: 'dono@terceira.com.br' })).json()) as { inviteUrl: string };
  const token = inv.inviteUrl.split('/convite/')[1]!;
  assert.equal((await fetch(`${A}/api/invites/${token}`)).status, 200);
  const weak = await fetch(`${A}/api/invites/${token}`, { method: 'POST', headers: { origin: A, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'curta' }) });
  assert.equal(weak.status, 422);
  const ok = await fetch(`${A}/api/invites/${token}`, { method: 'POST', headers: { origin: A, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'senha-longa-do-dono' }) });
  assert.equal(ok.status, 200);
  const reuse = await fetch(`${A}/api/invites/${token}`, { method: 'POST', headers: { origin: A, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'outra-senha-longa' }) });
  assert.equal(reuse.status, 404, 'convite é de uso único');
  const dono = await login('dono@terceira.com.br', 'senha-longa-do-dono');
  const list = (await (await call(dono, 'GET', '/api/stores')).json()) as { stores: { id: string }[] };
  assert.deepEqual(list.stores.map((x) => x.id), ['terceira-loja']);
  const install = (await (await call(op, 'GET', '/api/stores/terceira-loja/install')).json()) as { status: { id: string; state: string }[]; artifacts: { name: string }[] };
  assert.equal(install.status.find((c) => c.id === 'acesso')?.state, 'ok');
  assert.deepEqual(install.artifacts.map((a) => a.name), ['instalacao-terceira-loja.md', 'wrangler.oria.toml', 'verificacao-terceira-loja.sh']);
  assert.equal(install.status.find((c) => c.id === 'producao')?.state, 'pending', 'sem o carregador na página pública, não está instalado');
  const toml = await (await call(op, 'GET', '/api/stores/terceira-loja/install/wrangler.oria.toml')).text();
  assert.match(toml, /# \{ pattern = "www\.terceira\.com\.br\/\*", zone_name = "terceira\.com\.br" \}/, 'rota do domínio, comentada até aprovar');
});

test('prévia: token de uma loja não abre o rascunho de outra; sem token, nada', async () => {
  const tok = previewToken(s.secret, 'demo-aurora');
  assert.equal((await fetch(`${P}/api/v1/stores/demo-aurora/preview-config?token=${tok}`)).status, 200);
  assert.equal((await fetch(`${P}/api/v1/stores/demo-trilha/preview-config?token=${tok}`)).status, 403);
  assert.equal((await fetch(`${P}/api/v1/stores/demo-aurora/preview-config`)).status, 403);
  const expired = previewToken(s.secret, 'demo-aurora', Date.now() - 3600_000);
  assert.equal((await fetch(`${P}/api/v1/stores/demo-aurora/preview-config?token=${expired}`)).status, 403);
});

test('mídia: tipo controlado, servida com Range', async () => {
  const op = await login('op@exemplo.com', 'senha-do-operador');
  const bad = await fetch(`${A}/api/stores/demo-trilha/media`, { method: 'POST', headers: { origin: A, cookie: op.cookie, 'x-csrf-token': op.csrf, 'content-type': 'text/html' }, body: '<script>' });
  assert.equal(bad.status, 415);
  const body = Buffer.alloc(1000, 7);
  const up = (await (await fetch(`${A}/api/stores/demo-trilha/media`, { method: 'POST', headers: { origin: A, cookie: op.cookie, 'x-csrf-token': op.csrf, 'content-type': 'video/mp4' }, body })).json()) as { id: string; url: string };
  assert.match(up.url, /^\/__pink\/media\/[a-f0-9]{24}$/);
  const part = await fetch(`${P}/api/v1/stores/demo-trilha/media/${up.id}`, { headers: { range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 10-19/1000');
  assert.equal((await part.arrayBuffer()).byteLength, 10);
  assert.equal((await fetch(`${P}/api/v1/stores/demo-aurora/media/${up.id}`)).status, 404, 'mídia de outra loja');
});

test('ids e hosts: só o cadastro', async () => {
  for (const bad of ['..%2F..%2Fetc', 'DEMO-AURORA', 'nao-existe', '%2e%2e']) {
    assert.equal((await fetch(`${P}/api/v1/stores/${bad}/config`)).status, 404, bad);
  }
  assert.equal((await fetch(`${P}/api/v1/hosts/outra.localhost`)).status, 404);
  const h = (await (await fetch(`${P}/api/v1/hosts/demo-aurora.localhost`)).json()) as { storeId: string };
  assert.equal(h.storeId, 'demo-aurora');
});

test('integração: o lojista guarda o token da própria loja e ele nunca volta em resposta nenhuma', async () => {
  const m = await login('aurora@exemplo.com', 'senha-da-aurora');
  const token = 'tok_aurora_' + 'k'.repeat(30) + '_FIM9';
  const put = await call(m, 'PUT', '/api/stores/demo-aurora/integration/ink-token', { token });
  assert.equal(put.status, 200);
  const bodies = [await put.text(), await (await call(m, 'GET', '/api/stores/demo-aurora/integration')).text(), await (await call(m, 'GET', '/api/stores/demo-aurora')).text()];
  for (const b of bodies) assert.ok(!b.includes(token) && !b.includes('k'.repeat(30)), 'token não aparece');
  assert.match(bodies[1]!, /"hint":"FIM9"/);
  assert.equal((await call(m, 'DELETE', '/api/stores/demo-aurora/integration/ink-token')).status, 200);
});

test('configuração pública: ETag/304; publicar, desligar, restaurar, retirar liberação e pausar valem no pedido seguinte', async () => {
  const cfgOf = async (etag?: string) => {
    const r = await fetch(`${P}/api/v1/stores/demo-trilha/config`, { headers: etag ? { 'if-none-match': etag } : {} });
    return { status: r.status, etag: r.headers.get('etag') ?? '', body: r.status === 200 ? ((await r.json()) as { version: number; modules: Record<string, unknown> }) : null };
  };
  const op = await login('op@exemplo.com', 'senha-do-operador');
  // publica com o compartilhar ligado
  const v = (await (await call(op, 'GET', '/api/stores/demo-trilha')).json()) as { draft: { config: { modules: Record<string, { enabled: boolean }> }; updatedAt: string } };
  v.draft.config.modules.share!.enabled = true;
  const saved = (await (await call(op, 'PUT', '/api/stores/demo-trilha/draft', { config: v.draft.config, expectedUpdatedAt: v.draft.updatedAt })).json()) as { draft: { updatedAt: string } };
  await call(op, 'POST', '/api/stores/demo-trilha/publish', { expectedDraftUpdatedAt: saved.draft.updatedAt });
  const a = await cfgOf();
  assert.equal(a.status, 200);
  assert.ok(a.body!.modules.share);
  assert.equal((await cfgOf(a.etag)).status, 304, 'sem mudança: 304');
  // desligar na hora
  await call(op, 'POST', '/api/stores/demo-trilha/modules/share/state', { enabled: false });
  const b = await cfgOf(a.etag);
  assert.equal(b.status, 200);
  assert.equal(b.body!.modules.share, undefined);
  // restaurar a versão com o módulo ligado
  await call(op, 'POST', '/api/stores/demo-trilha/restore', { version: a.body!.version });
  const c = await cfgOf(b.etag);
  assert.ok(c.body!.modules.share);
  // retirar a liberação (pacote sem o módulo): sai da configuração entregue
  const store = (await (await call(op, 'GET', '/api/stores/demo-trilha')).json()) as { store: Record<string, unknown> };
  await call(op, 'PUT', '/api/stores/demo-trilha', { ...store.store, packages: ['conteudo'], extraModules: [] });
  const d = await cfgOf(c.etag);
  assert.equal(d.body?.modules.share, undefined, 'sem liberação, fora da loja');
  // pausar: 404 (o Worker devolve a página nativa)
  await call(op, 'PUT', '/api/stores/demo-trilha', { ...store.store, packages: ['conteudo'], extraModules: [], status: 'paused' });
  assert.equal((await cfgOf(d.etag)).status, 404);
  await call(op, 'PUT', '/api/stores/demo-trilha', { ...store.store, status: 'setup' });
});
