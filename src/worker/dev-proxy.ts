// Somente desenvolvimento (ORIGIN_MODE="dev-origin"): o Worker local se passa
// pela loja. Em produção o Worker fica na rota do domínio real e nada disto roda.
//  - Lojas demo: encaminha para a réplica local, sem mexer em nada.
//  - Loja INK real: só GET/HEAD chegam à loja. Se o operador liberou o
//    carrinho no proxy, passam também POST em <base>/cart e <base>/cart/item
//    (nunca checkout, pedidos, login, avaliações ou newsletter).
//  - Links e redirecionamentos para o domínio real voltam para o proxy.
//  - Scripts de analytics da loja são retirados, para não registrar visitas
//    e eventos de teste nas contas reais.
import type { HostInfo } from './index.ts';

const ANALYTICS_SRC = /googletagmanager|google-analytics|connect\.facebook|facebook\.net|konduto|segment\.(com|io)|apis\.google\.com\/js\/platform/i;
const ANALYTICS_INLINE = /googletagmanager|gtag\(|fbq\(|konduto|analytics\.load|dataLayer/i;

function isLocal(host: HostInfo): boolean {
  return /^http:\/\/127\.0\.0\.1:\d+$/.test(host.devOrigin);
}

function cartWriteAllowed(host: HostInfo, method: string, path: string): boolean {
  if (!host.proxyCart || (method !== 'POST' && method !== 'PUT' && method !== 'PATCH')) return false;
  const base = host.basePath.replace(/\/$/, '');
  return path === `${base}/cart` || path === `${base}/cart/item`;
}

export function devOriginRequest(request: Request, host: HostInfo, url: URL): Request | Response {
  const target = new URL(url.pathname + url.search, host.devOrigin);
  if (isLocal(host)) return new Request(target, request);
  const read = request.method === 'GET' || request.method === 'HEAD';
  const cartWrite = cartWriteAllowed(host, request.method, url.pathname);
  if (!read && !cartWrite) {
    return new Response('O proxy local só lê a loja real (e, se liberado, altera o carrinho). Checkout, login e pedidos: use o domínio real.', {
      status: 405,
      headers: { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' },
    });
  }
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('accept-encoding');
  if (host.proxyCart) {
    // A sessão do carrinho precisa dos cookies; a origem precisa reconhecer o próprio domínio (CSRF do Rails).
    const real = new URL(host.devOrigin).origin;
    if (headers.has('origin')) headers.set('origin', real);
    const ref = headers.get('referer');
    if (ref) headers.set('referer', real + new URL(ref).pathname);
  } else {
    for (const h of ['origin', 'referer', 'cookie']) headers.delete(h);
  }
  return new Request(target, { method: request.method, headers, body: read ? null : request.body, redirect: 'manual' });
}

export function rewriteDevResponse(response: Response, host: HostInfo, proxyOrigin: string): Response {
  if (isLocal(host)) return response;
  const real = new URL(host.devOrigin).origin;
  const toProxy = (value: string) => (value.startsWith(real) ? proxyOrigin + value.slice(real.length) : value);

  const headers = new Headers(response.headers);
  const location = headers.get('location');
  if (location) headers.set('location', toProxy(location));
  headers.delete('strict-transport-security');
  if (!host.proxyCart) headers.delete('set-cookie');
  else {
    // Cookies "Secure" valem em http://*.localhost no Chrome; Domain da loja real não valeria aqui.
    const cookies = response.headers.getSetCookie?.() ?? [];
    headers.delete('set-cookie');
    for (const c of cookies) headers.append('set-cookie', c.replace(/;\s*domain=[^;]+/i, ''));
  }
  const rewritten = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  const type = headers.get('content-type') ?? '';
  if (!/^text\/(html|vnd\.turbo-stream\.html)\b/i.test(type)) return rewritten;

  const attr = (name: string) => ({
    element(el: Element) {
      const v = el.getAttribute(name);
      if (v) el.setAttribute(name, toProxy(v));
    },
  });
  return new HTMLRewriter()
    .on('a[href]', attr('href'))
    .on('form[action]', attr('action'))
    .on('script[src]', {
      element(el) {
        if (ANALYTICS_SRC.test(el.getAttribute('src') ?? '')) el.remove();
      },
    })
    .on('script:not([src])', {
      text(t) {
        if (ANALYTICS_INLINE.test(t.text)) t.replace('');
      },
    })
    .on('noscript', {
      element(el) {
        el.remove();
      },
    })
    .on('body', {
      element(el) {
        el.removeAttribute('data-store-fb-pixel-id');
      },
    })
    .on('[data-ink-store--segment-write-key-value]', {
      element(el) {
        el.setAttribute('data-ink-store--segment-write-key-value', '');
      },
    })
    .transform(rewritten);
}
