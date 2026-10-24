// M02 — Categorias em abas na home. Lê os produtos reais de cada coleção
// (página da própria loja), mostra só a aba ativa e troca o "Ver todos"
// conforme a aba. Atalhos nativos repetidos só somem depois que as abas carregam.
import { parseProductCards, type CardProduct } from '../../shared/ink-parse.ts';
import { cached, fetchDoc, h, safeHref, shadowHost, Undo } from '../runtime/dom.ts';
import { afterBanner, beforeFooter, beforeShowcase, insertAt } from '../runtime/page.ts';
import type { ClientModule, ModuleContext } from '../runtime/types.ts';

interface Tab {
  label: string;
  path: string;
}

const CSS = `
:host{container-type:inline-size}
.sec{display:grid;gap:14px}
.title{margin:0;font-size:22px;line-height:1.2;font-weight:700;letter-spacing:-.01em;color:#1f1f1f}
.tabs{display:flex;gap:6px;overflow-x:auto;padding:2px 2px 6px;scrollbar-width:thin}
.tab{flex:none;min-height:40px;padding:8px 16px;border-radius:var(--pk-btn-radius);border:1px solid #cfcfcf;background:#fff;color:#1f1f1f;font-weight:600;font-size:14px}
.tab[aria-selected="true"]{background:var(--ac);color:var(--on-ac);border-color:var(--ac)}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
@container (min-width:720px){.grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
.card{display:grid;gap:6px;color:#1f1f1f;text-decoration:none}
.card img{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:calc(var(--pk-radius) / 2);background:#f1f1f1}
.name{margin:0;font-size:14px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.price{margin:0;font-size:14px;font-weight:700}
.card:hover .name{text-decoration:underline}
.sk{aspect-ratio:1/1;border-radius:calc(var(--pk-radius) / 2);background:linear-gradient(90deg,#f0f0f0,#f7f7f7,#f0f0f0)}
.foot{display:flex;justify-content:center}
.all{background:transparent;border:1px solid var(--ac);color:#1f1f1f}
.msg{margin:0;color:#555;font-size:14px}
`;

const tabsModule: ClientModule = {
  mount(ctx: ModuleContext) {
    const s = ctx.settings as { title: string; tabs: Tab[]; initialTab: number; limit: number; viewAllLabel: string; position: string; hideNative: boolean; colors: { bg: string; fg: string } };
    const tabs = s.tabs.filter((t) => safeHref(t.path).startsWith('/'));
    if (!tabs.length) return null;
    const spot = s.position === 'antes-produtos' ? beforeShowcase() : s.position === 'antes-rodape' ? beforeFooter() : afterBanner();
    if (!spot) return null;

    const undo = new Undo();
    const { signal } = ctx;
    const cache = new Map<string, Promise<CardProduct[]>>();
    const load = (path: string) => {
      if (!cache.has(path)) {
        const p = cached(`cards:${path}`, 5 * 60_000, () => fetchDoc(path, signal).then((doc) => parseProductCards(doc, ctx.basePath))).then((all) => all.slice(0, s.limit));
        p.catch(() => cache.delete(path));
        cache.set(path, p);
      }
      return cache.get(path)!;
    };

    const { host, root } = shadowHost('categoryTabs', ctx.theme, CSS);
    root.append(h('style', {}, `:host{--ac:${s.colors.bg};--on-ac:${s.colors.fg}}`));
    const panel = h('div', { class: 'grid', role: 'tabpanel', 'aria-live': 'polite' });
    const all = h('a', { class: 'btn all', href: safeHref(tabs[0]!.path) }, s.viewAllLabel);
    const buttons = tabs.map((t, i) => h('button', { class: 'tab', role: 'tab', type: 'button', id: `pk-ct-${i}`, 'aria-selected': 'false', tabindex: '-1' }, t.label));
    const list = h('div', { class: 'tabs', role: 'tablist', 'aria-label': s.title || 'Categorias' }, ...buttons);
    const section = h('section', { class: 'sec', 'aria-label': s.title || 'Categorias' }, s.title ? h('h2', { class: 'title' }, s.title) : null, list, panel, h('div', { class: 'foot' }, all));
    root.append(section);
    insertAt(spot, host);
    undo.add(() => host.remove());

    let ticket = 0;
    let nativeHidden = false;
    const hideNative = () => {
      if (!s.hideNative || nativeHidden) return;
      nativeHidden = true;
      const targets = new Set(tabs.map((t) => t.path));
      const pathOf = (a: HTMLAnchorElement) => {
        try {
          const u = new URL(a.href, location.href);
          return u.pathname + u.search;
        } catch {
          return '';
        }
      };
      for (const block of document.querySelectorAll<HTMLElement>('.mb-9, section[data-controller~="ink-store--showcase"]:not(#products)')) {
        if (block.closest('[data-pink-module]')) continue;
        const links = [...block.querySelectorAll<HTMLAnchorElement>('a[href]')];
        const repeated = links.filter((a) => targets.has(pathOf(a)));
        if (!repeated.length) continue;
        if (repeated.length === links.length) undo.hide(block);
        else repeated.forEach((a) => undo.hide(a));
      }
    };

    const render = (products: CardProduct[]) =>
      panel.replaceChildren(
        ...products.map((p) =>
          h(
            'a',
            { class: 'card', href: safeHref(p.path) },
            p.imageUrl ? h('img', { src: p.imageUrl, alt: '', loading: 'lazy', decoding: 'async', width: '300', height: '300' }) : h('div', { class: 'sk' }),
            h('p', { class: 'name' }, p.title),
            p.priceText ? h('p', { class: 'price' }, p.priceText) : null,
          ),
        ),
      );

    const select = async (i: number, focus = false) => {
      const mine = ++ticket;
      buttons.forEach((b, j) => {
        b.setAttribute('aria-selected', String(i === j));
        b.tabIndex = i === j ? 0 : -1;
      });
      if (focus) buttons[i]!.focus();
      panel.setAttribute('aria-labelledby', `pk-ct-${i}`);
      all.href = safeHref(tabs[i]!.path);
      panel.setAttribute('aria-busy', 'true');
      panel.replaceChildren(...Array.from({ length: Math.min(4, s.limit) }, () => h('div', { class: 'sk', 'aria-hidden': 'true' })));
      try {
        const products = await load(tabs[i]!.path);
        if (mine !== ticket || signal.aborted) return;
        if (products.length) {
          render(products);
          hideNative();
        } else panel.replaceChildren(h('p', { class: 'msg' }, 'Nenhum produto nesta coleção no momento.'));
      } catch {
        if (mine !== ticket || signal.aborted) return;
        panel.replaceChildren(h('p', { class: 'msg' }, 'Não foi possível carregar os produtos agora. Use "Ver todos".'));
      } finally {
        if (mine === ticket) panel.removeAttribute('aria-busy');
      }
    };
    buttons.forEach((b, i) => {
      b.addEventListener('click', () => void select(i), { signal });
      // Pré-carrega ao passar o mouse/focar.
      b.addEventListener('pointerenter', () => void load(tabs[i]!.path).catch(() => undefined), { signal });
      b.addEventListener(
        'keydown',
        (e) => {
          const k = (e as KeyboardEvent).key;
          const n = k === 'ArrowRight' ? i + 1 : k === 'ArrowLeft' ? i - 1 : k === 'Home' ? 0 : k === 'End' ? buttons.length - 1 : null;
          if (n === null) return;
          e.preventDefault();
          void select((n + buttons.length) % buttons.length, true);
        },
        { signal },
      );
    });
    void select(Math.min(Math.max(1, s.initialTab), tabs.length) - 1);

    return {
      destroy() {
        ticket++;
        undo.run();
      },
    };
  },
};

export default tabsModule;
