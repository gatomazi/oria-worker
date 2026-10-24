// Parsers sobre páginas reais gravadas da INK (Vista Entre Nós; avaliações com marcação real da INK, anonimizadas).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { parseBrl, parseMostSolds, parseProductCards, parseProductPage, parseProductPromotions, parseReviewImage, parseReviews, parseStoreSections, readCart } from '../src/shared/ink-parse.ts';
import { cartFrame } from '../src/platform/replay-origin.ts';
import { fixture } from './dom-harness.ts';

const doc = (html: string) => new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document;
const B = '/vistaentrenos';

test('cards de produto: home, listagem, coleção e busca', () => {
  const home = parseProductCards(doc(fixture('home.html')), B);
  assert.equal(home.length, 24);
  assert.deepEqual(Object.keys(home[0]!).sort(), ['id', 'imageUrl', 'path', 'priceText', 'title']);
  assert.match(home[0]!.imageUrl, /^https:\/\/gcp-images\.majestic\.ink\.rsvcloud\.com\//);
  assert.equal(parseProductCards(doc(fixture('collection-maes.html')), B).length, 13);
  assert.ok(parseProductCards(doc(fixture('search-vo.html')), B).length > 0);
  assert.equal(parseProductCards(doc(fixture('home.html')), '/outra-loja').length, 0, 'links de outra loja são ignorados');
});

test('menu, mais vendidos, produto e preço', () => {
  const sections = parseStoreSections(doc(fixture('home.html')), B);
  assert.ok(sections.some((x) => x.path === '/vistaentrenos/collections/maes' && x.label === 'Mães'));
  assert.equal(parseMostSolds(doc(fixture('cart-frame-most-solds.html')), B).length, 6);
  const p = parseProductPage(doc(fixture('pdp.html')));
  assert.equal(p.id, '4976077');
  assert.equal(p.price, 109.9);
  assert.equal(p.category, 'Camiseta');
  assert.equal(parseBrl('R$ 1.109,90'), 110990);
});

test('avaliações: depoimentos, fotos e detalhe da foto (marcação real da INK)', () => {
  const r = parseReviews(doc(fixture('reviews-ink-anonimizado.html')));
  assert.equal(r.reviews.length, 5);
  assert.equal(r.reviews[0]!.rating, 5);
  assert.ok(r.reviews.every((x) => x.author && x.date));
  assert.equal(r.photos.length, 33);
  const d = parseReviewImage(doc(fixture('review-image-ink-anonimizado.turbo-stream.html')));
  assert.match(d?.author ?? '', /^Cliente \d+\.$/);
  assert.deepEqual(d?.products, ['Produto exemplo', 'Produto exemplo', 'Produto exemplo']);
});

test('cupons nativos da INK no produto (frame product_promotions): código, regras, faixas e 1ª compra', () => {
  const cs = parseProductPromotions(doc(fixture('pdp-frame-product-promotions-com-cupons.html')));
  assert.deepEqual(cs.map((c) => c.code), ['LEVEMAISEXEMPLO', 'PRIMEIRAEXEMPLO']);
  assert.deepEqual(cs[0]!.rules, ['Promoção progressiva', '2 itens - R$20,00 OFF', '3 itens - R$60,00 OFF', 'Mínimo do carrinho: 2 itens']);
  assert.equal(cs[0]!.savings, 'Você economiza até R$60,00 na compra');
  assert.equal(cs[0]!.firstPurchase, false);
  assert.equal(cs[1]!.firstPurchase, true);
  assert.equal(cs[1]!.off, 'R$10,00 OFF');
  assert.deepEqual(parseProductPromotions(doc(fixture('pdp-frame-product-promotions.html'))), [], 'Vista: sem cupons nativos');
});

test('carrinho com item: marcação REAL da INK (Vista, capturada pelo proxy)', () => {
  const cart = readCart(doc(fixture('cart-drawer-com-item.html')), B);
  assert.equal(cart?.empty, false);
  assert.equal(cart?.count, 1);
  assert.equal(cart?.subtotalCents, 10990);
  assert.equal(cart?.discountCents, 0);
  assert.deepEqual({ ...cart!.items[0] }, { productId: '4976077', variant: 'Preta-Masculino-M', name: 'Vó, Minha Maior Riqueza', quantity: 1, unitCents: 10990, fullCents: null, path: '' });
  assert.ok(doc(fixture('cart-drawer-com-item.html')).querySelector('input[name="cart[coupon][code]"]'), 'campo de cupom da INK existe com item no carrinho');
});

test('carrinho: vazio (real) e com itens (réplica na estrutura real)', () => {
  const empty = readCart(doc(fixture('home.html')), B);
  assert.deepEqual({ empty: empty?.empty, goal: empty?.nativeFreightGoalCents }, { empty: true, goal: 0 });
  const full = readCart(doc(`<div class="cart-drawer">${cartFrame([{ productId: '1', name: 'X', variant: 'Preta-Masculino-M', quantity: 2, unitCents: 10990, path: '/vistaentrenos/product/x' }])}</div>`), B);
  assert.equal(full?.count, 2);
  assert.equal(full?.subtotalCents, 21980);
  assert.equal(full?.items[0]?.productId, '1', 'como na INK real: o item traz o id do produto, sem link');
  assert.equal(readCart(doc('<div></div>'), B), null, 'estrutura desconhecida: null');
});
