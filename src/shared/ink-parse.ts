// Leitura das páginas e fragmentos reais da INK (marcação observada nas lojas
// Vista Entre Nós e Use Origens). Usa só a API DOM padrão: funciona no
// navegador (DOMParser, sem executar scripts) e no servidor (jsdom).
// Tudo devolve dados simples; nunca HTML.

export interface CardProduct {
  id: string;
  path: string;
  title: string;
  priceText: string;
  imageUrl: string;
}

export interface Review {
  id: string;
  author: string;
  date: string;
  rating: number;
  text: string;
  verified: boolean;
  photos: string[];
}

export interface ReviewPhoto {
  reviewImageId: string;
  imageUrl: string;
  rating: number | null;
}

export interface CartItem {
  productId: string;
  variant: string;
  name: string;
  quantity: number;
  unitCents: number | null;
  fullCents: number | null;
  path: string;
}

export interface CartState {
  empty: boolean;
  items: CartItem[];
  count: number;
  subtotalCents: number | null;
  discountCents: number | null;
  /** Barra nativa de frete grátis da INK (0 = sem regra configurada). */
  nativeFreightGoalCents: number | null;
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** "R$ 1.109,90" → 110990. */
export function parseBrl(s: string): number | null {
  const m = /R\$\s?([\d.]+),(\d{2})/.exec(s);
  if (!m) return null;
  return Number(m[1]!.replace(/\./g, '')) * 100 + Number(m[2]);
}

export function formatBrl(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const SAFE_IMG = /^https:\/\/(gcp-images\.majestic\.ink\.rsvcloud\.com|mimis-production\.rsvcloud\.com|storage\.googleapis\.com)\//;

/** Só aceita imagens dos CDNs da INK. */
export function inkImage(src: string | null | undefined): string {
  return src && SAFE_IMG.test(src) ? src : '';
}

/** Caminho da própria loja a partir de href (relativo ou absoluto do mesmo domínio). */
export function storeHref(href: string | null | undefined, basePath: string): string {
  if (!href) return '';
  let path = href;
  if (/^https?:\/\//.test(href)) {
    try {
      const u = new URL(href);
      path = u.pathname + u.search;
    } catch {
      return '';
    }
  }
  if (!path.startsWith('/') || path.startsWith('//')) return '';
  if (basePath && !(path === basePath || path.startsWith(`${basePath}/`) || path.startsWith(`${basePath}?`))) return '';
  return path;
}

// ------------------------------------------------------------------ cards

export function parseProductCards(root: ParentNode, basePath: string, scope = '#products'): CardProduct[] {
  const container = (root.querySelector(scope) as ParentNode | null) ?? root;
  const out: CardProduct[] = [];
  const seen = new Set<string>();
  container.querySelectorAll('.card-thumb').forEach((card) => {
    const link = card.querySelector('a.card-thumb__image-v2, a[class^="card-thumb__title"]');
    const path = storeHref(link?.getAttribute('href'), basePath);
    if (!path || !/\/product\/[^/?#]+$/.test(path) || seen.has(path)) return;
    seen.add(path);
    const img = card.querySelector('img[id^="image-product-v2-"]') ?? card.querySelector('img');
    const priceEl = card.querySelector('.card-thumb__prices-v2');
    out.push({
      id: (img?.id ?? '').replace('image-product-v2-', ''),
      path,
      title: text(card.querySelector('[class^="card-thumb__title"]')) || img?.getAttribute('alt') || '',
      priceText: text(priceEl).replace(/\s*\|\s*$/, ''),
      imageUrl: inkImage(img?.getAttribute('src')),
    });
  });
  return out;
}

/** Miniaturas do frame "mais vendidos" (/cart/most_solds). Sem preço. */
export function parseMostSolds(root: ParentNode, basePath: string): CardProduct[] {
  const out: CardProduct[] = [];
  root.querySelectorAll('#most_sold_frame a[href], a[href*="/product/"]').forEach((a) => {
    const path = storeHref(a.getAttribute('href'), basePath);
    if (!path || !/\/product\/[^/?#]+$/.test(path) || out.some((p) => p.path === path)) return;
    const img = a.querySelector('img');
    out.push({ id: (img?.id ?? '').replace('image-', ''), path, title: img?.getAttribute('alt') ?? '', priceText: '', imageUrl: inkImage(img?.getAttribute('src')) });
  });
  return out;
}

/** Links de coleções e listagens do menu da loja (para sugerir no painel). */
export function parseStoreSections(root: ParentNode, basePath: string): { label: string; path: string }[] {
  const out: { label: string; path: string }[] = [];
  root.querySelectorAll('header a[href], #product-sidebar a[href], #collection-sidebar a[href]').forEach((a) => {
    const path = storeHref(a.getAttribute('href'), basePath);
    const label = text(a);
    if (!path || !label || label.length > 60) return;
    if (!/\/collections\/[^/?#]+$|\/products\?product_type=\d+$/.test(path)) return;
    if (!out.some((s) => s.path === path)) out.push({ label, path });
  });
  return out;
}

/** Dados do produto atual (JSON-LD Product e dados da página). */
export function parseProductPage(doc: Document): { name: string; id: string; price: number | null; category: string; image: string } {
  let name = '';
  let id = '';
  let price: number | null = null;
  let category = '';
  let image = '';
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try {
      const data = JSON.parse(s.textContent ?? '');
      for (const item of Array.isArray(data) ? data : [data]) {
        if (item && item['@type'] === 'Product') {
          name ||= String(item.name ?? '');
          id ||= String(item.sku ?? item.productID ?? '');
          image ||= inkImage(Array.isArray(item.image) ? item.image[0] : item.image);
          const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
          if (offer && price === null && Number.isFinite(Number(offer.price))) price = Number(offer.price);
          category ||= String(item.category ?? '');
        }
      }
    } catch {
      // JSON-LD malformado: ignora
    }
  });
  const data = doc.querySelector('[data-ink-store--product-page-price-value]');
  name ||= data?.getAttribute('data-ink-store--product-page-name-value') ?? doc.querySelector('[data-product-name]')?.getAttribute('data-product-name') ?? '';
  category ||= data?.getAttribute('data-ink-store--product-page-category-value') ?? '';
  id ||= doc.querySelector('[data-product-id]')?.getAttribute('data-product-id') ?? '';
  const crumbs = [...doc.querySelectorAll('nav[aria-label="Breadcrumb"] a, .breadcrumb a, ol li a')].map(text).filter(Boolean);
  if (!category && crumbs.length > 1) category = crumbs[crumbs.length - 1]!;
  return { name, id, price, category, image };
}

// -------------------------------------------------------------- avaliações

function countStars(container: Element | null): number {
  if (!container) return 0;
  return container.querySelectorAll('[class*="text-yellow"]').length;
}

/** Avaliações da página /<loja>/reviews (frame store_reviews_frame). */
export function parseReviews(root: ParentNode): { reviews: Review[]; photos: ReviewPhoto[] } {
  const frame = (root.querySelector('#store_reviews_frame') as ParentNode | null) ?? root;
  const photos: ReviewPhoto[] = [];
  frame.querySelectorAll('form[action*="/store_review_images/"]').forEach((form) => {
    const id = /\/store_review_images\/(\d+)/.exec(form.getAttribute('action') ?? '')?.[1];
    const imageUrl = inkImage(form.querySelector('img')?.getAttribute('src'));
    const ratingText = /([0-5](?:[.,]\d)?)/.exec(text(form.querySelector('span')))?.[1];
    if (id && imageUrl && !photos.some((p) => p.reviewImageId === id)) {
      photos.push({ reviewImageId: id, imageUrl, rating: ratingText ? Number(ratingText.replace(',', '.')) : null });
    }
  });

  const reviews: Review[] = [];
  const list = (frame.querySelector('#store_reviews_items') as ParentNode | null) ?? frame;
  list.querySelectorAll('turbo-frame[id^="store-reviews-index-helpful-count-frame-"]').forEach((helpful) => {
    const id = helpful.id.replace('store-reviews-index-helpful-count-frame-', '');
    const card = helpful.closest('.flex.flex-col.md\\:flex-row') ?? helpful.parentElement?.parentElement;
    if (!card || !/^\d+$/.test(id)) return;
    const left = card.firstElementChild;
    const right = card.lastElementChild;
    const author = text(left?.querySelector('p.font-semibold'));
    const date = text(left?.querySelector('p.text-gray-500'));
    const rating = countStars(left?.querySelector('.flex.flex-row.gap-1') ?? null);
    const body = text(right?.querySelector('p.text-base'));
    const verified = /compra verificada/i.test(text(left));
    const reviewPhotos = [...(right?.querySelectorAll('img') ?? [])].map((img) => inkImage(img.getAttribute('src'))).filter(Boolean);
    if (author || body) reviews.push({ id, author, date, rating: Math.min(5, rating), text: body, verified, photos: reviewPhotos });
  });
  return { reviews, photos };
}

// ------------------------------------------------------------------ carrinho

/** Lê o carrinho renderizado pela INK (turbo-frame#cart). null = estrutura desconhecida. */
export interface NativeCoupon {
  code: string;
  /** "Você economiza até R$60,00 na compra" */
  savings: string;
  /** Regras como a INK escreve: "Promoção progressiva", "2 itens - R$20,00 OFF", "Mínimo do carrinho: 2 itens", "Somente primeira compra". */
  rules: string[];
  /** Primeira regra com valor de desconto ("R$10,00 OFF", "10% OFF"), se houver. */
  off: string | null;
  firstPurchase: boolean;
}

/** Cupons que a própria INK mostra no produto (frame product_promotions). */
export function parseProductPromotions(root: ParentNode): NativeCoupon[] {
  const frame = (root.querySelector('#product_promotions_frame') as ParentNode | null) ?? root;
  const out: NativeCoupon[] = [];
  frame.querySelectorAll<HTMLInputElement>('[data-controller~="ink-store--clipboard"] input[type="hidden"]').forEach((input) => {
    const code = (input.getAttribute('value') ?? '').trim();
    const card = input.closest('div.border') ?? input.parentElement?.parentElement?.parentElement;
    if (!/^[A-Za-z0-9_-]{2,40}$/.test(code) || !card || out.some((c) => c.code === code)) return;
    const savings = [...card.querySelectorAll(':scope > span')].map((e) => text(e)).find((t) => /economiza/i.test(t)) ?? '';
    const rules: string[] = [];
    card.querySelectorAll(':scope > ul > li').forEach((li) => {
      const own = [...li.childNodes].filter((n) => !(n.nodeType === 1 && (n as Element).tagName === 'UL')).map((n) => n.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
      if (own) rules.push(own);
      li.querySelectorAll(':scope > ul > li').forEach((sub) => rules.push(text(sub)));
    });
    out.push({ code, savings, rules, off: rules.find((r) => /OFF/i.test(r))?.replace(/^.*?(R\$\s?[\d.,]+|\d+%)\s*OFF.*$/i, '$1 OFF') ?? null, firstPurchase: /primeira compra/i.test(text(card)) });
  });
  return out;
}

export function readCart(root: ParentNode, basePath: string): CartState | null {
  const frame = root.querySelector('.cart-drawer turbo-frame#cart') ?? root.querySelector('turbo-frame#cart');
  if (!frame) return null;
  const progress = frame.querySelector('[data-ink-store--progress-bar-max-progress-value]');
  const goal = progress ? Number(progress.getAttribute('data-ink-store--progress-bar-max-progress-value')) : NaN;
  // Mínimo de frete grátis configurado na INK (aparece no rodapé do carrinho com itens).
  const freeMin = Number(frame.querySelector('[data-ink-store--cart-free-custom-freight-min-cart-value]')?.getAttribute('data-ink-store--cart-free-custom-freight-min-cart-value') ?? NaN);
  const bestGoal = Math.max(Number.isFinite(goal) ? goal : 0, Number.isFinite(freeMin) ? freeMin : 0);
  const nativeFreightGoalCents = Number.isFinite(goal) || Number.isFinite(freeMin) ? Math.round(bestGoal * 100) : null;
  if (frame.querySelector('.empty-cart')) {
    return { empty: true, items: [], count: 0, subtotalCents: 0, discountCents: 0, nativeFreightGoalCents };
  }
  const items: CartItem[] = [];
  frame.querySelectorAll('li.main-list__item').forEach((li) => {
    const form = li.querySelector('form[data-ink-store--cart-product-id-value]');
    const qty = Number((li.querySelector('input[name="cart_item[quantity]"]') as HTMLInputElement | null)?.value ?? NaN);
    const priceBox = li.querySelector('.price-details');
    const full = parseBrl(text(priceBox?.querySelector('del')));
    const spans = [...(priceBox?.querySelectorAll('span') ?? [])].filter((s) => !s.closest('del'));
    const unit = parseBrl(text(spans[spans.length - 1])) ?? parseBrl(text(priceBox));
    const ps = [...li.querySelectorAll('.item-details p')].map(text);
    items.push({
      productId: form?.getAttribute('data-ink-store--cart-product-id-value') ?? '',
      variant: form?.getAttribute('data-ink-store--cart-product-variant-value') ?? '',
      name: ps[0] ?? '',
      quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
      unitCents: unit,
      fullCents: full,
      path: storeHref(li.querySelector('a[href*="/product/"]')?.getAttribute('href'), basePath),
    });
  });
  if (!items.length) return null;
  const footer = frame.querySelector('.footer-details');
  const sub = Number(footer?.getAttribute('data-ink-store--cart-subtotal-value') ?? NaN);
  const disc = Number(footer?.getAttribute('data-ink-store--cart-discount-value') ?? NaN);
  const header = frame.querySelector('[data-quantityheader]') ?? root.querySelector('#quantity-header');
  const headerCount = Number(header?.getAttribute('data-quantityheader') ?? NaN);
  return {
    empty: false,
    items,
    count: Number.isFinite(headerCount) ? headerCount : items.reduce((n, i) => n + i.quantity, 0),
    subtotalCents: Number.isFinite(sub) ? Math.round(sub * 100) : items.every((i) => i.unitCents !== null) ? items.reduce((n, i) => n + i.unitCents! * i.quantity, 0) : null,
    discountCents: Number.isFinite(disc) ? Math.round(disc * 100) : null,
    nativeFreightGoalCents,
  };
}

/** Detalhe de uma foto de avaliação (resposta turbo-stream de /store_review_images/<id>). */
export function parseReviewImage(root: ParentNode): { imageUrl: string; author: string; date: string; rating: number; text: string; verified: boolean; products: string[] } | null {
  const tpl = (target: string) => {
    const t = root.querySelector(`turbo-stream[target="${target}"] template`) as HTMLTemplateElement | null;
    return (t?.content ?? t) as ParentNode | null;
  };
  const image = tpl('image_review');
  const desc = tpl('review_description');
  if (!image || !desc) return null;
  const ps = [...desc.querySelectorAll('p')];
  const author = text(desc.querySelector('p.font-semibold'));
  const date = text(ps.find((p) => /\d{1,2} de \S+ de \d{4}/.test(p.textContent ?? '')));
  const productsP = ps.find((p) => /Produtos comprados/i.test(p.textContent ?? ''));
  const products = [...(productsP?.querySelectorAll('span.underline') ?? [])].map(text).filter(Boolean);
  const body = text(ps.filter((p) => p.classList.contains('text-base')).pop());
  return {
    imageUrl: inkImage(image.querySelector('img')?.getAttribute('src')),
    author,
    date,
    rating: Math.min(5, countStars(desc.querySelector('.flex.flex-row.gap-1'))),
    text: body,
    verified: /compra verificada/i.test(text(desc as unknown as Element)),
    products,
  };
}
