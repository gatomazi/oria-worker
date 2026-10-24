// Homologação local de uma loja cadastrada, pelo proxy (Worker local), SÓ
// leitura: abre início, uma listagem e um produto no Chrome, confere se cada
// módulo publicado montou onde devia, sem erros e sem rolagem lateral no
// celular. Não liga/desliga nada e não cria versões. Analytics bloqueado.
// Uso: npm run check:loja -- <id-da-loja>   (com npm run dev no ar)
import { chromium } from 'playwright-core';

const storeId = process.argv[2];
if (!storeId) {
  console.error('Uso: npm run check:loja -- <id-da-loja>');
  process.exit(2);
}
const ADMIN = process.env.ADMIN_URL ?? 'http://127.0.0.1:4000';
const EMAIL = process.env.OPERATOR_EMAIL ?? 'gabriel@local.invalid';
const PASSWORD = process.env.OPERATOR_PASSWORD;
if (!PASSWORD) {
  console.error('Defina OPERATOR_PASSWORD (senha do operador no painel local).');
  process.exit(2);
}
const ANALYTICS = /googletagmanager|google-analytics|facebook|segment\.(io|com)|konduto|k-analytix|cloudflareinsights|tiktok|pinterest|doubleclick|apis\.google\.com|analytics-bloqueado/;

let cookie = '';
async function api(path) {
  const res = await fetch(ADMIN + path, { headers: { cookie, origin: ADMIN } });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}
const login = await fetch(`${ADMIN}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ADMIN }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
if (!login.ok) throw new Error('login do operador falhou');
cookie = login.headers.get('set-cookie').split(';')[0];

const view = await api(`/api/stores/${storeId}`);
if (!view.published) {
  console.error('A loja ainda não tem publicação.');
  process.exit(2);
}
const pub = await (await fetch(`http://127.0.0.1:4001/api/v1/stores/${storeId}/config`)).json();
const base = view.storeUrl.replace(/\/$/, '');
const origin = new URL(base).origin;
const sections = (await api(`/api/stores/${storeId}/catalog/sections`).catch(() => ({ sections: [] }))).sections;
const products = (await api(`/api/stores/${storeId}/catalog/products?path=${encodeURIComponent(view.store.basePath || '/')}`).catch(() => ({ products: [] }))).products;
const pages = [
  ['home', base],
  ['listing', sections[0] ? origin + sections[0].path : null],
  ['product', products[0] ? origin + products[0].path : null],
].filter(([, u]) => u);

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${name}${detail ? ` — ${detail}` : ''}`);
};
console.log(`Loja ${view.store.name} · versão publicada ${pub.version} · módulos: ${Object.keys(pub.modules).join(', ')}`);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const [device, opts] of [
    ['computador', { viewport: { width: 1440, height: 900 } }],
    ['celular', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  ]) {
    const ctx = await browser.newContext({ ...opts, reducedMotion: 'reduce' });
    await ctx.route(ANALYTICS, (r) => r.abort());
    for (const [type, url] of pages) {
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => /pink|personalizacoes/i.test(e.stack ?? e.message) && errors.push(e.message));
      page.on('console', (m) => m.text().includes('personalizacoes-ink') && errors.push(m.text()));
      const fetches = [];
      page.on('request', (r) => r.headers()['x-pink-fetch'] && fetches.push(new URL(r.url()).pathname));
      await page.goto(url, { waitUntil: 'load', timeout: 45000 });
      await page.waitForTimeout(5000);
      const st = await page.evaluate(() => window.PersonalizacoesInk?.state() ?? null);
      const dev = device === 'celular' ? 'mobile' : 'desktop';
      const expected = Object.entries(pub.modules).filter(([, m]) => m.pages.includes(type) && m.devices.includes(dev)).map(([id]) => id);
      const mounted = st?.mounted ?? [];
      // Módulos que dependem de conteúdo (avaliações, vídeos vinculados, tabela da modelagem) podem não aparecer.
      const optional = new Set(['reviews', 'videoCards', 'miniPlayer', 'sizeGuide']);
      const missing = expected.filter((m) => !mounted.includes(m) && !optional.has(m));
      check(`${device} · ${type}: módulos esperados montados`, missing.length === 0 && !(st?.failed ?? []).length, `montados ${JSON.stringify(mounted)}${missing.length ? ` · faltando ${missing.join(', ')}` : ''}${st?.failed?.length ? ` · falhas ${st.failed.join(', ')}` : ''}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (device === 'celular') check(`${device} · ${type}: sem rolagem horizontal`, overflow <= 0, `${overflow}px`);
      if (device === 'celular') {
        // Botões flutuantes (assistente, mini player) não podem cobrir a barra de compra, o aviso de cookies nem a ajuda da INK.
        const hits = await page.evaluate(() => {
          const visible = (el) => el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
          const natives = [['barra de compra', '.form-product-options__add-to-cart-mobile'], ['aviso de cookies', '.cookie-acceptance'], ['ajuda da INK', '[data-controller~="ink-store--help-button"]']]
            .map(([n, s]) => [n, document.querySelector(s)])
            .filter(([, el]) => visible(el));
          const out = [];
          for (const host of document.querySelectorAll('[data-pink-floating], [data-pink-module="assistant"], [data-pink-module="miniPlayer"]')) {
            if (!visible(host)) continue;
            const a = host.getBoundingClientRect();
            if (!a.width || !a.height) continue;
            for (const [n, el] of natives) {
              const b = el.getBoundingClientRect();
              if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) out.push(`${host.getAttribute('data-pink-module')} × ${n}`);
            }
          }
          return out;
        });
        check(`${device} · ${type}: flutuantes não cobrem compra, cookies nem ajuda`, hits.length === 0, hits.join(', '));
      }
      check(`${device} · ${type}: sem erros dos módulos`, errors.length === 0, errors.slice(0, 2).join(' | '));
      if (fetches.length) console.log(`      leituras de páginas da loja pelos módulos: ${fetches.length} (${[...new Set(fetches)].join(', ')})`);
      await page.close();
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} verificações ok — proxy local sobre a loja; não é validação de produção.`);
process.exit(ok === results.length ? 0 : 1);
