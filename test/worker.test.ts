// Worker real (workerd via Miniflare, HTMLRewriter de verdade).
// Saídas de rede simuladas: serviço de configuração, réplica local e loja externa.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import '../src/shared/modules/index.ts';
import { defaultConfig, parseStoreConfig, toPublicConfig, moduleDefs } from '../src/shared/registry.ts';
import { coupon } from './helpers.ts';

const PDP = readFileSync('test/fixtures/ink/pdp.html', 'utf8');
const HOME = readFileSync('test/fixtures/ink/home.html', 'utf8');
type Mode = 'coupons-home' | 'gallery-only' | 'none' | 'down' | 'invalid' | 'slow';
let mode: Mode = 'coupons-home';
const hits: string[] = [];

function publicConfig(storeId: string, enabled: string[]) {
  const c = defaultConfig();
  for (const id of enabled) c.modules[id]!.enabled = true;
  c.modules.coupons!.settings.campaigns = [coupon()];
  c.modules.coupons!.settings.pages = ['home'];
  return toPublicConfig({ id: storeId, basePath: '/vistaentrenos' }, 4, '2026-10-24T12:00:00.000Z', parseStoreConfig(c).value, new Set(moduleDefs().map((d) => d.id)));
}

const HOSTS: Record<string, unknown> = {
  'demo-aurora.localhost': { storeId: 'demo-aurora', basePath: '/vistaentrenos', devOrigin: 'http://127.0.0.1:4101', kind: 'demo', active: true, proxyCart: false, turbo: false },
  'vistaentrenos.localhost': { storeId: 'vista', basePath: '/vistaentrenos', devOrigin: 'https://www.vistaentrenos.com.br', kind: 'ink', active: true, proxyCart: false, turbo: false },
  'vistacart.localhost': { storeId: 'vista', basePath: '/vistaentrenos', devOrigin: 'https://www.vistaentrenos.com.br', kind: 'ink', active: true, proxyCart: true, turbo: false },
  'pausada.localhost': { storeId: 'p', basePath: '/p', devOrigin: 'http://127.0.0.1:4101', kind: 'demo', active: false, proxyCart: false, turbo: false },
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const mf = new Miniflare({
  modules: true,
  scriptPath: 'dist/worker.js',
  compatibilityDate: '2026-07-01',
  bindings: { CONFIG_SERVICE_URL: 'http://svc.test', ORIGIN_MODE: 'dev-origin', CONFIG_TIMEOUT_MS: '300', ADMIN_ORIGIN: 'http://127.0.0.1:4000' },
  outboundService: async (req: Request) => {
    const url = new URL(req.url);
    hits.push(`${req.method} ${url.host}${url.pathname} cookie=${req.headers.get('cookie') ?? '-'} origin=${req.headers.get('origin') ?? '-'}`);
    if (url.host === 'svc.test') {
      const host = /^\/api\/v1\/hosts\/(.+)$/.exec(url.pathname)?.[1];
      if (host) return HOSTS[host] ? json(HOSTS[host]) : json({ error: 'unknown_host' }, 404);
      if (/\/config$/.test(url.pathname)) {
        if (mode === 'down') throw new Error('connection refused');
        if (mode === 'slow') await new Promise((r) => setTimeout(r, 1200));
        if (mode === 'none') return json({ error: 'not_published' }, 404);
        const cfg = publicConfig(url.pathname.split('/')[4]!, mode === 'gallery-only' ? ['gallery'] : ['coupons']) as any;
        if (mode === 'invalid') cfg.modules.coupons.settings.campaigns[0].title = '<script>x</script>';
        return json(cfg);
      }
      if (/\/preview-config$/.test(url.pathname)) return url.searchParams.get('token') === 'tok-valido-123456789012345' ? json(publicConfig('demo-aurora', ['coupons'])) : json({ error: 'invalid_token' }, 403);
      if (/^\/client\//.test(url.pathname)) return new Response('/* carregador */', { headers: { 'content-type': 'text/javascript' } });
      if (/\/media\//.test(url.pathname)) {
        return new Response('abc', { status: req.headers.get('range') ? 206 : 200, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-2/3', 'accept-ranges': 'bytes' } });
      }
      if (/\/assistant$/.test(url.pathname)) return json({ answer: 'ok', echo: await req.text() });
    }
    if (url.host === '127.0.0.1:4101') {
      if (url.pathname.endsWith('/stream')) return new Response('<turbo-stream></turbo-stream></body>', { headers: { 'content-type': 'text/vnd.turbo-stream.html' } });
      return new Response(url.pathname.includes('/product/') ? PDP : HOME, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url.host === 'www.vistaentrenos.com.br') {
      if (url.pathname === '/') return new Response(null, { status: 301, headers: { location: 'https://www.vistaentrenos.com.br/vistaentrenos' } });
      return new Response(
        '<html><head><script async src="https://www.googletagmanager.com/gtm.js?id=X"></script><script src="https://i.k-analytix.com/k.js"></script><script defer src="https://static.cloudflareinsights.com/beacon.min.js"></script><script>function eventoDaLoja(){};(function(){var s=document.createElement("script");s.src="https://www.googletagmanager.com/gtm.js?id=X"})()</script></head><body data-store-fb-pixel-id="123"><div data-ink-store--segment-write-key-value="KEY"><a href="https://www.vistaentrenos.com.br/vistaentrenos/about">Sobre</a></div></body></html>',
        { headers: { 'content-type': 'text/html', 'set-cookie': '_reserva_ink_store_session=abc; path=/; secure; HttpOnly' } },
      );
    }
    return new Response('inesperado', { status: 599 });
  },
});
after(() => mf.dispose());

const go = async (url: string, init?: RequestInit) => {
  const res = await mf.dispatchFetch(url, init as any);
  return { res, body: await res.text() };
};
const tags = (html: string) => html.match(/<script[^>]*data-pink-loader[^>]*><\/script>/g) ?? [];

test('injeta o carregador só onde algum módulo publicado roda', async () => {
  mode = 'coupons-home';
  const home = await go('http://demo-aurora.localhost:8787/vistaentrenos');
  assert.deepEqual(tags(home.body), ['<script type="module" src="/__pink/client/loader.js?v=4" data-pink-loader="4"></script>']);
  assert.equal(home.body.replace(tags(home.body)[0]!, ''), HOME, 'resto do HTML idêntico');
  const pdp = await go('http://demo-aurora.localhost:8787/vistaentrenos/product/vo-minha-maior-riqueza');
  assert.equal(tags(pdp.body).length, 0, 'cupom só na home: produto fica intacto');
  assert.equal(pdp.body, PDP);
  mode = 'gallery-only';
  assert.equal(tags((await go('http://demo-aurora.localhost:8787/vistaentrenos')).body).length, 0);
  assert.equal(tags((await go('http://demo-aurora.localhost:8787/vistaentrenos/product/x')).body).length, 1);
});

for (const m of ['none', 'down', 'invalid', 'slow'] as const) {
  test(`configuração "${m}": página idêntica à origem`, async () => {
    mode = m;
    const r = await go('http://demo-aurora.localhost:8787/vistaentrenos');
    assert.equal(r.body, HOME);
    assert.equal(r.res.headers.get('x-pink-loader'), null);
  });
}

test('não injeta em Turbo-Frame, Range, POST, stream ou página que já tem o carregador', async () => {
  mode = 'coupons-home';
  assert.equal(tags((await go('http://demo-aurora.localhost:8787/vistaentrenos', { headers: { 'turbo-frame': 'cart' } })).body).length, 0);
  assert.equal(tags((await go('http://demo-aurora.localhost:8787/vistaentrenos', { headers: { range: 'bytes=0-10' } })).body).length, 0);
  assert.equal(tags((await go('http://demo-aurora.localhost:8787/vistaentrenos', { method: 'POST', body: 'x' })).body).length, 0);
  assert.equal(tags((await go('http://demo-aurora.localhost:8787/vistaentrenos/stream')).body).length, 0);
  assert.equal(tags((await go('http://demo-aurora.localhost:8787/vistaentrenos', { headers: { 'x-pink-fetch': '1' } })).body).length, 0, 'leitura de dados pelos módulos passa sem injeção');
});

test('host desconhecido ou loja pausada: nada é servido como loja', async () => {
  assert.equal((await go('http://outra.localhost:8787/')).res.status, 404);
  assert.equal((await go('http://pausada.localhost:8787/p')).res.status, 404);
});

test('rotas próprias /__pink/*: carregador, config, prévia, mídia com Range e assistente (POST antes do proxy)', async () => {
  mode = 'coupons-home';
  const loader = await go('http://demo-aurora.localhost:8787/__pink/client/loader.js');
  assert.match(loader.res.headers.get('content-type') ?? '', /javascript/);
  assert.equal(JSON.parse((await go('http://demo-aurora.localhost:8787/__pink/config.json')).body).storeId, 'demo-aurora');
  assert.equal((await go('http://demo-aurora.localhost:8787/__pink/preview-config.json?token=errado')).res.status, 403);
  const media = await go('http://demo-aurora.localhost:8787/__pink/media/0123456789abcdef01234567', { headers: { range: 'bytes=0-2' } });
  assert.equal(media.res.status, 206);
  assert.equal(media.res.headers.get('content-range'), 'bytes 0-2/3');
  const ask = await go('http://vistaentrenos.localhost:8787/__pink/assistant', { method: 'POST', body: JSON.stringify({ message: 'oi' }), headers: { 'content-type': 'application/json' } });
  assert.equal(ask.res.status, 200, 'POST do assistente não cai no bloqueio do proxy');
  assert.equal((await go('http://demo-aurora.localhost:8787/__pink/desconhecido')).res.status, 404);
});

test('prévia: injeta com token, libera iframe só para o painel e não manda o token à origem', async () => {
  mode = 'none';
  const n = hits.length;
  const r = await go('http://demo-aurora.localhost:8787/vistaentrenos?__pink_preview=tok-valido-123456789012345');
  assert.match(tags(r.body)[0] ?? '', /data-pink-preview="tok-valido-123456789012345" data-pink-admin="http:\/\/127\.0\.0\.1:4000"/);
  assert.equal(r.res.headers.get('content-security-policy'), 'frame-ancestors http://127.0.0.1:4000');
  assert.equal(r.res.headers.get('x-frame-options'), null);
  assert.equal(r.res.headers.get('cache-control'), 'no-store');
  assert.ok(hits.slice(n).some((h) => h.includes('127.0.0.1:4101/vistaentrenos ')), 'origem recebeu a URL limpa');
  assert.ok(!hits.slice(n).some((h) => h.includes('__pink_preview')));
});

test('proxy local da loja real: só leitura, sem analytics, links e redirect no proxy, sem cookies', async () => {
  mode = 'none';
  const root = await go('http://vistaentrenos.localhost:8787/', { redirect: 'manual' } as RequestInit);
  assert.equal(root.res.headers.get('location'), 'http://vistaentrenos.localhost:8787/vistaentrenos');
  const n = hits.length;
  const page = await go('http://vistaentrenos.localhost:8787/vistaentrenos', { headers: { cookie: 'x=1' } });
  assert.doesNotMatch(page.body, /googletagmanager|k-analytix|cloudflareinsights|data-store-fb-pixel-id|value="KEY"/, 'nenhum envio de analytics');
  assert.match(page.body, /function eventoDaLoja\(\)\{\}/, 'código da loja no script inline continua íntegro');
  assert.match(page.body, /analytics-bloqueado\.invalid/);
  assert.match(page.body, /href="http:\/\/vistaentrenos\.localhost:8787\/vistaentrenos\/about"/);
  assert.equal(page.res.headers.get('set-cookie'), null);
  assert.ok(hits.slice(n).every((h) => !h.includes('www.vistaentrenos') || h.includes('cookie=-')), 'cookies não vão para a loja');
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const before = hits.length;
    assert.equal((await go('http://vistaentrenos.localhost:8787/vistaentrenos/cart', { method, body: 'x' })).res.status, 405);
    assert.ok(!hits.slice(before).some((h) => h.includes('www.vistaentrenos')), `${method} não chega à loja`);
  }
});

test('proxy com carrinho liberado: só POST de carrinho passa (com sessão e origem da loja); checkout nunca', async () => {
  const n = hits.length;
  const ok = await go('http://vistacart.localhost:8787/vistaentrenos/cart?product_id=1', { method: 'POST', body: 'quantity=1', headers: { cookie: '_reserva_ink_store_session=abc', origin: 'http://vistacart.localhost:8787' } });
  assert.notEqual(ok.res.status, 405);
  const sent = hits.slice(n).find((h) => h.startsWith('POST www.vistaentrenos.com.br/vistaentrenos/cart'));
  assert.ok(sent?.includes('cookie=_reserva_ink_store_session=abc'));
  assert.ok(sent?.includes('origin=https://www.vistaentrenos.com.br'));
  for (const path of ['/vistaentrenos/cart/checkout_cart_items', '/vistaentrenos/checkout/contact_and_shipping_details', '/vistaentrenos/store_sessions', '/vistaentrenos/orders', '/vistaentrenos/review_feedbacks/1', '/ahoy/visits', '/ahoy/events', '/vistaentrenos/ahoy/events']) {
    assert.equal((await go(`http://vistacart.localhost:8787${path}`, { method: 'POST', body: 'x' })).res.status, 405, path);
  }
});
