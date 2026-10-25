import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stack, VISTA, IDENTITY } from './helpers.ts';
import { fixture } from './dom-harness.ts';

/** Loja de mentira (GET): páginas gravadas da Vista. */
const storeFetch = (async (url: string | URL) => {
  const p = new URL(String(url)).pathname;
  const name =
    p.endsWith('/faq') ? 'faq.html'
    : p.endsWith('/exchanges_and_returns') ? 'exchanges-and-returns.html'
    : p.endsWith('/about') ? 'about.html'
    : p.endsWith('/product_promotions') ? 'pdp-frame-product-promotions-com-cupons.html'
    : p.includes('/product/') ? 'pdp.html'
    : p.endsWith('/reviews') ? 'reviews-ink-anonimizado.html'
    : 'home.html';
  return new Response(fixture(name), { headers: { 'content-type': 'text/html' } });
}) as typeof fetch;

const PROMOS = [
  { id: 1, type: 'standard', code: 'INVERNO10', kind: 'percentage', apply_automatically: false, list_type: 'all', first_purchase: false, available: true, discount_tiers: [{ min_cart_value: '200.0', discount: '10.0' }] },
  { id: 2, type: 'progressive', code: 'ESCADA', kind: 'percentage', apply_automatically: true, list_type: 'collections', progress_kind: 'cart_items', available: true, discount_tiers: [{ discount: '5.0', min_cart_items: 2 }, { discount: '10.0', min_cart_items: 3 }], collection_ids: [42] },
];
const apiFetch = (async (url: string | URL) => {
  const u = new URL(String(url));
  if (u.pathname === '/v1/stores/products' && u.searchParams.get('per_page') === '1') return Response.json({ products: [{ store: { slug: 'vistaentrenos' } }], total_count: 1 });
  if (u.pathname === '/v1/stores/promotions') return Response.json({ promotions: PROMOS, total_pages: 1 });
  if (u.pathname === '/v1/stores/collections') return Response.json({ collections: [{ id: 42, name: 'Mães', slug: 'maes', position: 1, is_available: true, product_ids: [1] }, { id: 7, name: 'Pais', slug: 'pais', position: 2, is_available: true, product_ids: [2] }], total_pages: 1 });
  if (u.pathname === '/v1/stores/products') return Response.json({ products: [], total_pages: 1 });
  return new Response('', { status: 404 });
}) as typeof fetch;

test('configuração guiada: sugestões da loja e da API, com origem; nada é inventado', async () => {
  const s = stack({ fetchImpl: storeFetch, apiFetch });
  try {
    const store = s.stores.createStore({ ...VISTA, packages: ['vitrine', 'conversao', 'conteudo'] }, IDENTITY, null);
    assert.equal(s.stores.view(store.id).draft.config.modules.coupons!.settings.styleMobile, 'compacto', 'loja nova começa com o cupom compacto no celular');
    await s.integration.syncSite(store);
    s.integration.setToken(store, 'tok_exemplo_0123456789_abcdefghij_WXYZ', null);
    await s.integration.testApi(store);
    const offers = s.setup.offers(store.id);
    const by = new Map(offers.map((o) => [o.key, o]));
    assert.equal(by.get('identidade')!.origin, 'Página inicial da loja');
    assert.match(by.get('identidade')!.detail, /#50313D/);
    assert.match(by.get('categorias')!.detail, /^Mães, Pais$/);
    assert.equal(by.get('categorias')!.origin, 'API da INK (ordem do menu)');
    assert.ok(by.has('cupom:INVERNO10'));
    assert.ok(!by.has('cupom:ESCADA'), 'automática não vira cupom');
    assert.match(by.get('metas:ESCADA')!.detail, /Só itens da coleção/);
    assert.ok(by.has('cupons-produto'));
    assert.ok(by.has('assistente'));
    assert.ok(![...by.keys()].some((k) => k.startsWith('metas-pagina:')), 'com API, o alcance vem da API');
    const sug = s.setup.identitySuggestion(store.id, s.stores.view(store.id).draft.config.identity)!;
    assert.equal(sug.primary, '#50313D');
    assert.equal(sug.surface, '#F3E7CF');
  } finally {
    s.close();
  }
});

test('importação não sobrescreve ajuste manual em silêncio; alcance da página exige confirmação', async () => {
  const s = stack({ fetchImpl: storeFetch });
  try {
    const store = s.stores.createStore({ ...VISTA, packages: ['vitrine', 'conversao'] }, IDENTITY, null);
    await s.integration.syncSite(store);
    let r = s.setup.applyImports(store.id, { keys: ['categorias'] }, null);
    assert.deepEqual(r.report, [{ key: 'categorias', result: 'aplicado' }]);
    assert.equal(s.setup.offers(store.id).find((o) => o.key === 'categorias')!.state, 'aplicado');
    // o lojista ajusta uma aba
    const v = s.stores.view(store.id);
    const cfg = structuredClone(v.draft.config);
    (cfg.modules.categoryTabs!.settings.tabs as { label: string }[])[0]!.label = 'Para mamãe';
    s.stores.saveDraft(store.id, cfg, v.draft.updatedAt, null);
    assert.equal(s.setup.offers(store.id).find((o) => o.key === 'categorias')!.state, 'editado');
    r = s.setup.applyImports(store.id, { keys: ['categorias'] }, null);
    assert.deepEqual(r.report, [{ key: 'categorias', result: 'mantido' }]);
    assert.equal((s.stores.view(store.id).draft.config.modules.categoryTabs!.settings.tabs as { label: string }[])[0]!.label, 'Para mamãe');
    r = s.setup.applyImports(store.id, { keys: ['categorias'], replace: ['categorias'] }, null);
    assert.equal(r.report[0]!.result, 'aplicado', 'substitui só quando pedido');

    // Sem API: faixas vistas na página do produto pedem confirmação do alcance.
    const metas = s.setup.offers(store.id).find((o) => o.key.startsWith('metas-pagina:'))!;
    assert.match(metas.confirm!, /vale para a loja toda/);
    assert.equal(s.setup.applyImports(store.id, { keys: [metas.key] }, null).report[0]!.result, 'sem confirmação');
    assert.equal(s.setup.applyImports(store.id, { keys: [metas.key], confirmed: [metas.key] }, null).report[0]!.result, 'aplicado');
    assert.equal(s.stores.view(store.id).draft.config.modules.cartIncentive!.settings.campaignName, 'LEVEMAISEXEMPLO');
  } finally {
    s.close();
  }
});

test('recursos: liga só o que está pronto; pendentes ficam desligados com o motivo; passo retomável', async () => {
  const s = stack({ fetchImpl: storeFetch });
  try {
    const store = s.stores.createStore({ ...VISTA, packages: ['vitrine', 'conversao', 'conteudo'] }, IDENTITY, null);
    await s.integration.syncSite(store);
    const f = new Map(s.setup.features(store.id).map((x) => [x.id, x]));
    assert.equal(f.get('header')!.ready, true);
    assert.equal(f.get('coupons')!.ready, false, 'sem cupom cadastrado nem lido: não inventa');
    assert.match(f.get('coupons')!.missing, /campanha|cupons da INK/i);
    assert.equal(f.get('videoCards')!.ready, false);
    assert.match(f.get('videoCards')!.missing, /vídeo/);
    const presets = s.setup.presets(store.id);
    assert.deepEqual(presets.map((p) => p.id), ['navegacao', 'ofertas', 'conteudo']);
    const out = s.setup.setFeatures(store.id, { enable: ['header', 'gallery', 'coupons', 'videoCards'] }, null);
    assert.deepEqual(out.skipped.map((x) => x.id).sort(), ['coupons', 'videoCards']);
    const mods = s.stores.view(store.id).draft.config.modules;
    assert.equal(mods.header!.enabled, true);
    assert.equal(mods.coupons!.enabled, false, 'sem seção vazia na loja');
    // depois de importar os cupons da INK, o recurso fica pronto
    s.setup.applyImports(store.id, { keys: ['cupons-produto'] }, null);
    assert.equal(s.setup.features(store.id).find((x) => x.id === 'coupons')!.ready, true);
    // progresso
    assert.deepEqual(s.setup.progress(store.id), { step: 1, completedAt: null });
    s.setup.setStep(store.id, 3);
    assert.equal(s.setup.progress(store.id).step, 3);
    const done = s.setup.complete(store.id);
    assert.ok(done.completedAt);
    s.setup.setStep(store.id, 2);
    assert.equal(s.setup.progress(store.id).completedAt, done.completedAt, 'reabrir não desfaz a conclusão');
  } finally {
    s.close();
  }
});
