// Módulos reais montados pelo carregador real, em jsdom, sobre páginas gravadas da INK.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { closeAll, configWith, fixture, setup } from './dom-harness.ts';

afterEach(() => closeAll());
import { cartFrame } from '../src/platform/replay-origin.ts';
import { coupon } from './helpers.ts';

const HOME = fixture('home.html');
const PDP = fixture('pdp.html');
const PDP_PATH = '/vistaentrenos/product/vo-minha-maior-riqueza';

// ------------------------------------------------------------ carregador

test('carregador: config ausente, inválida ou fora do ar não toca na página', async () => {
  for (const cfg of [null, { schemaVersion: 2, storeId: 'x', modules: { coupons: { settings: { t: '<b>' } } } }]) {
    const env = setup(HOME, '/vistaentrenos', cfg);
    const before = env.document.body.innerHTML;
    env.run();
    assert.deepEqual(await env.mountedAfter(), []);
    assert.equal(env.document.body.innerHTML, before);
    assert.deepEqual(env.errors, []);
  }
});

test('carregador: só baixa e monta módulos da página e do dispositivo; não duplica; desliga ao atualizar', async () => {
  const cfg = configWith({ coupons: { campaigns: [coupon()], pages: ['home'] }, gallery: {}, share: {} });
  const env = setup(HOME, '/vistaentrenos', cfg);
  env.run();
  env.run(); // script repetido
  assert.deepEqual(await env.mountedAfter(), ['coupons'], 'galeria e compartilhar são de produto');
  assert.equal(env.document.querySelectorAll('[data-pink-module="coupons"]').length, 1);
  env.setConfig(configWith({ gallery: {} }, undefined, 2));
  const st = JSON.parse(JSON.stringify(await env.window.PersonalizacoesInk.refresh()));
  assert.deepEqual(st.mounted, []);
  assert.equal(env.host('coupons'), null, 'interface removida');
  assert.deepEqual(env.errors, []);
});

test('carregador: módulo com falha não derruba os outros', async () => {
  const cfg = configWith({ coupons: { campaigns: [coupon()], pages: ['home'] }, categoryTabs: { tabs: [{ label: 'Mães', path: '/vistaentrenos/collections/maes' }] } });
  const env = setup(HOME, '/vistaentrenos', cfg);
  env.route('/vistaentrenos/collections/', () => {
    throw new Error('rede');
  });
  env.run();
  const mounted = await env.mountedAfter(100);
  assert.ok(mounted.includes('coupons'));
  assert.deepEqual(env.errors, []);
});

// ---------------------------------------------------------------- M01

test('M01: ajusta cabeçalho nativo (cores, menu, busca, comportamento) e desfaz tudo', async () => {
  const cfg = configWith({
    header: { layout: 'logo-esquerda', behavior: 'fixo', benefits: 'ocultar', searchMode: 'barra', searchPlaceholder: 'Busque aqui', menu: [{ label: 'Mães', path: '/vistaentrenos/collections/maes', group: 'Coleções' }, { label: 'Sobre', path: '/vistaentrenos/about', group: '' }] },
  });
  const env = setup(HOME, '/vistaentrenos', cfg);
  const before = env.document.querySelector('header.header')!.outerHTML;
  env.run();
  assert.deepEqual(await env.mountedAfter(), ['header']);
  const header = env.document.querySelector('header.header')!;
  assert.ok(env.document.querySelector('style[data-pink-style="header"]'));
  assert.equal((header.querySelector('.header-benefits') as HTMLElement).style.display, 'none');
  assert.equal(header.querySelector<HTMLInputElement>('#search_filter')!.placeholder, 'Busque aqui');
  const ours = [...header.querySelectorAll('[data-pink-menu] a')].map((a) => a.getAttribute('href'));
  assert.ok(ours.includes('/vistaentrenos/collections/maes') && ours.includes('/vistaentrenos/about'));
  // carrinho e conta continuam no lugar
  assert.ok(header.querySelector('#shopping-cart-menu-desk') && header.querySelector('#shopping-cart-menu-mob'));
  const accountVisible = [...header.querySelectorAll<HTMLElement>('#navbar-list-mobile a[href*="store_sessions"]')].every((a) => a.closest('li')!.style.display !== 'none');
  assert.ok(accountVisible, 'Entrar continua no menu do celular');
  env.window.PersonalizacoesInk.destroy();
  assert.equal(env.document.querySelector('header.header')!.outerHTML, before, 'cabeçalho volta exatamente ao original');
});

// ---------------------------------------------------------------- M02

test('M02: abas com produtos reais da coleção e "Ver todos" acompanhando a aba', async () => {
  const cfg = configWith({ categoryTabs: { tabs: [{ label: 'Mães', path: '/vistaentrenos/collections/maes' }, { label: 'Camisetas', path: '/vistaentrenos/products?product_type=1' }], limit: 4, hideNative: true } });
  const env = setup(HOME, '/vistaentrenos', cfg);
  env.run();
  await env.mountedAfter(120);
  const root = env.shadow('categoryTabs')!;
  assert.equal(root.querySelectorAll('.card').length, 4);
  assert.match(root.querySelector('.card')!.getAttribute('href')!, /^\/vistaentrenos\/product\//);
  assert.equal(root.querySelector('.all')!.getAttribute('href'), '/vistaentrenos/collections/maes');
  (root.querySelectorAll('.tab')[1] as HTMLElement).click();
  await env.tick(80);
  assert.equal(root.querySelector('.all')!.getAttribute('href'), '/vistaentrenos/products?product_type=1');
  assert.equal(root.querySelectorAll('.tab')[1]!.getAttribute('aria-selected'), 'true');
  const shortcut = env.document.querySelector<HTMLElement>('.mb-9 a[href$="product_type=1"]');
  assert.equal(shortcut?.style.display, 'none', 'atalho nativo repetido escondido depois que as abas carregaram');
  env.window.PersonalizacoesInk.destroy();
  assert.notEqual(shortcut?.style.display, 'none', 'volta ao desligar');
});

// ---------------------------------------------------------------- M03

test('M03: miniaturas de todas as fotos; clique aciona só o ponto nativo, sem mexer na variante', async () => {
  const env = setup(PDP, PDP_PATH, configWith({ gallery: { hideBullets: true } }));
  env.run();
  await env.mountedAfter();
  const thumbs = env.shadow('gallery')!.querySelectorAll('button');
  const dots = env.document.querySelectorAll('button[id^="dot-image-"]');
  assert.equal(thumbs.length, dots.length, 'uma miniatura por foto navegável da INK');
  const variant = env.document.querySelector<HTMLInputElement>('#product-variant-id-4976077')!;
  const dot = env.document.querySelector<HTMLElement>('#dot-image-3')!;
  let clicked = 0;
  dot.addEventListener('click', () => clicked++);
  (thumbs[3] as HTMLElement).click();
  assert.equal(clicked, 1);
  assert.equal(variant.value, '-1', 'variante comprada intacta');
  dot.setAttribute('aria-current', 'true');
  await env.tick(10);
  assert.equal(thumbs[3]!.getAttribute('aria-current'), 'true', 'acompanha a foto ativa da INK');
  assert.equal((dot.closest('ul') as HTMLElement).style.display, 'none');
});

// ---------------------------------------------------------------- M04

test('M04: WhatsApp com mensagem e link limpo; copiar link', async () => {
  const env = setup(PDP, `${PDP_PATH}`, configWith({ share: { message: 'Olha: {produto}' } }));
  env.run();
  await env.mountedAfter();
  const wa = env.shadow('share')!.querySelector('a')!.getAttribute('href')!;
  const text = decodeURIComponent(wa.split('text=')[1]!);
  assert.match(text, /^Olha: Camiseta Vó, Minha Maior Riqueza https:\/\/www\.vistaentrenos\.com\.br\/vistaentrenos\/product\/vo-minha-maior-riqueza$/);
  assert.doesNotMatch(text, /\?|utm|__pink/);
});

// ---------------------------------------------------------------- M05

test('M05: abas de campanhas, selo de 1ª compra perto do preço, copiar ≠ aplicar', async () => {
  const cfg = configWith({
    coupons: {
      mode: 'abas',
      pages: ['product'],
      campaigns: [coupon({ code: 'PRIMEIRA10', nearPrice: true, badge: '10% na 1ª compra' }), coupon({ title: 'Frete', code: 'FRETE', firstPurchase: false }), coupon({ title: 'Vencido', code: 'VELHO', endsAt: '2099-01-01T00:00:00-03:00', startsAt: '2098-01-01T00:00:00-03:00' })],
    },
  });
  const env = setup(PDP, PDP_PATH, cfg);
  const writes: string[] = [];
  Object.defineProperty(env.window.navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void writes.push(t) } });
  env.run();
  await env.mountedAfter();
  const root = env.shadow('coupons')!;
  assert.equal(root.querySelectorAll('[role="tab"]').length, 2, 'campanha futura fica de fora');
  assert.equal(env.document.querySelectorAll('[data-pink-badge]').length > 0, true);
  const nearPrice = env.document.querySelector('form[id^="form-product-"] [data-pink-badge]');
  assert.equal(nearPrice?.textContent, '10% na 1ª compra');
  (root.querySelector('.copy') as HTMLElement).click();
  await env.tick(10);
  assert.deepEqual(writes, ['PRIMEIRA10']);
  assert.match(root.textContent ?? '', /Código copiado/);
  assert.doesNotMatch(root.textContent ?? '', /aplicad/i);
});

test('M05: "Usar no carrinho" só preenche o campo de cupom da INK, sem enviar', async () => {
  const page = HOME.replace(/<turbo-frame id="cart">[\s\S]*?<\/turbo-frame>/, cartFrame([{ productId: '1', name: 'Camiseta', variant: 'Preta-Masculino-M', quantity: 1, unitCents: 10990, path: '/vistaentrenos/product/x' }]));
  const env = setup(page, '/vistaentrenos', configWith({ coupons: { campaigns: [coupon({ code: 'USAR10' })], pages: ['home'] } }));
  env.run();
  await env.mountedAfter();
  const use = env.shadow('coupons')!.querySelector<HTMLButtonElement>('.use')!;
  assert.equal(use.hidden, false);
  let submitted = 0;
  env.document.querySelector('#coupon-form')!.addEventListener('submit', () => submitted++);
  use.click();
  assert.equal(env.document.querySelector<HTMLInputElement>('input[name="cart[coupon][code]"]')!.value, 'USAR10');
  assert.equal(submitted, 0, 'quem valida e aplica é a INK');
  assert.deepEqual(env.posts, []);
});

// ---------------------------------------------------------------- M06

test('M06: progresso por peças no carrinho; barra de frete nativa ativa vence a nossa', async () => {
  const line = (q: number) => ({ productId: '1', name: 'Camiseta', variant: 'Preta-Masculino-M', quantity: q, unitCents: 10990, path: '/vistaentrenos/product/x' });
  const tiers = [{ threshold: 2, benefit: 'percentual', amount: 10, label: '10% de desconto' }, { threshold: 300, benefit: 'frete', amount: 0, label: 'Frete grátis' }];
  const cfg = configWith({ cartIncentive: { campaignName: 'Leve mais', measure: 'itens', tiers: tiers.slice(0, 1), showAfterAdd: false } });
  const env = setup(HOME.replace(/<turbo-frame id="cart">[\s\S]*?<\/turbo-frame>/, cartFrame([line(1)])), '/vistaentrenos', cfg);
  env.run();
  await env.mountedAfter();
  const text = () => (env.document.querySelector('.cart-drawer [data-pink-cart-block] [data-pink-module="cartIncentive"]') as any)?.shadowRoot?.textContent ?? '';
  assert.match(text(), /Faltam 1 peça para 10% de desconto/);
  // A INK redesenha o carrinho (adicionou mais uma): o incentivo acompanha.
  env.document.querySelector('turbo-frame#cart')!.outerHTML = cartFrame([line(2)]);
  await env.tick(120);
  assert.match(text(), /Você chegou a 10% de desconto/);
  assert.equal(env.document.querySelectorAll('.cart-drawer [data-pink-module="cartIncentive"]').length, 1, 'sem duplicar');

  const cfg2 = configWith({ cartIncentive: { campaignName: 'Frete', measure: 'valor', tiers: [tiers[1]], showAfterAdd: false } });
  const env2 = setup(HOME.replace(/<turbo-frame id="cart">[\s\S]*?<\/turbo-frame>/, cartFrame([line(1)], 299)), '/vistaentrenos', cfg2);
  env2.run();
  await env2.mountedAfter();
  const t2 = (env2.document.querySelector('.cart-drawer [data-pink-module="cartIncentive"]') as any)?.shadowRoot?.textContent ?? '';
  assert.doesNotMatch(t2, /Faltam .* Frete grátis/, 'barra nativa da INK ativa: a faixa de frete daqui sai');
});

test('M06: após adição confirmada pela INK, mostra incentivo e sugestões reais', async () => {
  const cfg = configWith({ cartIncentive: { campaignName: 'Leve mais', measure: 'itens', tiers: [{ threshold: 2, benefit: 'percentual', amount: 10, label: '10% de desconto' }], showAfterAdd: true, recommendations: 'mais-vendidos', recommendationCount: 3 } });
  const env = setup(PDP, PDP_PATH, cfg);
  env.run();
  await env.mountedAfter();
  env.document.querySelector('#last_added_product')!.innerHTML = '<div id="modal-wrapper" class="add-product-modal">Produto adicionado ao carrinho<div class="add-product-modal__modal-content__footer"><button class="checkout-btn">Ver carrinho</button></div></div>';
  await env.tick(200);
  const block = env.document.querySelector('#modal-wrapper [data-pink-module="cartIncentive"]') as any;
  assert.ok(block, 'bloco dentro do modal nativo');
  const recs = block.shadowRoot.querySelectorAll('.rec');
  assert.equal(recs.length, 3);
  assert.ok([...recs].every((r: Element) => r.getAttribute('href')!.startsWith('/vistaentrenos/product/') && r.getAttribute('href') !== PDP_PATH), 'não sugere a peça atual');
  assert.ok(env.document.querySelector('#modal-wrapper .checkout-btn'), 'finalização nativa continua acessível');
});

// ---------------------------------------------------------------- M07

test('M07: fotos de avaliações reais com nota individual; foto abre o depoimento de origem; sem nota geral', async () => {
  const env = setup(HOME, '/vistaentrenos', configWith({ reviews: { selection: 'com-foto', max: 5, pages: ['home'] } }));
  env.run();
  await env.mountedAfter(150);
  const root = env.shadow('reviews')!;
  const cards = root.querySelectorAll('button.card');
  assert.equal(cards.length, 5);
  assert.doesNotMatch(root.textContent ?? '', /média|\d[.,]\d de 5|avaliações no total/i);
  (cards[0] as HTMLElement).click();
  await env.tick(80);
  const dlg = root.querySelector('dialog')!;
  assert.match(dlg.textContent ?? '', /Cliente \d+\./);
  assert.match(dlg.textContent ?? '', /Produtos comprados: Produto exemplo/);
});

test('M07: loja sem avaliações publicadas não mostra nada', async () => {
  const env = setup(HOME, '/vistaentrenos', configWith({ reviews: { pages: ['home'] } }));
  env.route('/vistaentrenos/reviews', () => new Response('<html><body><turbo-frame id="store_reviews_frame"></turbo-frame></body></html>', { headers: { 'content-type': 'text/html' } }));
  env.run();
  await env.mountedAfter(100);
  assert.equal(env.host('reviews'), null);
});

// ---------------------------------------------------------- M08 / M09

const VIDEOS = [
  { id: 'video000001', title: 'Vídeo A', caption: '', videoUrl: '/__pink/media/0123456789abcdef01234567', posterUrl: '', productPaths: [PDP_PATH] },
  { id: 'video000002', title: 'Vídeo B', caption: '', videoUrl: '/__pink/media/0123456789abcdef01234568', posterUrl: '', productPaths: ['/vistaentrenos/product/outra'] },
];

test('M08: na home, os vídeos escolhidos; no produto, só os vinculados a ele; player abre com a peça', async () => {
  const mut = (c: any) => (c.library.videos = VIDEOS);
  const home = setup(HOME, '/vistaentrenos', configWith({ videoCards: { videos: ['video000001', 'video000002'] } }, mut));
  home.run();
  await home.mountedAfter();
  assert.equal(home.shadow('videoCards')!.querySelectorAll('.card').length, 2);

  const pdp = setup(PDP, PDP_PATH, configWith({ videoCards: { videos: ['video000001'], onProduct: true } }, mut));
  pdp.run();
  await pdp.mountedAfter();
  const cards = pdp.shadow('videoCards')!.querySelectorAll('.card');
  assert.equal(cards.length, 1);
  (cards[0] as HTMLElement).click();
  await pdp.tick(80);
  const player = pdp.document.querySelector('[data-pink-module="video-player"]') as any;
  const video = player.shadowRoot.querySelector('video');
  assert.equal(video.muted, true, 'sem som automático');
  assert.match(player.shadowRoot.textContent, /Camiseta Vó, Minha Maior Riqueza/, 'nome da peça vem da página real');
});

test('M09: mini player respeita o fechamento na sessão e some com o carrinho aberto', async () => {
  const mut = (c: any) => (c.library.videos = VIDEOS);
  const cfg = configWith({ miniPlayer: { videos: ['video000002'], delaySeconds: 0, frequency: 'sessao' } }, mut);
  const env = setup(PDP, PDP_PATH, cfg);
  env.run();
  await env.mountedAfter(120);
  const host = env.host('miniPlayer')!;
  assert.ok(host?.isConnected);
  assert.match(host.shadowRoot!.textContent ?? '', /Vídeo A/, 'no produto, o vídeo da peça tem prioridade');
  env.document.querySelector('.cart-drawer')!.classList.add('open');
  env.window.dispatchEvent(new env.window.Event('resize'));
  await env.tick(50);
  assert.equal(host.style.display, 'none', 'recolhe com o carrinho aberto');
  (host.shadowRoot!.querySelector('.x') as HTMLElement).click();
  assert.equal(env.window.sessionStorage.getItem('pink-mini-closed:loja-teste'), '1');
});

// ---------------------------------------------------------------- M10

test('M10: abre, pergunta ao servidor e mostra produtos e atendimento', async () => {
  const env = setup(HOME, '/vistaentrenos', configWith({ assistant: { knowledge: [{ topic: 'entrega', question: 'Prazo?', answer: 'x', keywords: '' }], suggestions: [{ text: 'Qual o prazo?' }] } }));
  env.route('/__pink/assistant', () => new Response(JSON.stringify({ answer: 'Produção em até 7 dias.', products: [{ title: 'Camiseta', path: '/vistaentrenos/product/x', priceText: 'R$ 99,90', imageUrl: '' }], contact: { label: 'Falar com a loja', url: 'https://wa.me/5561999990000' }, remaining: 4 }), { headers: { 'content-type': 'application/json' } }));
  env.run();
  await env.mountedAfter();
  const root = env.shadow('assistant')!;
  const panel = root.querySelector<HTMLElement>('.panel')!;
  assert.equal(panel.hidden, true, 'fechado por padrão');
  (root.querySelector('.launch') as HTMLElement).click();
  assert.equal(panel.hidden, false);
  (root.querySelector('.chip') as HTMLElement).click();
  await env.tick(60);
  assert.match(root.textContent ?? '', /Produção em até 7 dias/);
  assert.equal(root.querySelector('.prod')!.getAttribute('href'), '/vistaentrenos/product/x');
  assert.match(root.textContent ?? '', /4 pergunta\(s\) restante/);
  const sent = JSON.parse(env.posts.find((p) => p.url === '/__pink/assistant')!.body);
  assert.equal(sent.message, 'Qual o prazo?');
  assert.match(sent.sessionId, /^[a-f0-9]{24}$/);
});

// ---------------------------------------------------------------- M11

test('M11: tabela da modelagem certa e sugestão explicável por medida de peça', async () => {
  const env = setup(PDP, PDP_PATH, configWith({ sizeGuide: { tables: [
    { name: 'Infantil', match: 'infantil', rows: [{ size: '4', width: 34, length: 46 }], note: '' },
    { name: 'Camiseta adulto', match: 'camiseta', rows: [{ size: 'P', width: 50, length: 70 }, { size: 'M', width: 53, length: 72 }, { size: 'G', width: 56, length: 74 }], note: '' },
  ] } }));
  env.loadFrame('product_variants_options_frame', fixture('pdp-frame-product-variants.html'));
  env.run();
  await env.mountedAfter(100);
  const root = env.shadow('sizeGuide')!;
  const link = env.document.querySelector('#open-modal-size');
  assert.equal(env.host('sizeGuide')!.previousSibling, link, 'ao lado do guia nativo da INK');
  assert.match(root.textContent ?? '', /Camiseta adulto/);
  const [w, l] = root.querySelectorAll<HTMLInputElement>('input');
  w!.value = '54';
  l!.value = '72';
  root.querySelector('form')!.dispatchEvent(new env.window.Event('submit', { cancelable: true }));
  assert.match(root.querySelector('.out')!.textContent ?? '', /Mais próximo da sua peça: M \(1 cm mais estreita, mesmo comprimento\)\. Se prefere mais justo: P; mais folgado: G\./);
  assert.match(root.querySelector('.out')!.textContent ?? '', /não uma garantia/);
});

// ---------------------------------------------------------------- M12

test('M12: produção separada e CEP pelo formulário da própria INK', async () => {
  const env = setup(PDP, PDP_PATH, configWith({ delivery: { productionMin: 2, productionMax: 5 } }));
  env.loadFrame('delivery_estimates_frame', fixture('pdp-frame-delivery-estimates.html'));
  let submitted = 0;
  env.window.HTMLFormElement.prototype.requestSubmit = function (this: HTMLFormElement) {
    submitted++;
    assert.equal(this.querySelector<HTMLInputElement>('input[name="postal_code"]')!.value, '01001-000');
    env.document.querySelector('#remaining_delivery_time')!.textContent = 'Entrega entre Quinta, 29 de Outubro e Sexta, 30 de Outubro.';
  };
  env.run();
  await env.mountedAfter(100);
  const root = env.shadow('delivery')!;
  assert.match(root.textContent ?? '', /Produção sob demanda: 2 a 5 dias úteis/);
  const cep = root.querySelector<HTMLInputElement>('input')!;
  cep.value = '01001000';
  cep.dispatchEvent(new env.window.Event('input'));
  root.querySelector('form')!.dispatchEvent(new env.window.Event('submit', { cancelable: true }));
  await env.tick(60);
  assert.equal(submitted, 1);
  assert.match(root.textContent ?? '', /Entrega entre Quinta, 29 de Outubro.*cálculo da INK/);
  assert.deepEqual(env.posts, [], 'não chama endpoint por fora');
});
