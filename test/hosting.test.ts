import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import { createAdminServer } from '../src/platform/admin-server.ts';
import { ConfigError, loadConfig, testStoreUrl } from '../src/platform/config.ts';
import { R2BlobStore, signV4 } from '../src/platform/blobs.ts';
import { MediaStore } from '../src/platform/media.ts';
import { stack, freePort, listen, type Stack } from './helpers.ts';
import { ResendMailer } from '../src/platform/mailer.ts';

test('configuração hospedada: exige origens https distintas, segredo e credenciais; local continua em 127.0.0.1', () => {
  const local = loadConfig({});
  assert.equal(local.mode, 'local');
  assert.equal(local.bindHost, '127.0.0.1');
  assert.equal(local.panelOrigin, 'http://127.0.0.1:4000');
  assert.equal(testStoreUrl(local, { devHost: 'vistaentrenos.localhost', basePath: '/vistaentrenos' }), 'http://vistaentrenos.localhost:8787/vistaentrenos');

  assert.throws(() => loadConfig({ ORIA_MODE: 'hosted' }), (e: Error) => e instanceof ConfigError && /PANEL_ORIGIN/.test(e.message) && /PUBLIC_ORIGIN/.test(e.message) && /APP_SECRET/.test(e.message));
  assert.throws(() => loadConfig({ ORIA_MODE: 'hosted', PANEL_ORIGIN: 'http://painel.exemplo.com', PUBLIC_ORIGIN: 'https://api.exemplo.com', APP_SECRET: Buffer.alloc(32).toString('base64') }), /precisa ser https/);
  assert.throws(() => loadConfig({ ORIA_MODE: 'hosted', PANEL_ORIGIN: 'https://painel.exemplo.com', PUBLIC_ORIGIN: 'https://api.exemplo.com', APP_SECRET: 'abc' }), /32 bytes/);
  assert.throws(() => loadConfig({ ORIA_MODE: 'hosted', PANEL_ORIGIN: 'https://p.exemplo.com', PUBLIC_ORIGIN: 'https://a.exemplo.com', APP_SECRET: Buffer.alloc(32, 1).toString('base64'), MEDIA_BACKEND: 'r2' }), /R2_ACCOUNT_ID.*R2_BUCKET/);
  const hosted = loadConfig({
    ORIA_MODE: 'hosted',
    PANEL_ORIGIN: 'https://painel.exemplo.com/',
    PUBLIC_ORIGIN: 'https://api.exemplo.com',
    APP_SECRET: Buffer.alloc(32, 1).toString('base64'),
    PORT: '3000',
  });
  assert.equal(hosted.bindHost, '0.0.0.0');
  assert.equal(hosted.port, 3000);
  assert.equal(hosted.panelOrigin, 'https://painel.exemplo.com');
  assert.equal(hosted.seedDemo, false, 'sem lojas demo no ambiente hospedado');
  assert.equal(hosted.syncEveryMin, 60);
  assert.equal(testStoreUrl(hosted, { devHost: 'vista.teste.exemplo.com', basePath: '/vistaentrenos' }), 'https://vista.teste.exemplo.com/vistaentrenos');
});

// ---------------------------------------------------------------- acessos por e-mail

let s: Stack;
let admin: Server;
let A = '';

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
    panelOrigin: A,
    mailer: s.mailer,
    storeUrl: (x) => `http://${x.devHost}:8787${x.basePath}`,
    install: { workerPort: 8787, publicPort: 4001, stores: s.stores, auth: s.auth, probe: async () => ({ status: 200, body: '' }) },
    integration: s.integration,
  });
  await listen(admin, port);
});
after(() => {
  admin.close();
  s.close();
});

const post = (path: string, json: unknown, extra: Record<string, string> = {}) =>
  fetch(A + path, { method: 'POST', headers: { origin: A, 'content-type': 'application/json', ...extra }, body: JSON.stringify(json) });

test('esqueci a senha: mesma resposta com ou sem conta; link de 1 hora, uso único, derruba sessões; limite de pedidos', async () => {
  s.mailer.sent.length = 0;
  const yes = await post('/api/password/forgot', { email: 'Aurora@exemplo.com' }, { 'x-forwarded-for': '10.0.0.1' });
  const no = await post('/api/password/forgot', { email: 'ninguem@exemplo.com' }, { 'x-forwarded-for': '10.0.0.2' });
  assert.equal(yes.status, 200);
  assert.deepEqual(await yes.json(), await no.json(), 'não revela se a conta existe');
  assert.equal(s.mailer.sent.length, 1, 'só quem tem acesso recebe');
  const mail = s.mailer.sent[0]!;
  assert.equal(mail.to, 'aurora@exemplo.com');
  const token = /#\/senha\/([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
  assert.ok(mail.text.includes(`${A}/#/senha/`), 'link no domínio do painel');

  // sessão aberta antes cai depois da troca
  const login = await post('/api/login', { email: 'aurora@exemplo.com', password: 'senha-da-aurora' });
  const oldCookie = login.headers.get('set-cookie')!.split(';')[0]!;
  assert.equal((await fetch(`${A}/api/password/reset/${token}`)).status, 200);
  assert.equal((await post(`/api/password/reset/${token}`, { password: 'curta' })).status, 422);
  const done = await post(`/api/password/reset/${token}`, { password: 'nova-senha-da-aurora' });
  assert.equal(done.status, 200);
  assert.equal((await fetch(`${A}/api/session`, { headers: { cookie: oldCookie } })).status, 401, 'sessões anteriores encerradas');
  assert.equal((await post(`/api/password/reset/${token}`, { password: 'outra-senha-qualquer' })).status, 404, 'uso único');
  assert.equal((await post('/api/login', { email: 'aurora@exemplo.com', password: 'nova-senha-da-aurora' })).status, 200);

  // expira em 1 hora
  const u = s.auth.userByEmail('aurora@exemplo.com')!;
  const t2 = s.auth.createReset(u.id, Date.now() - 2 * 3600_000);
  assert.equal((await fetch(`${A}/api/password/reset/${t2}`)).status, 404);
  // convite não serve como redefinição e vice-versa
  const inv = s.auth.createInvite(u.id);
  assert.equal((await fetch(`${A}/api/password/reset/${inv}`)).status, 404);

  // limite: 3 pedidos por e-mail em 15 min (um já foi feito acima); os demais respondem igual, sem enviar
  s.mailer.sent.length = 0;
  for (let i = 0; i < 4; i++) assert.equal((await post('/api/password/forgot', { email: 'aurora@exemplo.com' }, { 'x-forwarded-for': `10.1.0.${i}` })).status, 200);
  assert.equal(s.mailer.sent.length, 2);
});

test('convite por e-mail com link do painel; reenviar invalida o anterior', async () => {
  const login = await post('/api/login', { email: 'op@exemplo.com', password: 'senha-do-operador' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const csrf = ((await login.json()) as { csrf: string }).csrf;
  const H = { cookie, 'x-csrf-token': csrf };
  s.mailer.sent.length = 0;
  const r = await post('/api/stores/demo-aurora/users', { name: 'Nova Pessoa', email: 'nova@exemplo.com' }, H);
  assert.equal(r.status, 201);
  const body = (await r.json()) as { user: { id: number }; inviteUrl: string; delivery: string; sent: boolean };
  assert.equal(body.delivery, 'outbox');
  assert.equal(body.sent, false, 'caixa local não conta como enviado');
  assert.equal(s.mailer.sent[0]!.to, 'nova@exemplo.com');
  assert.match(s.mailer.sent[0]!.subject, /Ateliê Aurora/);
  const first = body.inviteUrl.split('/convite/')[1]!;
  assert.ok(body.inviteUrl.startsWith(`${A}/#/convite/`));
  const again = (await (await post(`/api/stores/demo-aurora/users/${body.user.id}/invite`, {}, H)).json()) as { inviteUrl: string };
  assert.equal((await fetch(`${A}/api/invites/${first}`)).status, 404, 'convite anterior deixa de valer');
  assert.equal((await fetch(`${A}/api/invites/${again.inviteUrl.split('/convite/')[1]}`)).status, 200);
});

test('painel em https: cookie Secure; host e origem só os do painel', async () => {
  const port = await freePort();
  const srv = createAdminServer({
    auth: s.auth,
    stores: s.stores,
    media: s.media,
    catalog: s.catalog,
    secret: s.secret,
    panelOrigin: 'https://painel.exemplo.com',
    mailer: s.mailer,
    storeUrl: () => '',
    install: { workerPort: 8787, publicPort: 4001, stores: s.stores, auth: s.auth },
    integration: s.integration,
  });
  await listen(srv, port);
  // O proxy de TLS entrega o host original do pedido (fetch não deixa trocar o Host).
  const raw = (host: string, origin: string, body: string) =>
    new Promise<{ status: number; cookie: string }>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path: '/api/login', method: 'POST', headers: { host, origin, 'content-type': 'application/json' } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, cookie: String(res.headers['set-cookie'] ?? '') }));
      });
      r.on('error', reject);
      r.end(body);
    });
  try {
    const ok = await raw('painel.exemplo.com', 'https://painel.exemplo.com', JSON.stringify({ email: 'op@exemplo.com', password: 'senha-do-operador' }));
    assert.equal(ok.status, 200);
    assert.match(ok.cookie, /HttpOnly; SameSite=Strict; Path=\/; Secure/);
    assert.equal((await raw('painel.exemplo.com', 'https://outro.exemplo.com', '{}')).status, 403, 'outra origem');
    assert.equal((await raw('127.0.0.1', 'https://painel.exemplo.com', '{}')).status, 421, 'outro host');
  } finally {
    srv.close();
  }
});

test('Resend: chamada no formato documentado', async () => {
  let sent: { url: string; init: RequestInit } | null = null;
  const m = new ResendMailer('re_teste', 'Oria <acesso@exemplo.com>', (async (url: string, init: RequestInit) => {
    sent = { url: String(url), init };
    return Response.json({ id: 'x' });
  }) as typeof fetch);
  await m.send({ to: 'a@exemplo.com', subject: 'Assunto', text: 't', html: '<p>t</p>' });
  assert.equal(sent!.url, 'https://api.resend.com/emails');
  assert.equal(new Headers(sent!.init.headers).get('authorization'), 'Bearer re_teste');
  assert.deepEqual(JSON.parse(String(sent!.init.body)), { from: 'Oria <acesso@exemplo.com>', to: ['a@exemplo.com'], subject: 'Assunto', text: 't', html: '<p>t</p>' });
});

// ---------------------------------------------------------------- R2

test('SigV4: vetor oficial "get-vanilla" da AWS', () => {
  const auth = signV4({
    method: 'GET',
    url: new URL('https://example.amazonaws.com/'),
    headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 'service',
    amzDate: '20150830T123600Z',
  });
  assert.equal(auth, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});

test('mídia no R2: envio assinado; reprodução repassa Range (206) e só da própria loja', async () => {
  const objects = new Map<string, Buffer>();
  const calls: { method: string; path: string; range: string | null; auth: string | null }[] = [];
  const fakeR2 = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const h = new Headers(init?.headers);
    calls.push({ method: init?.method ?? 'GET', path: u.pathname, range: h.get('range'), auth: h.get('authorization') });
    if (init?.method === 'PUT') {
      objects.set(u.pathname, Buffer.from(init.body as Uint8Array));
      return new Response(null, { status: 200 });
    }
    const obj = objects.get(u.pathname);
    if (!obj) return new Response('', { status: 404 });
    const m = /^bytes=(\d+)-(\d+)$/.exec(h.get('range') ?? '');
    if (m) {
      const part = obj.subarray(Number(m[1]), Number(m[2]) + 1);
      return new Response(new Uint8Array(part), { status: 206, headers: { 'content-range': `bytes ${m[1]}-${m[2]}/${obj.length}`, 'content-length': String(part.length) } });
    }
    return new Response(new Uint8Array(obj), { status: 200, headers: { 'content-length': String(obj.length) } });
  }) as typeof fetch;
  const r2 = new R2BlobStore({ endpoint: 'https://conta.r2.cloudflarestorage.com', bucket: 'oria-midia', accessKeyId: 'AK', secretAccessKey: 'SK', fetchImpl: fakeR2 });
  const st = stack();
  const media = new MediaStore(st.db, r2);
  try {
    const video = Buffer.from('0123456789abcdef');
    const saved = await media.save('demo-aurora', 'a'.repeat(24), 'video/mp4', video, 'clipe.mp4');
    assert.equal(calls[0]!.method, 'PUT');
    assert.equal(calls[0]!.path, `/oria-midia/demo-aurora/${saved.id}`);
    assert.match(calls[0]!.auth!, /^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);

    const port = await freePort();
    const srv = (await import('node:http')).createServer((req, res) => {
      const [storeId, id] = (req.url ?? '').slice(1).split('/');
      void media.serve(storeId!, id!, req, res).then((ok) => (ok ? undefined : res.writeHead(404).end()));
    });
    await listen(srv, port);
    try {
      const part = await fetch(`http://127.0.0.1:${port}/demo-aurora/${saved.id}`, { headers: { range: 'bytes=2-5' } });
      assert.equal(part.status, 206);
      assert.equal(part.headers.get('content-range'), 'bytes 2-5/16');
      assert.equal(part.headers.get('accept-ranges'), 'bytes');
      assert.equal(await part.text(), '2345');
      assert.equal(calls.at(-1)!.range, 'bytes=2-5', 'Range repassado ao R2');
      const whole = await fetch(`http://127.0.0.1:${port}/demo-aurora/${saved.id}`);
      assert.equal(await whole.text(), '0123456789abcdef');
      assert.equal((await fetch(`http://127.0.0.1:${port}/demo-trilha/${saved.id}`)).status, 404, 'outra loja não alcança o arquivo');
    } finally {
      srv.close();
    }
  } finally {
    st.close();
  }
});

test('processo hospedado de verdade: sobe com as variáveis de produção, separa painel e serviço pelo host, health', async () => {
  const { spawn } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'oria-hosted-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['src/platform/main.ts'], {
    env: {
      ...process.env,
      ORIA_MODE: 'hosted',
      PORT: String(port),
      BIND_HOST: '127.0.0.1',
      DATA_DIR: dir,
      PANEL_ORIGIN: 'https://painel.exemplo.com',
      PUBLIC_ORIGIN: 'https://api.exemplo.com',
      APP_SECRET: Buffer.alloc(32, 7).toString('base64'),
      OPERATOR_EMAIL: 'op@exemplo.com',
      OPERATOR_PASSWORD: 'senha-do-operador',
      SYNC_EVERY_MIN: '0',
      BACKUP_EVERY_HOURS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const get = (path: string, host: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      r.on('error', reject);
      r.end();
    });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      up = await get('/health', 'api.exemplo.com').then((r) => r.status === 200).catch(() => false);
      if (!up) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(up, `subiu (${log})`);
    assert.match(log, /painel https:\/\/painel\.exemplo\.com · serviço público https:\/\/api\.exemplo\.com/);
    assert.match(log, /e-mail: caixa de saída local \(envio real pendente\)/);
    const panel = await get('/', 'painel.exemplo.com');
    assert.equal(panel.status, 200);
    assert.match(panel.body, /<title>Oria · Painel<\/title>/);
    assert.equal((await get('/api/v1/hosts/demo-aurora.localhost', 'api.exemplo.com')).status, 404, 'sem lojas demo no hospedado');
    assert.equal((await get('/api/stores', 'api.exemplo.com')).status, 404, 'a API do painel não responde no host público');
    assert.equal((await get('/api/v1/stores/qualquer-loja/config', 'painel.exemplo.com')).status, 401, 'no host do painel, só a API do painel (com sessão)');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cópia e restauração do banco: VACUUM INTO, integridade, banco anterior guardado', async () => {
  const { backupDb } = await import('../src/platform/backup.ts');
  const { execFileSync } = await import('node:child_process');
  const { existsSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const st = stack();
  try {
    const before = st.stores.list().length;
    const out = await backupDb(st.db, st.dir, null);
    assert.ok(existsSync(out.file));
    st.stores.createStore({ id: 'loja-depois', name: 'Depois', kind: 'ink', ownerName: 'X', ownerEmail: 'x@exemplo.com', domain: 'depois.exemplo.com', basePath: '/depois', devHost: 'depois.localhost', devOrigin: 'https://depois.exemplo.com', packages: [] }, undefined, null);
    st.db.close();
    execFileSync(process.execPath, ['scripts/restore.mjs', out.file], { env: { ...process.env, DATA_DIR: st.dir } });
    const { openDb } = await import('../src/platform/db.ts');
    const { StoreService } = await import('../src/platform/stores.ts');
    const db2 = openDb(st.dir);
    assert.equal(new StoreService(db2).list().length, before, 'voltou ao estado da cópia');
    db2.close();
    assert.ok(readdirSync(st.dir).some((f) => f.startsWith('pink.db.antes-')), 'banco anterior guardado');
  } finally {
    rmSyncSafe(st.dir);
  }
});

function rmSyncSafe(dir: string) {
  void import('node:fs').then(({ rmSync }) => rmSync(dir, { recursive: true, force: true }));
}
