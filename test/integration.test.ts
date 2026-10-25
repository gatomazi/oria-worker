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
