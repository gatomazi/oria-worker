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

/** Gaveta do carrinho com itens, na estrutura documentada da INK (SIMULADA). */
export function cartFrame(lines: CartLine[], freightGoal = 0): string {
  const count = lines.reduce((n, l) => n + l.quantity, 0);
  const subtotal = lines.reduce((n, l) => n + l.unitCents * l.quantity, 0);
  const items = lines
    .map(
      (l, i) => `<li class="main-list__item" data-replay-simulated="true">
      <a href="${l.path}"><img src="https://gcp-images.majestic.ink.rsvcloud.com/images/product_v2/main_image/0ee2ffd86f9569d8657849bc5b749c0b.webp" alt=""></a>
      <div class="item-details"><p>${l.name}</p><p>${l.variant.split('-')[0]}</p><p>${l.variant.split('-').pop()}</p></div>
      <form data-ink-store--cart-product-id-value="${l.productId}" data-ink-store--cart-product-variant-value="${l.variant}" action="${BASE}/cart/item" method="post">
        <input type="hidden" name="cart_item[id]" value="${i + 1}"><input type="number" name="cart_item[quantity]" value="${l.quantity}">
      </form>
      <div class="price-details"><span>${brl(l.unitCents)}</span></div>
    </li>`,
    )
    .join('');
  const body = lines.length
    ? `<div class="cart-drawer__main"><ul>${items}</ul></div>
       <div class="cart-drawer__footer"><div class="footer-details" data-ink-store--cart-subtotal-value="${(subtotal / 100).toFixed(2)}" data-ink-store--cart-discount-value="0.0"><p>Total</p><p>${brl(subtotal)}</p></div>
       <form id="coupon-form" class="cart-drawer__footer__coupon"><input name="cart[coupon][code]" placeholder="Cupom"></form>
       <form action="${BASE}/cart/checkout_cart_items" data-turbo="false"><button id="checkout-btn" type="button">Finalizar compra</button></form></div>`
    : `<div class="empty-cart"><turbo-frame id="most_sold_frame" src="${BASE}/cart/most_solds?empty_cart=true"></turbo-frame></div>`;
  return `<turbo-frame id="cart"><div data-controller='ink-store--cart ink-store--progress-bar' data-ink-store--progress-bar-max-progress-value='${freightGoal}' data-ink-store--progress-bar-progress-value='${(subtotal / 100).toFixed(2)}'>
    <header class="cart-drawer__header"><p id="quantity-header" data-quantityheader="${count}">Carrinho (${count} produtos)</p><button id="cart-drawer-close" type="button">×</button></header>
    ${body}</div></turbo-frame>`;
}

function addedModal(line: CartLine): string {
  return `<div id="modal-wrapper" class="add-product-modal" role="dialog" style="position:fixed;inset:auto 0 0 0;background:#fff;z-index:50;padding:16px">
    <p>Produto adicionado ao carrinho</p><p>${line.name}</p>
    <div class="add-product-modal__modal-content__footer"><button class="checkout-btn" type="button">Ver carrinho</button><button id="continue-shopping-button" type="button">Continuar comprando</button></div>
    <button id="modal-close-button" type="button">Fechar</button></div>`;
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
            `<turbo-stream action="update" target="last_added_product"><template>${addedModal(line)}</template></turbo-stream>`,
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
