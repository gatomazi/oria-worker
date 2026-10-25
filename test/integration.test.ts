import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parseAbout, parseContacts, parseFaq, parseProductPromotions, progressiveTiers } from '../src/shared/ink-parse.ts';
import { stack } from './helpers.ts';
import { fixture } from './dom-harness.ts';

const doc = (name: string) => new JSDOM(fixture(name)).window.document;

/** Loja de mentira: cada caminho público da INK devolve a página gravada correspondente. */
function storeFetch(opts: { down?: boolean } = {}) {
  const seen: string[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    seen.push(`${init?.method ?? 'GET'} ${u.pathname}`);
    if (opts.down) throw new Error('sem rede');
    const p = u.pathname;
    const name =
      p === '/vistaentrenos/faq' ? 'faq.html'
      : p === '/vistaentrenos/exchanges_and_returns' ? 'exchanges-and-returns.html'
      : p === '/vistaentrenos/about' ? 'about.html'
      : p.endsWith('/product_promotions') ? 'pdp-frame-product-promotions-com-cupons.html'
      : p.startsWith('/vistaentrenos/product/') ? 'pdp.html'
      : 'home.html';
    return new Response(fixture(name), { headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  return { impl, seen };
}

test('páginas da INK: perguntas frequentes, sobre, contatos e faixas da promoção progressiva', () => {
  const faq = parseFaq(doc('faq.html'));
  assert.ok(faq.length >= 5);
  const tecido = faq.find((f) => f.question === 'Qual é o tecido das camisetas?');
  assert.match(tecido!.answer, /Algodão 30\.1 Penteado/);
  assert.match(tecido!.answer, /cinza-mescla/, 'junta a quebra de linha do texto da INK');
  assert.equal(parseFaq(doc('exchanges-and-returns.html')).length, 2);
  assert.deepEqual(parseAbout(doc('about.html')), { name: 'Entre Nós', text: '' });
  assert.equal(parseContacts(doc('about.html')).instagram, 'vistaentrenos_');
  const [leve, primeira] = parseProductPromotions(doc('pdp-frame-product-promotions-com-cupons.html'));
  assert.deepEqual(progressiveTiers(leve!), {
    measure: 'itens',
    tiers: [
      { threshold: 2, benefit: 'valor', amount: 20, label: 'R$20,00 OFF' },
      { threshold: 3, benefit: 'valor', amount: 60, label: 'R$60,00 OFF' },
    ],
  });
  assert.equal(progressiveTiers(primeira!), null, 'cupom comum não é progressivo');
  assert.deepEqual(progressiveTiers({ rules: ['Promoção progressiva', '2 peças - 10% OFF', '4 peças - 15% OFF'] })?.tiers.map((t) => [t.threshold, t.benefit, t.amount]), [
    [2, 'percentual', 10],
    [4, 'percentual', 15],
  ]);
});

test('leitura da loja: só GET, pré-carrega cupons, faixas e respostas; falha mantém o último retrato', async () => {
  const shop = storeFetch();
  const s = stack({ fetchImpl: shop.impl });
  try {
    const store = s.stores.get('demo-trilha')!;
    const st = await s.integration.syncSite(store);
    assert.equal(st.site.error, null);
    const d = st.site.data!;
    assert.ok(shop.seen.every((x) => x.startsWith('GET ')), 'nunca escreve na loja');
    assert.deepEqual(d.coupons.map((c) => c.code), ['LEVEMAISEXEMPLO', 'PRIMEIRAEXEMPLO']);
    assert.equal(d.progressive[0]?.code, 'LEVEMAISEXEMPLO');
    assert.ok(d.faq.some((f) => f.page === 'trocas') || d.faq.some((f) => /troca/i.test(f.question)));
    assert.ok(d.sections.length > 0);
    // Loja fora do ar: guarda o erro e mantém o que já tinha.
    const down = s.integration;
    (s.catalog as unknown as { fetchImpl: typeof fetch }).fetchImpl = storeFetch({ down: true }).impl;
    const after = await down.syncSite(store);
    assert.match(after.site.error!, /último retrato foi mantido/);
    assert.equal(after.site.data!.coupons.length, 2);
  } finally {
    s.close();
  }
});

test('token da API da INK: cifrado, nunca devolvido; teste confere a loja e trata recusa', async () => {
  const TOKEN = 'tok_exemplo_0123456789_abcdefghij_WXYZ';
  let reply: () => Response = () => new Response('{}');
  const calls: { url: string; auth: string | null }[] = [];
  const apiFetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
    return reply();
  }) as typeof fetch;
  const s = stack({ apiFetch });
  try {
    const store = s.stores.get('demo-trilha')!;
    assert.throws(() => s.integration.setToken(store, 'curto', null), /token/);
    const st = s.integration.setToken(store, TOKEN, null);
    assert.equal(st.api.hint, 'WXYZ');
    assert.ok(!JSON.stringify(st).includes(TOKEN), 'status não traz o token');
    const raw = s.db.prepare('SELECT token_enc FROM ink_api').get() as { token_enc: string };
    assert.ok(!raw.token_enc.includes(TOKEN) && !raw.token_enc.includes('0123456789'), 'gravado cifrado');

    reply = () => Response.json({ products: [{ store: { slug: 'vistaentrenos', name: 'Entre Nós' } }], total_count: 42 });
    let t = await s.integration.testApi(store);
    assert.equal(t.api.testOk, true);
    assert.match(t.api.testMessage!, /Entre Nós: 42 produtos/);
    assert.equal(calls[0]!.auth, `Bearer ${TOKEN}`);
    assert.match(calls[0]!.url, /\/v1\/stores\/products\?per_page=1/);

    reply = () => Response.json({ products: [{ store: { slug: 'outraloja', name: 'Outra' } }] });
    t = await s.integration.testApi(store);
    assert.equal(t.api.testOk, false);
    assert.match(t.api.testMessage!, /não desta/);

    reply = () => new Response('', { status: 401 });
    assert.match((await s.integration.testApi(store)).api.testMessage!, /recusou o token/);
    assert.equal(s.integration.clearToken(store).api.configured, false);
  } finally {
    s.close();
  }
});

test('assistente responde com o que a loja publicou, sem base cadastrada; o cadastro manual prevalece', async () => {
  const s = stack({ fetchImpl: storeFetch().impl });
  try {
    s.stores.savePackage({ id: 'conteudo', name: 'Conteúdo', modules: ['videoCards', 'miniPlayer', 'assistant'] }, null);
    const v = s.stores.view('demo-trilha');
    const cfg = structuredClone(v.draft.config);
    cfg.modules.assistant = { enabled: true, settings: { ...cfg.modules.assistant!.settings, knowledge: [], storeData: true } };
    s.stores.saveDraft('demo-trilha', cfg, v.draft.updatedAt, null);
    s.stores.publish('demo-trilha', s.stores.view('demo-trilha').draft.updatedAt, null);
    await s.integration.syncSite(s.stores.get('demo-trilha')!);
    const ask = (m: string) => s.assistant.answer('demo-trilha', { sessionId: 'sessao-integra-1', message: m });
    assert.match(String((await ask('qual o tecido das camisetas?')).body.answer), /Algodão/);
    assert.match(String((await ask('qual o instagram de vocês?')).body.answer), /@vistaentrenos_/);

    // Desligado e sem base: não publica (nada para responder).
    const v2 = s.stores.view('demo-trilha');
    const off = structuredClone(v2.draft.config);
    off.modules.assistant!.settings.storeData = false;
    assert.throws(() => s.stores.saveDraft('demo-trilha', off, v2.draft.updatedAt, null), (e: { errors?: { message: string }[] }) => !!e.errors?.some((x) => /ao menos uma resposta/.test(x.message)));
    // Manual com a mesma pergunta vence o texto da INK.
    off.modules.assistant!.settings.storeData = true;
    off.modules.assistant!.settings.knowledge = [{ topic: 'produtos', question: 'Qual é o tecido das camisetas?', answer: 'Resposta da loja: algodão egípcio.', keywords: 'tecido' }];
    s.stores.saveDraft('demo-trilha', off, v2.draft.updatedAt, null);
    s.stores.publish('demo-trilha', s.stores.view('demo-trilha').draft.updatedAt, null);
    assert.match(String((await ask('qual o tecido das camisetas?')).body.answer), /algodão egípcio/);
  } finally {
    s.close();
  }
});

// Exemplos do guia oficial de promoções da INK (developers.reserva.ink/guias/promocoes).
const PROMOS = [
  { id: 314, type: 'standard', code: 'INVERNO10', kind: 'percentage', apply_automatically: false, list_type: 'all', progress_kind: null, first_purchase: false, show_on_product_page: true, show_in_cart: true, starts_at: null, expires_at: '2026-08-31T23:59:59Z', available: true, discount_tiers: [{ min_cart_value: '200.0', min_cart_items: null, discount: '10.0' }], product_ids: [], product_type_ids: [], collection_ids: [] },
  { id: 315, type: 'progressive', code: 'ESCADA', kind: 'percentage', apply_automatically: true, list_type: 'collections', progress_kind: 'cart_items', first_purchase: false, available: true, discount_tiers: [{ discount: '10.0', min_cart_items: 3 }, { discount: '5.0', min_cart_items: 2 }], collection_ids: [42] },
  { id: 316, type: 'unit_free', code: 'LEVE5PAGUE4', apply_automatically: true, list_type: 'all', available: false, starts_at: '2099-01-01T00:00:00Z', discount_tiers: [{ min_cart_items: 5 }] },
  { id: 317, type: 'standard', code: 'tem espaço', kind: 'value' },
];

test('API da INK: promoções do contrato oficial viram cupom (M05) e metas (M06)', async () => {
  const { normalizePromotion, promotionToCampaign, promotionToIncentive, tierLines } = await import('../src/shared/ink-promotions.ts');
  const [inverno, escada, leve, ruim] = PROMOS.map(normalizePromotion);
  assert.equal(ruim, null, 'código inválido é descartado');
  assert.deepEqual(tierLines(inverno!), ['10% OFF acima de R$\u00a0200']);
  const camp = promotionToCampaign(inverno!)!;
  assert.equal(camp.code, 'INVERNO10');
  assert.equal(camp.endsAt, '2026-08-31T23:59:59.000Z');
  assert.match(String(camp.conditions), /Vale para a loja toda/i);
  assert.equal(promotionToCampaign(escada!), null, 'automática não vira cupom para copiar');
  assert.deepEqual(promotionToIncentive(escada!, (cid) => (cid === 42 ? '/loja/collections/maes' : null)), {
    campaignName: 'ESCADA',
    measure: 'itens',
    eligibility: 'colecao',
    eligiblePath: '/loja/collections/maes',
    tiers: [
      { threshold: 2, benefit: 'percentual', amount: 5, label: '5% OFF' },
      { threshold: 3, benefit: 'percentual', amount: 10, label: '10% OFF' },
    ],
  });
  assert.deepEqual(tierLines(leve!), ['Leve 5, pague 4: a peça mais barata sai grátis']);
  assert.equal((promotionToIncentive(leve!)!.tiers as { benefit: string }[])[0]!.benefit, 'brinde');
});

test('API da INK: lê promoções, categorias e produtos publicados; recurso sem escopo não derruba os outros', async () => {
  const TOKEN = 'tok_exemplo_0123456789_abcdefghij_WXYZ';
  const paths: string[] = [];
  let productsStatus = 200;
  const apiFetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    paths.push(`${init?.method ?? 'GET'} ${u.pathname}${u.search}`);
    if (u.pathname === '/v1/stores/products' && u.searchParams.get('per_page') === '1') return Response.json({ products: [{ store: { slug: 'vistaentrenos' } }], total_count: 3 });
    if (u.pathname === '/v1/stores/promotions') return Response.json({ promotions: PROMOS, page: 1, per_page: 100, total_pages: 1, total_count: 4 });
    if (u.pathname === '/v1/stores/collections')
      return Response.json({ collections: [{ id: 42, name: 'Mães', slug: 'maes', position: 2, is_available: true, product_ids: [1, 2] }, { id: 7, name: 'Pais', slug: 'pais', position: 1, is_available: true, product_ids: [3] }], total_pages: 1 });
    if (u.pathname === '/v1/stores/products') {
      if (productsStatus !== 200) return new Response('{}', { status: productsStatus });
      return Response.json({
        products: [
          { id: 1, name: 'Vó, Minha Maior Riqueza', status: 'published', visible_in_store: true, store_product_url: 'https://www.vistaentrenos.com.br/vistaentrenos/product/vo-minha-maior-riqueza', price: '109.9', promotional_price: '89.9', tags: ['avó', 'família'], total_sales_count: 40, product_cluster_id: 9, product_type: { name: 'Camiseta' }, product_variants: [{ size: 'P', color: 'Branco', is_available: true }, { size: 'GG', color: 'Branco', is_available: false }] },
          { id: 2, name: 'Rascunho', status: 'not_published', visible_in_store: true, store_product_url: 'https://www.vistaentrenos.com.br/vistaentrenos/product/rascunho' },
          { id: 3, name: 'De outra loja', status: 'published', visible_in_store: true, store_product_url: 'https://outra.com.br/outra/product/x' },
        ],
        total_pages: 1,
      });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const s = stack({ apiFetch });
  try {
    const store = s.stores.get('demo-trilha')!;
    s.integration.setToken(store, TOKEN, null);
    const st = await s.integration.testApi(store);
    assert.equal(st.api.testOk, true);
    const d = st.api.data!;
    assert.deepEqual(d.promotions.map((p) => p.code), ['INVERNO10', 'ESCADA', 'LEVE5PAGUE4']);
    assert.deepEqual(d.collections.map((c) => [c.name, c.path]), [['Pais', '/vistaentrenos/collections/pais'], ['Mães', '/vistaentrenos/collections/maes']], 'na ordem do menu');
    assert.equal(d.products.total, 1, 'só publicado, visível e da própria loja');
    const full = s.integration.apiData('demo-trilha')!.products[0]!;
    assert.deepEqual([full.path, full.price, full.promotionalPrice, full.sizes, full.tags], ['/vistaentrenos/product/vo-minha-maior-riqueza', 109.9, 89.9, ['P'], ['avó', 'família']]);
    assert.ok(paths.every((x) => x.startsWith('GET ')), 'só leitura');
    assert.ok(!JSON.stringify(st).includes(TOKEN));

    // Sem escopo de produtos: mantém o índice anterior, registra o problema, promoções seguem.
    productsStatus = 403;
    const again = await s.integration.syncApi(store);
    assert.equal(again.api.data!.products.total, 1);
    assert.match(again.api.data!.problems[0]!.message, /store\.products\.read/);

    // Assistente procura no índice (tag "avó" acha "Vó, Minha Maior Riqueza").
    const { searchIndex } = await import('../src/platform/assistant.ts');
    const found = searchIndex(s.integration.apiData('demo-trilha')!.products, ['camiseta', 'avo'], ['avo']);
    assert.equal(found[0]?.title, 'Vó, Minha Maior Riqueza');
    assert.equal(found[0]?.priceText, 'R$ 89,90');
  } finally {
    s.close();
  }
});
