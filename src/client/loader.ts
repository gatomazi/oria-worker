// Carregador público (módulo ES). Carregar este arquivo não liga nada: ele
// busca a configuração publicada da loja (ou o rascunho, na prévia com token),
// revalida e monta só os módulos ativos para esta página e dispositivo,
// baixando o código de cada um sob demanda. Qualquer falha: a página segue
// como veio da INK.
import { classifyPage, parsePublicConfigWith, type PublicConfig } from '../shared/public-config.ts';
import { CartService } from './runtime/cart.ts';
import { isMobile, removeModuleNodes } from './runtime/dom.ts';
import { Floating } from './runtime/floating.ts';
import type { ClientModule, Instance, ModuleContext } from './runtime/types.ts';

export const LOADER_VERSION = '2.0.0';
const GLOBAL = 'PersonalizacoesInk';

// Código de cada módulo vira um arquivo separado (import dinâmico).
const MODULES: Record<string, () => Promise<{ default: ClientModule }>> = {
  header: () => import('./modules/header.ts'),
  categoryTabs: () => import('./modules/category-tabs.ts'),
  gallery: () => import('./modules/gallery.ts'),
  share: () => import('./modules/share.ts'),
  coupons: () => import('./modules/coupons.ts'),
  cartIncentive: () => import('./modules/cart-incentive.ts'),
  reviews: () => import('./modules/reviews.ts'),
  videoCards: () => import('./modules/video-cards.ts'),
  miniPlayer: () => import('./modules/mini-player.ts'),
  assistant: () => import('./modules/assistant.ts'),
  sizeGuide: () => import('./modules/size-guide.ts'),
  delivery: () => import('./modules/delivery.ts'),
};
/** Não competem com a foto principal nem com a compra: só depois do load/ocioso. */
const DEFERRED = new Set(['videoCards', 'miniPlayer', 'assistant', 'reviews']);

export interface LoaderState {
  version: number | null;
  mounted: string[];
  failed: string[];
  reason: 'pending' | 'ok' | 'no-config' | 'destroyed';
  preview: boolean;
}

export interface LoaderApi {
  loaderVersion: string;
  refresh(): Promise<LoaderState>;
  state(): LoaderState;
  destroy(): void;
}

type Win = Window & { [GLOBAL]?: LoaderApi };

function warn(message: string, err?: unknown): void {
  try {
    console.warn(`[personalizacoes-ink] ${message}`, err ?? '');
  } catch {
    // sem console
  }
}

interface Mounted {
  instance: Instance;
  controller: AbortController;
  signature: string;
}

function start(win: Win, script: HTMLScriptElement | null): void {
  if (win[GLOBAL]) return; // já inicializado nesta página (o Turbo reexecuta scripts do body)

  const previewToken = script?.dataset.pinkPreview ?? '';
  const adminOrigin = script?.dataset.pinkAdmin ?? '';
  const preview = !!previewToken;
  const mounted = new Map<string, Mounted>();
  const failed = new Set<string>();
  let config: PublicConfig | null = null;
  let current: LoaderState = { version: null, mounted: [], failed: [], reason: 'pending', preview };
  let seq = 0;
  let destroyed = false;
  let pageLoaded = document.readyState === 'complete';
  let cart: CartService | null = null;
  const floating = new Floating();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const lifetime = new AbortController();

  const known = (id: string) => Object.hasOwn(MODULES, id);

  function unmount(id: string): void {
    const m = mounted.get(id);
    if (!m) return;
    mounted.delete(id);
    m.controller.abort();
    try {
      m.instance.destroy();
    } catch (err) {
      warn(`erro ao desmontar ${id}`, err);
    }
    removeModuleNodes(id);
  }

  function unmountAll(): void {
    for (const id of [...mounted.keys()]) unmount(id);
    cart?.stop();
    cart = null;
  }

  function snapshot(reason: LoaderState['reason']): LoaderState {
    current = { version: config?.version ?? null, mounted: [...mounted.keys()], failed: [...failed], reason, preview };
    return current;
  }

  // Reconciliações em fila: uma nova espera a anterior (nada é descartado no meio).
  let chain: Promise<unknown> = Promise.resolve();
  function reconcile(): Promise<LoaderState> {
    const run = chain.then(() => doReconcile());
    chain = run.catch(() => undefined);
    return run;
  }

  async function doReconcile(): Promise<LoaderState> {
    if (destroyed) return current;
    if (!config) {
      unmountAll();
      return snapshot('no-config');
    }
    const cfg = config;
    const page = classifyPage(location.pathname, cfg.basePath);
    const device: 'mobile' | 'desktop' = isMobile() ? 'mobile' : 'desktop';
    const wanted = Object.entries(cfg.modules).filter(([id, m]) => known(id) && m.pages.includes(page) && m.devices.includes(device));
    const wantedIds = new Set(wanted.map(([id]) => id));
    for (const id of [...mounted.keys()]) if (!wantedIds.has(id)) unmount(id);
    if (wanted.length && !cart) cart = new CartService(cfg.basePath);

    await Promise.all(
      wanted.map(async ([id, m]) => {
        const signature = JSON.stringify([cfg.version, cfg.theme, m.settings, page, device]);
        if (mounted.get(id)?.signature === signature) return;
        if (DEFERRED.has(id) && !pageLoaded && !preview) return; // monta no load
        unmount(id);
        try {
          const mod = (await MODULES[id]!()).default;
          if (destroyed) return;
          const controller = new AbortController();
          const ctx: ModuleContext = {
            id,
            settings: m.settings,
            theme: cfg.theme,
            page,
            basePath: cfg.basePath,
            storeId: cfg.storeId,
            version: cfg.version,
            preview,
            device,
            signal: controller.signal,
            cart: cart!,
            floating,
            requestReconcile(atMs) {
              const delay = atMs ? Math.min(Math.max(0, atMs - Date.now()) + 50, 2_147_000_000) : 0;
              const t = setTimeout(() => {
                timers.delete(t);
                mounted.get(id)?.controller.abort();
                const mm = mounted.get(id);
                if (mm) mm.signature = '';
                void reconcile();
              }, delay);
              timers.add(t);
            },
          };
          const instance = await mod.mount(ctx);
          if (destroyed || controller.signal.aborted) {
            controller.abort();
            instance?.destroy();
            return;
          }
          if (instance) {
            mounted.set(id, { instance, controller, signature });
            failed.delete(id);
            snapshot('ok');
          } else controller.abort();
        } catch (err) {
          failed.add(id);
          warn(`módulo ${id} não montado; a página segue sem ele`, err);
        }
      }),
    );
    return snapshot('ok');
  }

  async function fetchConfig(): Promise<PublicConfig | null> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      const url = preview ? `/__pink/preview-config.json?token=${encodeURIComponent(previewToken)}` : '/__pink/config.json';
      const res = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
      if (!res.ok) return null;
      const parsed = parsePublicConfigWith(await res.json(), known);
      if (!parsed) warn('configuração inválida; nenhum módulo exibido');
      return parsed;
    } catch (err) {
      warn('configuração indisponível; nenhum módulo exibido', err);
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  const api: LoaderApi = {
    loaderVersion: LOADER_VERSION,
    async refresh() {
      if (destroyed) return current;
      const mine = ++seq;
      const next = await fetchConfig();
      if (destroyed || mine !== seq) return current;
      if (preview && liveFromPanel) return reconcile();
      if (!next) {
        config = null;
        return reconcile();
      }
      config = next;
      return reconcile();
    },
    state: () => ({ ...current, mounted: [...current.mounted], failed: [...current.failed] }),
    destroy() {
      destroyed = true;
      seq++;
      lifetime.abort();
      timers.forEach((t) => clearTimeout(t));
      unmountAll();
      current = { version: null, mounted: [], failed: [], reason: 'destroyed', preview };
      if (win[GLOBAL] === api) delete win[GLOBAL];
    },
  };
  win[GLOBAL] = api;
  const { signal } = lifetime;

  // Turbo Drive (quando a loja usa): desmonta antes do cache/troca e revalida depois.
  for (const type of ['turbo:before-cache', 'turbo:before-render']) document.addEventListener(type, () => unmountAll(), { signal });
  document.addEventListener('turbo:load', () => void reconcile(), { signal });
  window.addEventListener('pageshow', (e) => (e as PageTransitionEvent).persisted && void reconcile(), { signal });
  // Mudou de celular para computador (ou vice-versa): remonta o que depende do dispositivo.
  window.matchMedia('(max-width: 767px)').addEventListener('change', () => void reconcile(), { signal });
  window.addEventListener(
    'load',
    () => {
      pageLoaded = true;
      void reconcile();
    },
    { signal, once: true },
  );

  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  /** Na prévia, a configuração enviada pelo painel (ainda não salva) vence a lida do rascunho salvo. */
  let liveFromPanel = false;
  if (preview) {
    // Prévia: aceita a configuração ainda não salva vinda SÓ do painel.
    window.addEventListener(
      'message',
      (event: MessageEvent) => {
        if (!adminOrigin || event.origin !== adminOrigin) return;
        const data = event.data as { type?: string; config?: unknown } | null;
        if (data?.type !== 'pink-preview-config') return;
        const parsed = parsePublicConfigWith(data.config, known);
        if (!parsed) return;
        config = parsed;
        liveFromPanel = true;
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => void reconcile(), 150);
      },
      { signal },
    );
    // Navegação dentro da prévia mantém o token.
    document.addEventListener(
      'click',
      (e) => {
        const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
        if (!a || a.target === '_blank' || a.origin !== location.origin) return;
        const u = new URL(a.href);
        if (u.searchParams.has('__pink_preview')) return;
        u.searchParams.set('__pink_preview', previewToken);
        a.href = u.href;
      },
      { capture: true, signal },
    );
    try {
      window.parent?.postMessage({ type: 'pink-preview-ready', path: location.pathname + location.search }, adminOrigin || '*');
    } catch {
      // sem painel
    }
  }

  const boot = () => void api.refresh();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true, signal });
  else boot();
}

try {
  start(window as Win, document.querySelector<HTMLScriptElement>('script[data-pink-loader]'));
} catch (err) {
  warn('carregador não iniciado', err);
}
