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
  const thumbs = env.shadow('gallery')!.querySelectorAll('button.thumb');
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
  const css = env.shadow('gallery')!.querySelector('style')!.textContent!;
  assert.match(css, /\.thumbs\{[^}]*display:flex;overflow-x:auto/, 'padrão: uma linha que rola de lado');
});

test('M03: em grade, todas as miniaturas à mostra (várias linhas)', async () => {
  const env = setup(PDP, PDP_PATH, configWith({ gallery: { layout: 'grade' } }));
  env.run();
  await env.mountedAfter();
  const css = env.shadow('gallery')!.querySelector('style')!.textContent!;
  assert.match(css, /display:grid;grid-template-columns:repeat\(auto-fill/);
  assert.doesNotMatch(css, /overflow-x:auto/);
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

test('M05 (produto em "bloco"): abas de campanhas, selo de 1ª compra perto do preço, copiar ≠ aplicar', async () => {
  const cfg = configWith({
    coupons: {
      mode: 'abas',
      productStyle: 'bloco',
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

test('M05: selo nos cards no topo da foto (esquerda por padrão, direita) ou abaixo do preço', async () => {
  for (const [place, check] of [
    [undefined, (b: HTMLElement) => b.parentElement!.querySelector('.card-thumb__image-v2') !== null && b.style.left === '8px'],
    ['foto-direita', (b: HTMLElement) => b.parentElement!.querySelector('.card-thumb__image-v2') !== null && b.style.right === '8px'],
    ['abaixo-preco', (b: HTMLElement) => b.previousElementSibling?.classList.contains('card-thumb__prices-v2') === true],
  ] as const) {
    const cfg = configWith({ coupons: { pages: ['home'], ...(place ? { cardBadge: place } : {}), campaigns: [coupon({ code: 'PRIMEIRA10', nearPrice: true, badge: '10% na 1ª compra' })] } });
    const env = setup(HOME, '/vistaentrenos', cfg);
    env.run();
    await env.mountedAfter();
    const badges = [...env.document.querySelectorAll<HTMLElement>('.card-thumb [data-pink-badge]')];
    assert.ok(badges.length > 0, `${place}: há selos`);
    assert.ok(badges.every(check), `${place ?? 'padrão'}: posição`);
  }
});

test('M05: no produto, abas compactas logo abaixo do preço — uma por código, teclado, copiar', async () => {
  const cfg = configWith({
    coupons: {
      mode: 'unico',
      pages: ['home', 'product'],
      productTitle: 'Quer cupom? Toma!',
      campaigns: [
        coupon({ title: 'Leve 2, ganhe 10%', description: 'Na compra de duas peças', code: 'DOSE10' }),
        coupon({ title: '10% na primeira compra', code: 'PRIMEIRA10', firstPurchase: true, nearPrice: true, badge: '10% na 1ª compra' }),
        coupon({ title: 'Futuro', code: 'FUTURO', startsAt: '2098-01-01T00:00:00-03:00', endsAt: '2099-01-01T00:00:00-03:00' }),
      ],
    },
  });
  const env = setup(PDP, PDP_PATH, cfg);
  const writes: string[] = [];
  Object.defineProperty(env.window.navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void writes.push(t) } });
  env.run();
  await env.mountedAfter();
  const host = env.document.querySelector('[data-pink-coupon-tabs]')!;
  assert.ok(host, 'abas no produto');
  assert.equal(env.document.querySelectorAll('[data-pink-module="coupons"]:not([data-pink-badge])').length, 1, 'sem o bloco grande no produto');
  assert.ok(host.closest('form[id^="form-product-"]'), 'dentro da área de compra');
  assert.ok(host.previousElementSibling?.querySelector('p.text-4xl') || host.previousElementSibling?.matches('p.text-4xl'), 'logo abaixo do preço');
  assert.equal(env.document.querySelector('form[id^="form-product-"] [data-pink-badge]'), null, 'sem selo repetido no produto: as abas já estão junto ao preço');
  const root = host.shadowRoot!;
  assert.match(root.textContent ?? '', /Quer cupom\? Toma!/);
  const tabs = [...root.querySelectorAll<HTMLElement>('[role="tab"]')];
  assert.deepEqual(tabs.map((t) => t.textContent), ['DOSE10', 'PRIMEIRA10'], 'uma aba por código vigente, mesmo no modo "único"');
  const panels = [...root.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
  assert.deepEqual(panels.map((p) => p.hidden), [false, true]);
  tabs[0]!.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  assert.deepEqual(panels.map((p) => p.hidden), [true, false]);
  assert.equal(tabs[1]!.getAttribute('aria-selected'), 'true');
  assert.match(panels[1]!.textContent ?? '', /10% na primeira compra.*Só na primeira compra/);
  panels[1]!.querySelector<HTMLElement>('.copy')!.click();
  await env.tick(10);
  assert.deepEqual(writes, ['PRIMEIRA10']);
  assert.equal(panels[1]!.querySelector('.copy')!.textContent, 'Copiado');
  assert.match(root.textContent ?? '', /Código copiado/);
  assert.doesNotMatch(root.textContent ?? '', /aplicad/i);
});

test('M05: no produto, um cupom só vira um rótulo com o código (sem abas)', async () => {
  const env = setup(PDP, PDP_PATH, configWith({ coupons: { pages: ['product'], campaigns: [coupon({ code: 'UNICO10' })] } }));
  env.run();
  await env.mountedAfter();
  const root = env.document.querySelector('[data-pink-coupon-tabs]')!.shadowRoot!;
  assert.equal(root.querySelectorAll('[role="tab"]').length, 0);
  assert.equal(root.querySelector('span.tab')!.textContent, 'UNICO10');
  assert.equal(root.querySelectorAll('.panel').length, 1);
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

test('M06: participação por coleção casa pelo id do produto (o item do carrinho da INK não tem link)', async () => {
  const { computeProgress } = await import('../src/client/modules/cart-incentive.ts');
  const { readCart } = await import('../src/shared/ink-parse.ts');
  const { JSDOM, VirtualConsole } = await import('jsdom');
  const cart = readCart(new JSDOM(fixture('cart-drawer-com-item.html'), { virtualConsole: new VirtualConsole() }).window.document, '/vistaentrenos');
  const tiers = [{ threshold: 1, benefit: 'percentual' as const, amount: 5, label: '5%' }];
  assert.equal(computeProgress({ measure: 'itens', tiers }, cart, new Set(['id:4976077']), false).current, 1);
  assert.equal(computeProgress({ measure: 'itens', tiers }, cart, new Set(['id:999']), false).current, 0);
});

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

test('M06: após adição confirmada pela INK (modal real que SUBSTITUI o elemento), mostra incentivo e sugestões reais', async () => {
  const cfg = configWith({ cartIncentive: { campaignName: 'Leve mais', measure: 'itens', tiers: [{ threshold: 2, benefit: 'percentual', amount: 10, label: '10% de desconto' }], showAfterAdd: true, recommendations: 'mais-vendidos', recommendationCount: 3 } });
  const env = setup(PDP, PDP_PATH, cfg);
  env.run();
  await env.mountedAfter();
  // Como a INK faz: turbo-stream "replace" troca o #last_added_product por um turbo-frame com o modal.
  const fresh = new env.window.DOMParser().parseFromString(fixture('last-added-product.html'), 'text/html').querySelector('turbo-frame#last_added_product');
  env.document.querySelector('#last_added_product')!.replaceWith(env.document.importNode(fresh, true));
  env.document.dispatchEvent(new env.window.Event('turbo:before-stream-render'));
  await env.tick(250);
  const block = env.document.querySelector('#modal-wrapper [data-pink-module="cartIncentive"]') as any;
  assert.ok(block, 'bloco dentro do modal nativo');
  const recs = block.shadowRoot.querySelectorAll('.rec');
  assert.equal(recs.length, 3);
  assert.ok([...recs].every((r: Element) => r.getAttribute('href')!.startsWith('/vistaentrenos/product/') && r.getAttribute('href') !== PDP_PATH), 'não sugere a peça atual');
  assert.ok(env.document.querySelector('#modal-wrapper .checkout-btn'), 'finalização nativa continua acessível');
});

test('M01: sugestões na busca nativa — peças da busca da loja, vazio e erro, Enter segue para a INK', async () => {
  const env = setup(HOME, '/vistaentrenos', configWith({ header: { instantSearch: true } }));
  let mode: 'ok' | 'vazio' | 'erro' = 'ok';
  env.route('/vistaentrenos/products?search_filter=', () =>
    mode === 'erro' ? new Response('x', { status: 500 }) : new Response(mode === 'ok' ? fixture('search-vo.html') : '<html><body></body></html>', { headers: { 'content-type': 'text/html' } }),
  );
  env.run();
  await env.mountedAfter();
  const input = env.document.querySelector<HTMLInputElement>('#search_filter')!;
  const panel = () => env.document.querySelector('[data-pink-search]')!.shadowRoot!.querySelector('.panel')!;
  const type = async (v: string) => {
    input.value = v;
    input.dispatchEvent(new env.window.Event('input'));
    await env.tick(400);
  };
  await type('v');
  assert.equal((panel() as HTMLElement).hidden, true, 'com 1 letra não busca');
  await type('vó');
  const items = [...panel().querySelectorAll('a.item')];
  assert.ok(items.length > 0 && items.length <= 6);
  const titles = items.map((a) => a.querySelector('.t')!.textContent);
  assert.equal(new Set(titles).size, titles.length, 'sem nomes repetidos');
  assert.ok(items.every((a) => a.getAttribute('href')!.startsWith('/vistaentrenos/product/')));
  assert.equal(panel().querySelector('a.all')!.getAttribute('href'), '/vistaentrenos/products?search_filter=v%C3%B3');
  assert.equal(input.getAttribute('aria-expanded'), 'true');
  mode = 'vazio';
  await type('xyzw');
  assert.match(panel().textContent ?? '', /Nada encontrado para “xyzw”/);
  mode = 'erro';
  await type('qwer');
  assert.match(panel().textContent ?? '', /Não deu para buscar agora/);
  input.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal((panel() as HTMLElement).hidden, true);
  env.window.PersonalizacoesInk.destroy();
  assert.equal(env.document.querySelector('[data-pink-search]'), null, 'desligar remove o painel');
  assert.equal(input.getAttribute('autocomplete'), null, 'campo volta ao original');
});

// ---------------------------------------------------------------- M07

test('M05: cupons da INK (frame lazy, ainda não carregado): painel aparece na hora, os da INK chegam depois nas abas, sem repetir código; quadro nativo some', async () => {
  const cfg = configWith({ coupons: { mode: 'lista', inkCoupons: true, pages: ['product'], campaigns: [coupon({ code: 'LEVEMAISEXEMPLO', title: 'Do painel' })] } });
  const env = setup(PDP, PDP_PATH, cfg);
  // Um card de outro produto na página (vitrine de recomendações).
  env.document.body.insertAdjacentHTML('beforeend', '<div class="card-thumb"><div class="card-thumb__prices-v2">R$ 99,90</div></div>');
  const frame = env.document.querySelector('#product_promotions_frame')!;
  assert.equal(frame.getAttribute('loading'), 'lazy');
  assert.equal(frame.hasAttribute('complete'), false);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  env.route('/vistaentrenos/products/4976077/product_promotions', async () => {
    await gate;
    return new Response(fixture('pdp-frame-product-promotions-com-cupons.html'), { headers: { 'content-type': 'text/html' } });
  });
  env.run();
  await env.mountedAfter(100);
  assert.match(env.shadow('coupons')!.textContent ?? '', /Do painel/, 'cupom do painel não espera a INK');
  assert.doesNotMatch(env.shadow('coupons')!.textContent ?? '', /PRIMEIRAEXEMPLO/);
  release();
  await env.tick(150);
  const root = env.shadow('coupons')!;
  const text = root.textContent ?? '';
  assert.match(text, /Do painel/);
  assert.deepEqual([...root.querySelectorAll('[role="tab"]')].map((t) => t.textContent), ['LEVEMAISEXEMPLO', 'PRIMEIRAEXEMPLO'], 'código do painel não se repete');
  assert.match(text, /Primeira compra: R\$10,00 OFF/);
  assert.match(text, /Regras da loja: R\$10,00 OFF; Somente primeira compra\./);
  assert.equal(env.document.querySelectorAll('[data-pink-badge]').length, 0, 'nenhum selo: nem no card de outro produto, nem repetido junto às abas');
  assert.equal(frame.getAttribute('style')?.includes('display: none') || (frame as HTMLElement).style.display === 'none', true, 'quadro nativo da INK escondido (já está nas abas)');
  assert.equal(env.document.querySelectorAll('[data-pink-module="coupons"]:not([data-pink-badge])').length, 1, 'um quadro só');
  env.window.PersonalizacoesInk.destroy();
  assert.notEqual((frame as HTMLElement).style.display, 'none', 'desligar devolve o quadro nativo');
});

test('M05: só cupons da INK, mas a loja não tem nenhum: nada aparece', async () => {
  const env = setup(PDP, PDP_PATH, configWith({ coupons: { inkCoupons: true, pages: ['product'], campaigns: [] } }));
  env.route('/vistaentrenos/products/4976077/product_promotions', () => new Response(fixture('pdp-frame-product-promotions.html'), { headers: { 'content-type': 'text/html' } }));
  env.run();
  await env.mountedAfter(150);
  assert.equal(env.host('coupons'), null);
});

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

test('M07: nota mínima tira avaliação baixa da vitrine (padrão 4★); "todas" mostra', async () => {
  // Página de avaliações real com só as últimas fotos (a 2★ está entre elas).
  const { JSDOM, VirtualConsole } = await import('jsdom');
  const page = new JSDOM(fixture('reviews-ink-anonimizado.html'), { virtualConsole: new VirtualConsole() }).window.document;
  [...page.querySelectorAll('form[action*="/store_review_images/"]')].slice(0, -8).forEach((f) => f.remove());
  const html = page.documentElement.outerHTML;
  const count = async (minRating: string) => {
    const env = setup(HOME, '/vistaentrenos', configWith({ reviews: { selection: 'com-foto', max: 20, pages: ['home'], minRating } }));
    env.route('/vistaentrenos/reviews', () => new Response(html, { headers: { 'content-type': 'text/html' } }));
    env.run();
    await env.mountedAfter(150);
    const labels = [...env.shadow('reviews')!.querySelectorAll('button.card')].map((c) => c.getAttribute('aria-label'));
    closeAll();
    return labels;
  };
  const def = await count('4');
  assert.ok(def.length > 0 && def.every((l) => /nota 5/.test(l ?? '')), 'só 4★ ou mais');
  assert.ok((await count('1')).some((l) => /nota 2/.test(l ?? '')), 'com "todas", a 2★ aparece');
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

test('M11: link nativo de medidas ligado ao formulário por form= (fora do <form>): guia fica ao lado dele', async () => {
  const env = setup(PDP, PDP_PATH, configWith({ sizeGuide: { tables: [{ name: 'Camiseta adulto', match: 'camiseta', rows: [{ size: 'M', width: 53, length: 72 }], note: '' }] } }));
  env.loadFrame('product_variants_options_frame', fixture('pdp-frame-product-variants.html'));
  const link = env.document.querySelector('#open-modal-size')!;
  const form = link.closest('form')!;
  link.setAttribute('form', form.id);
  form.after(link); // como em lojas do layout clássico
  env.run();
  await env.mountedAfter(100);
  assert.equal(env.host('sizeGuide')!.previousSibling, link);
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
  assert.match(root.textContent ?? '', /Entrega entre 29\/10 e 30\/10\.Para o CEP 01001-000/);
  assert.doesNotMatch(root.textContent ?? '', /INK/, 'o cliente vê só o cálculo');
  assert.deepEqual(env.posts, [], 'não chama endpoint por fora');
});

// ---------------------------------------------------------------- M13

test('M13: aviso de cookies nativo com a cara da loja; texto trocado mantém o link; desmontar devolve o original', async () => {
  const env = setup(HOME, '/vistaentrenos', configWith({ cookieNotice: { message: 'Usamos cookies para lembrar seu carrinho.', buttonLabel: 'Entendi' } }));
  const banner = env.document.querySelector<HTMLElement>('.cookie-acceptance')!;
  const original = banner.innerHTML;
  env.run();
  assert.deepEqual(await env.mountedAfter(), ['cookieNotice']);
  assert.ok(banner.hasAttribute('data-pink-cookie'));
  assert.ok(env.document.querySelector('style[data-pink-style="cookieNotice"]'));
  assert.match(banner.querySelector('p')!.textContent!.trim(), /^Usamos cookies para lembrar seu carrinho\. Política de Privacidade\.$/);
  assert.equal(banner.querySelector('a')!.getAttribute('href'), '/vistaentrenos/terms/privacy_policy', 'link da INK fica');
  assert.equal(banner.querySelector('button')!.textContent, 'Entendi');
  assert.equal(banner.querySelector('button')!.getAttribute('data-action'), 'click->ink-store--cookie-acceptance#accept', 'o aceite continua sendo da INK');
  env.setConfig(configWith({ share: {} }, undefined, 2));
  assert.deepEqual(JSON.parse(JSON.stringify(await env.window.PersonalizacoesInk.refresh())).mounted, []);
  assert.equal(banner.innerHTML, original);
  assert.ok(!banner.hasAttribute('data-pink-cookie'));
  assert.equal(env.document.querySelector('style[data-pink-style="cookieNotice"]'), null);
});

test('M12: datas do prazo em DD/MM, com ou sem dia da semana; o resto do texto fica', async () => {
  const { deliveryText } = await import('../src/client/modules/delivery.ts');
  assert.equal(
    deliveryText('Entrega entre Sexta, 30 de Outubro e Sábado, 31 de Outubro . Comprando dentro das próximas 16 horas e 34 minutos.'),
    'Entrega entre 30/10 e 31/10. Comprando dentro das próximas 16 horas e 34 minutos.',
  );
  assert.equal(deliveryText('Receba até segunda-feira, 2 de março de 2027'), 'Receba até 02/03');
  assert.equal(deliveryText('Entrega em 5 dias úteis'), 'Entrega em 5 dias úteis');
});
