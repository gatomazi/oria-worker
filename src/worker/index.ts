// Adaptador Cloudflare Worker. Encontra a página da loja e decide se insere
// o carregador; não conhece o conteúdo dos módulos.
//  - Loja resolvida pelo host (cadastro no serviço; cache curto; falha = página intacta).
//  - Injeta só em GET 200 text/html (sem Turbo-Frame/Range) e só se algum módulo
//    publicado roda naquele tipo de página. Senão, devolve a resposta original.
//  - Rotas próprias em /__pink/* (carregador, configuração, prévia, mídia, assistente).
//  - Prévia: só com ?__pink_preview=<token>; o rascunho é conferido no serviço.
import { classifyPage, hasModuleFor, parsePublicConfig, type PublicConfig } from '../shared/registry.ts';
import '../shared/modules/index.ts';
import { devOriginRequest, rewriteDevResponse } from './dev-proxy.ts';

interface Env {
  CONFIG_SERVICE_URL: string;
  /** "dev-origin": proxy local para a origem cadastrada. "passthrough": rota na frente da origem real. */
  ORIGIN_MODE?: string;
  CONFIG_TIMEOUT_MS?: string;
  /** Origem do painel, a única autorizada a enquadrar a prévia. */
  ADMIN_ORIGIN?: string;
}

export interface HostInfo {
  storeId: string;
  basePath: string;
  devOrigin: string;
  kind: string;
  active: boolean;
  proxyCart: boolean;
  turbo: boolean;
}

const MARKER_ATTR = 'data-pink-loader';
const PREVIEW_PARAM = '__pink_preview';
const hostCache = new Map<string, { at: number; value: HostInfo | null }>();

async function resolveHost(hostname: string, env: Env): Promise<HostInfo | null> {
  const hit = hostCache.get(hostname);
  if (hit && Date.now() - hit.at < (hit.value ? 15_000 : 5_000)) return hit.value;
  let value: HostInfo | null = null;
  try {
    const res = await fetch(`${env.CONFIG_SERVICE_URL}/api/v1/hosts/${encodeURIComponent(hostname)}`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) value = (await res.json()) as HostInfo;
  } catch {
    value = null;
  }
  hostCache.set(hostname, { at: Date.now(), value });
  return value;
}

// Configuração publicada: o serviço é a fonte única e é consultado a CADA página, para que
// publicar, restaurar, desligar módulo ou retirar liberação valha já na próxima navegação.
// Para não baixar o mesmo conteúdo de novo, o Worker guarda a última resposta (por isolate)
// e pergunta com If-None-Match: sem mudança, o serviço responde 304 sem corpo.
const configCache = new Map<string, { etag: string; config: PublicConfig }>();

async function loadPublicConfig(storeId: string, env: Env): Promise<PublicConfig | null> {
  const cached = configCache.get(storeId);
  try {
    const res = await fetch(`${env.CONFIG_SERVICE_URL}/api/v1/stores/${storeId}/config`, {
      headers: cached ? { 'if-none-match': cached.etag } : {},
      signal: AbortSignal.timeout(Number(env.CONFIG_TIMEOUT_MS ?? 1500)),
    });
    if (res.status === 304 && cached) return cached.config;
    if (!res.ok) {
      // 404: não publicada, pausada ou sem módulos aplicáveis. A página segue nativa.
      configCache.delete(storeId);
      return null;
    }
    const config = parsePublicConfig(await res.json(), storeId);
    const etag = res.headers.get('etag');
    if (config && etag) configCache.set(storeId, { etag, config });
    else configCache.delete(storeId);
    return config;
  } catch {
    // Serviço fora ou lento: nada é injetado (sem servir uma versão que pode ter sido desligada).
    return null;
  }
}

/** Arquivos do carregador: os módulos têm hash no nome (imutáveis); guardados no cache do edge. */
async function clientFile(request: Request, file: string, env: Env): Promise<Response> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const key = new Request(new URL(`/__pink/client/${file}`, request.url).toString(), { method: 'GET' });
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const res = await proxyService(env, `/client/${file}`);
  if (cache && res.ok && /public/.test(res.headers.get('cache-control') ?? '')) await cache.put(key, res.clone());
  return res;
}

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

function isInjectable(request: Request, response: Response): boolean {
  return (
    request.method === 'GET' &&
    response.status === 200 &&
    /^text\/html\b/i.test(response.headers.get('content-type') ?? '') &&
    !request.headers.has('turbo-frame') &&
    !request.headers.has('x-pink-fetch') &&
    !request.headers.has('range') &&
    !request.headers.has('upgrade')
  );
}

function injectLoader(response: Response, version: number, attrs: Record<string, string>): Response {
  let present = false;
  const extra = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${v.replace(/[^A-Za-z0-9:/._\-]/g, '')}"`)
    .join('');
  const tag = `<script type="module" src="/__pink/client/loader.js?v=${version}" ${MARKER_ATTR}="${version}"${extra}></script>`;
  const rewritten = new HTMLRewriter()
    .on(`script[${MARKER_ATTR}]`, {
      element() {
        present = true;
      },
    })
    .on('body', {
      element(el) {
        el.onEndTag((end) => {
          if (!present) {
            end.before(tag, { html: true });
            present = true;
          }
        });
      },
    })
    .transform(response);
  const headers = new Headers(rewritten.headers);
  headers.set('x-pink-loader', String(version));
  return new Response(rewritten.body, { status: rewritten.status, statusText: rewritten.statusText, headers });
}

async function proxyService(env: Env, path: string, init?: RequestInit): Promise<Response> {
  try {
    const res = await fetch(`${env.CONFIG_SERVICE_URL}${path}`, { ...init, signal: AbortSignal.timeout(20_000) });
    const headers = new Headers();
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
      const v = res.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set('x-content-type-options', 'nosniff');
    return new Response(res.body, { status: res.status, headers });
  } catch {
    return json(503, { error: 'unavailable' });
  }
}

/** Rotas próprias do produto, sempre tratadas antes do proxy da loja. */
async function ownRoute(request: Request, url: URL, host: HostInfo, env: Env): Promise<Response> {
  const p = url.pathname.slice('/__pink/'.length);
  const id = host.storeId;
  const client = /^client\/([A-Za-z0-9-]+(?:\/[A-Za-z0-9-]+)?\.js)$/.exec(p);
  if (client && request.method === 'GET') return clientFile(request, client[1]!, env);
  if (p === 'config.json' && request.method === 'GET') {
    const config = await loadPublicConfig(id, env);
    return config ? json(200, config) : json(404, { error: 'no_applicable_config' });
  }
  if (p === 'preview-config.json' && request.method === 'GET') {
    const token = url.searchParams.get('token') ?? '';
    return proxyService(env, `/api/v1/stores/${id}/preview-config?token=${encodeURIComponent(token)}`);
  }
  const media = /^media\/([a-f0-9]{24})$/.exec(p);
  if (media && (request.method === 'GET' || request.method === 'HEAD')) {
    const headers: Record<string, string> = {};
    const range = request.headers.get('range');
    if (range) headers.range = range;
    return proxyService(env, `/api/v1/stores/${id}/media/${media[1]}`, { method: request.method, headers });
  }
  if (p === 'assistant' && request.method === 'POST') {
    const body = await request.text();
    if (body.length > 4096) return json(413, { error: 'too_large' });
    return proxyService(env, `/api/v1/stores/${id}/assistant`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  }
  return json(404, { error: 'not_found' });
}

async function fetchOrigin(request: Request, host: HostInfo, env: Env, url: URL): Promise<Response> {
  if (env.ORIGIN_MODE !== 'dev-origin') return fetch(request);
  const req = devOriginRequest(request, host, url);
  if (req instanceof Response) return req;
  return rewriteDevResponse(await fetch(req), host, url.origin);
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const host = await resolveHost(url.hostname, env);
  if (!host || !host.active) {
    if (env.ORIGIN_MODE === 'dev-origin') {
      return new Response('Host não cadastrado (ou loja pausada) nesta instalação local.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    return fetch(request);
  }
  if (url.pathname.startsWith('/__pink/')) return ownRoute(request, url, host, env);

  // Prévia: o parâmetro não vai para a origem.
  const previewToken = url.searchParams.get(PREVIEW_PARAM);
  let originReq = request;
  if (previewToken !== null) {
    const clean = new URL(url);
    clean.searchParams.delete(PREVIEW_PARAM);
    originReq = new Request(clean, request);
  }

  const response = await fetchOrigin(originReq, host, env, new URL(originReq.url));
  if (!isInjectable(request, response)) return response;

  if (previewToken !== null) {
    if (!/^[A-Za-z0-9._-]{20,200}$/.test(previewToken)) return response;
    const injected = injectLoader(response, 0, { 'data-pink-preview': previewToken, 'data-pink-admin': env.ADMIN_ORIGIN ?? '' });
    const headers = new Headers(injected.headers);
    // Só a prévia pode ser enquadrada, e só pelo painel.
    headers.delete('x-frame-options');
    headers.set('content-security-policy', `frame-ancestors ${env.ADMIN_ORIGIN ?? "'none'"}`);
    headers.set('cache-control', 'no-store');
    return new Response(injected.body, { status: injected.status, headers });
  }

  const config = await loadPublicConfig(host.storeId, env);
  if (!config || !hasModuleFor(config, classifyPage(url.pathname, host.basePath))) return response;
  try {
    return injectLoader(response, config.version, {});
  } catch {
    return response;
  }
}

// O módulo de entrada do Worker só pode exportar o handler.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
} satisfies ExportedHandler<Env>;
