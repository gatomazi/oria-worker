// Réplica gravada de uma loja INK (páginas e frames reais da Vista Entre Nós,
// capturados com GET) para demonstração offline e testes determinísticos.
// Serve como "origem" das lojas demo. Analytics é removido para não gerar
// eventos nas contas da loja real. O carrinho com itens é SIMULADO a partir
// da marcação documentada (não há fixture real de carrinho com itens).
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('../../test/fixtures/ink/', import.meta.url));
const BASE = '/vistaentrenos';

const cache = new Map<string, string>();
function fixture(name: string): string {
  let html = cache.get(name);
  if (html === undefined) {
    html = stripAnalytics(readFileSync(FIXTURES + name, 'utf8'));
    cache.set(name, html);
  }
  return html;
}

/** Remove GTM, gtag, pixel do Facebook, Segment e Konduto. */
export function stripAnalytics(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (tag) =>
      /googletagmanager|gtag\(|fbq\(|connect\.facebook|konduto|segment\.(com|io)|analytics\.load|dataLayer/i.test(tag) ? '' : tag,
    )
    .replace(/<noscript>[\s\S]*?googletagmanager[\s\S]*?<\/noscript>/gi, '')
    .replace(/\sdata-store-fb-pixel-id='[^']*'/g, '')
    .replace(/data-ink-store--segment-write-key-value="[^"]*"/g, 'data-ink-store--segment-write-key-value=""');
}

interface CartLine {
  productId: string;
  name: string;
  variant: string;
  quantity: number;
  unitCents: number;
  path: string;
}

const brl = (c: number) => `R$ ${(c / 100).toFixed(2).replace('.', ',')}`;

/** Gaveta do carrinho com itens, na estrutura REAL capturada na Vista (cart-drawer-com-item.html). Os valores são simulados. */
export function cartFrame(lines: CartLine[], freightGoal = 0): string {
  const count = lines.reduce((n, l) => n + l.quantity, 0);
  const subtotal = lines.reduce((n, l) => n + l.unitCents * l.quantity, 0);
  const sub = (subtotal / 100).toFixed(1);
  const items = lines
    .map(
      (l, i) => `<li class="main-list__item bg-gray-50 bg-white border-b-[0.50px] border-gray-200" data-replay-simulated="true">
  <img src="https://gcp-images.majestic.ink.rsvcloud.com/images/product_v2/main_image/0ee2ffd86f9569d8657849bc5b749c0b.webp" alt="Imagem do produto" class="w-24 h-28">
  <div class="item-wrapper justify-between pe-4"><header><div class="flex flex-row justify-between pt-3">
    <div class="item-details"><p class="text-gray-900 text-xs font-medium pb-2">${l.name}</p><p class="text-xs font-light text-gray-400 pb-0.5"> ${l.variant.split('-')[0]} </p><p class="text-xs font-light text-gray-400"> ${l.variant.split('-').pop()} </p></div>
    <div class="price-details"><div class="price flex flex-col"><span class="text-xs text-right font-medium text-gray-900 pb-1 mb-[10px]">${brl(l.unitCents)}</span></div></div>
  </div></header>
  <div class="item-details__footer"><form data-turbo="true" data-controller="ink-store--cart ink-store--progress-bar" data-ink-store--cart-target="formItem" data-ink-store--cart-product-id-value="${l.productId}" data-ink-store--cart-product-variant-value="${l.variant}" data-ink-store--cart-id-value="cart_item_${i + 1}" action="${BASE}/cart/item" accept-charset="UTF-8" method="post">
    <div id="quantity-buttons" class="item-details__quantity"><input type="hidden" value="${i + 1}" name="cart_item[id]"><input class="quantity-input" type="text" value="${l.quantity}" name="cart_item[quantity]"></div>
  </form></div></div></li>`,
    )
    .join('');
  const body = lines.length
    ? `<div class="cart-drawer__main flex-col bg-gray-50"><ul class="flex flex-col w-full !pb-6">${items}</ul></div>
       <div class="cart-drawer__footer px-4 pb-4">
       <form id="coupon-form" class="flex flex-col gap-4" data-turbo="true" action="${BASE}/cart/coupon" method="post"><div class="cart-drawer__footer__coupon mb-3"><label for="cart_coupon_Cupom">Cupom</label><input placeholder="CUPOM" class="coupon-input reset-input w-full" type="text" name="cart[coupon][code]" id="cart_coupon_code"><button type="button" class="btn-apply" id="apply_coupon_code">Aplicar</button></div></form>
       <div class="footer-details gap-3.5 my-3.5" data-ink-store--cart-discount-value="0.0" data-ink-store--cart-subtotal-value="${sub}" data-ink-store--cart-free-custom-freight-min-cart-value="0" data-ink-store--progress-bar-max-progress-value="${freightGoal}"><ul><li><span>Subtotal</span><span id="amount">${brl(subtotal)}</span></li></ul><div><p>Total</p><p>${brl(subtotal)}</p></div></div>
       <form class="pt-2.5" data-turbo="false" action="${BASE}/cart/checkout_cart_items"><button id="checkout-btn" type="button">Finalizar compra</button></form></div>`
    : `<div class="empty-cart"><turbo-frame id="most_sold_frame" src="${BASE}/cart/most_solds?empty_cart=true"></turbo-frame></div>`;
  return `<turbo-frame id="cart"><div data-controller="ink-store--cart ink-store--progress-bar" data-ink-store--progress-bar-max-progress-value="${freightGoal}" data-ink-store--progress-bar-progress-value="${sub}" class="flex flex-col h-full">
    <div class="cart-drawer__header p-3 bg-gray-50"><div class="top-header"><span>Carrinho <span id="quantity-header" data-quantityheader="${count}">(${count} produto${count > 1 ? 's' : ''})</span></span><button id="cart-drawer-close" type="button">×</button></div></div>
    ${body}</div></turbo-frame>`;
}

/** Modal "Produto adicionado" REAL da Vista (last-added-product.html), entregue como a INK entrega: substituindo o elemento. */
function addedModal(): string {
  return fixture('last-added-product.html').replace(/^<!--[\s\S]*?-->\s*/, '');
}

export function createReplayOrigin(label: string): Server {
  // Carrinho por visitante (cookie) — só nesta réplica.
  const carts = new Map<string, CartLine[]>();
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const p = url.pathname.replace(/\/$/, '') || '/';
    const html = (body: string, type = 'text/html; charset=utf-8', status = 200) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-replay-store': label });
      res.end(req.method === 'HEAD' ? '' : body);
    };
    const sid = /replay_cart=([a-z0-9]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';

    if (req.method === 'POST' && p === `${BASE}/cart`) {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        const id = sid || Math.random().toString(36).slice(2);
        const lines = carts.get(id) ?? [];
        const variant = `${form.get('color') ?? 'Preta'}-${form.get('style') ?? 'Masculino'}-${form.get('size') ?? 'M'}`;
        const productId = url.searchParams.get('product_id') ?? '0';
        const existing = lines.find((l) => l.productId === productId && l.variant === variant);
        const line = existing ?? { productId, name: 'Vó, Minha Maior Riqueza', variant, quantity: 0, unitCents: 10990, path: `${BASE}/product/vo-minha-maior-riqueza` };
        line.quantity += Math.max(1, Number(form.get('quantity') ?? 1));
        if (!existing) lines.push(line);
        carts.set(id, lines);
        res.writeHead(200, { 'content-type': 'text/vnd.turbo-stream.html; charset=utf-8', 'set-cookie': `replay_cart=${id}; Path=/; HttpOnly; SameSite=Lax` });
        res.end(
          `<turbo-stream action="replace" target="cart"><template>${cartFrame(lines)}</template></turbo-stream>` +
            `<turbo-stream action="replace" target="last_added_product"><template>${addedModal()}</template></turbo-stream>`,
        );
      });
      return;
    }
    if (req.method === 'POST' && p === `${BASE}/cart/item`) {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        const lines = carts.get(sid) ?? [];
        const idx = Number(form.get('cart_item[id]')) - 1;
        const q = Number(form.get('cart_item[quantity]'));
        if (lines[idx]) {
          if (q <= 0) lines.splice(idx, 1);
          else lines[idx]!.quantity = q;
        }
        res.writeHead(200, { 'content-type': 'text/vnd.turbo-stream.html; charset=utf-8' });
        res.end(`<turbo-stream action="replace" target="cart"><template>${cartFrame(lines)}</template></turbo-stream>`);
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return html('Método não permitido', 'text/plain; charset=utf-8', 405);

    if (p === '/') {
      res.writeHead(301, { location: BASE });
      return res.end();
    }
    const withCart = (doc: string) => {
      const lines = carts.get(sid);
      return lines?.length ? doc.replace(/<turbo-frame id="cart">[\s\S]*?<\/turbo-frame>\s*<\/div>/, `${cartFrame(lines)}</div>`) : doc;
    };
    if (p === BASE) return html(withCart(fixture('home.html')));
    if (p === `${BASE}/products`) {
      if (url.searchParams.get('search_filter')) return html(withCart(fixture('search-vo.html')));
      if (url.searchParams.get('page') === '2') return html(withCart(fixture('listing-page2.html')));
      return html(withCart(fixture('listing.html')));
    }
    if (/^\/vistaentrenos\/collections\/[a-z0-9-]+$/.test(p)) return html(withCart(fixture('collection-maes.html')));
    if (/^\/vistaentrenos\/product\/[a-z0-9-]+$/.test(p)) return html(withCart(fixture('pdp.html')));
    if (p === `${BASE}/about`) return html(fixture('about.html'));
    if (/\/product_variants$/.test(p)) return html(fixture('pdp-frame-product-variants.html'));
    if (/\/product_promotions$/.test(p)) return html(fixture('pdp-frame-product-promotions.html'));
    if (p === `${BASE}/delivery_estimates`) {
      return url.searchParams.get('postal_code')
        ? html(fixture('delivery-estimates-cep-01001000.turbo-stream.html'), 'text/vnd.turbo-stream.html; charset=utf-8')
        : html(fixture('pdp-frame-delivery-estimates.html'));
    }
    if (p === `${BASE}/recently_viewed_products`) return html(fixture('pdp-frame-recently-viewed.html'));
    if (p === `${BASE}/cart/most_solds`) return html(fixture('cart-frame-most-solds.html'));
    // Avaliações FICTÍCIAS (marcação da INK); as reais da Use Origens ficam só nos testes do parser.
    if (p === `${BASE}/reviews`) return html(fixture('reviews-demo.html'));
    if (/^\/vistaentrenos\/store_review_images\/\d+$/.test(p)) return html(fixture('review-image-demo.turbo-stream.html'), 'text/vnd.turbo-stream.html; charset=utf-8');
    return html('Página não encontrada nesta réplica.', 'text/plain; charset=utf-8', 404);
  });
}
