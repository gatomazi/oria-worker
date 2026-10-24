// Executa o carregador real (dist/test/loader.iife.js) em jsdom sobre páginas
// gravadas da INK, com fetch respondido pelas fixtures.
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import '../src/shared/modules/index.ts';
import { defaultConfig, moduleDefs, parseStoreConfig, toPublicConfig, type StoreConfig } from '../src/shared/registry.ts';

const LOADER = readFileSync('dist/test/loader.iife.js', 'utf8');
const F = 'test/fixtures/ink/';
export const fixture = (name: string) => readFileSync(F + name, 'utf8').replaceAll('/useorigens/', '/vistaentrenos/');

export function configWith(mods: Record<string, Record<string, unknown>>, mutate?: (c: StoreConfig) => void, version = 1) {
  const c = defaultConfig({ logoUrl: '', primary: '#50313D', accent: '#B45309', surface: '#F3E7CF', text: '#2A1A1D', font: 'inherit', style: 'suave' });
  for (const [id, settings] of Object.entries(mods)) c.modules[id] = { enabled: true, settings: { ...c.modules[id]!.settings, ...settings } };
  mutate?.(c);
  const parsed = parseStoreConfig(c);
  if (parsed.errors.length) throw new Error(`config de teste inválida: ${JSON.stringify(parsed.errors)}`);
  return toPublicConfig({ id: 'loja-teste', basePath: '/vistaentrenos' }, version, '2026-10-24T12:00:00.000Z', parsed.value, new Set(moduleDefs().map((d) => d.id)));
}

export interface Env {
  window: any;
  document: Document;
  errors: unknown[];
  requests: string[];
  posts: { url: string; body: string }[];
  setConfig(c: unknown): void;
  /** Conteúdo de um turbo-frame como o Turbo insere (por DOM, sem passar pelo parser do pai). */
  loadFrame(id: string, html: string): void;
  route(prefix: string, reply: () => Response | Promise<Response>): void;
  run(): void;
  mountedAfter(ms?: number): Promise<string[]>;
  host(id: string): HTMLElement | null;
  shadow(id: string): ShadowRoot | null;
  tick(ms?: number): Promise<void>;
}

const open: any[] = [];
/** Fecha as janelas jsdom (timers e observadores) ao fim de cada teste. */
export function closeAll(): void {
  while (open.length) {
    const w = open.pop();
    try {
      w.PersonalizacoesInk?.destroy();
      w.close();
    } catch {
      // já fechada
    }
  }
}

export function setup(page: string, path: string, config: unknown, opts: { mobile?: boolean } = {}): Env {
  const virtualConsole = new VirtualConsole();
  const errors: unknown[] = [];
  virtualConsole.on('jsdomError', (e) => {
    // CSS moderno (container queries, color-mix) que o jsdom não interpreta não é erro do módulo.
    if (!/Could not parse CSS stylesheet/.test(String(e.message))) errors.push(e);
  });
  const dom = new JSDOM(page, { url: `http://loja.localhost${path}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window as any;
  open.push(w);
  w.addEventListener('error', (e: any) => errors.push(e.error ?? e.message));
  w.addEventListener('unhandledrejection', (e: any) => errors.push(e.reason));
  w.matchMedia = (q: string) => ({ matches: q.includes('max-width: 767px') ? !!opts.mobile : q.includes('reduce'), addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.HTMLDialogElement.prototype.showModal = function (this: any) { this.open = true; this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function (this: any) { this.open = false; this.removeAttribute('open'); this.dispatchEvent(new w.Event('close')); };
  w.HTMLMediaElement.prototype.play = () => Promise.resolve();
  w.HTMLMediaElement.prototype.pause = () => undefined;
  Object.defineProperty(w, 'isSecureContext', { value: true, configurable: true });
  let cfg: unknown = config;
  const routes: [string, () => Response | Promise<Response>][] = [];
  const requests: string[] = [];
  const posts: { url: string; body: string }[] = [];
  const html = (name: string) => () => new Response(fixture(name), { headers: { 'content-type': 'text/html' } });
  const defaults: [string, () => Response][] = [
    ['/vistaentrenos/collections/', html('collection-maes.html')],
    ['/vistaentrenos/cart/most_solds', html('cart-frame-most-solds.html')],
    ['/vistaentrenos/reviews', html('reviews-ink-anonimizado.html')],
    ['/vistaentrenos/store_review_images/', html('review-image-ink-anonimizado.turbo-stream.html')],
    ['/vistaentrenos/product/', html('pdp.html')],
    ['/vistaentrenos/products', html('listing.html')],
  ];
  w.fetch = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, w.location.href);
    const key = url.pathname + url.search;
    requests.push(key);
    if (init.method === 'POST') posts.push({ url: key, body: String(init.body ?? '') });
    if (url.pathname === '/__pink/config.json') return cfg === null ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(cfg), { headers: { 'content-type': 'application/json' } });
    for (const [prefix, reply] of [...routes, ...defaults]) if (key.startsWith(prefix)) return reply();
    return new Response('não encontrado', { status: 404 });
  };
  const script = w.document.createElement('script');
  script.setAttribute('data-pink-loader', '1');
  w.document.body.append(script);
  const env: Env = {
    window: w,
    document: w.document,
    errors,
    requests,
    posts,
    setConfig: (c) => (cfg = c),
    loadFrame(id, src) {
      const doc = new w.DOMParser().parseFromString(src, 'text/html');
      const from = doc.querySelector(`turbo-frame#${id}`);
      const to = w.document.querySelector(`turbo-frame#${id}`);
      to.replaceChildren(...[...from.childNodes].map((n: Node) => w.document.importNode(n, true)));
      to.setAttribute('complete', '');
    },
    route: (prefix, reply) => routes.unshift([prefix, reply]),
    run: () => w.eval(LOADER),
    tick: (ms = 0) => new Promise((r) => setTimeout(r, ms)),
    async mountedAfter(ms = 60) {
      await env.tick(ms);
      w.dispatchEvent(new w.Event('load'));
      await env.tick(ms);
      // Copia para um array deste contexto (o jsdom tem o próprio Array).
      return JSON.parse(JSON.stringify(w.PersonalizacoesInk?.state().mounted ?? []));
    },
    host: (id) => w.document.querySelector(`[data-pink-module="${id}"]`),
    shadow: (id) => (w.document.querySelector(`[data-pink-module="${id}"]`) as any)?.shadowRoot ?? null,
  };
  return env;
}
