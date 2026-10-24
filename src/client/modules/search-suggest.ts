// M01 — Sugestões enquanto a pessoa digita na busca NATIVA da INK. Lê a própria
// página de busca da loja (products?search_filter=); Enter continua indo para a
// busca da INK. Painel em Shadow DOM, posicionado abaixo do campo.
import { cached, fetchDoc, h, safeHref, shadowHost, type Undo } from '../runtime/dom.ts';
import type { ModuleContext } from '../runtime/types.ts';
import { parseProductCards } from '../../shared/ink-parse.ts';

const CSS = `
.panel{position:fixed;z-index:2147482000;background:#fff;color:#1f1f1f;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.2);padding:6px;max-height:min(70vh,520px);overflow:auto;font:14px/1.35 var(--font,system-ui)}
.panel[hidden]{display:none}
.state{padding:12px;color:#555}
a.item{display:grid;grid-template-columns:48px 1fr;gap:10px;align-items:center;padding:6px;border-radius:8px;color:inherit;text-decoration:none;min-height:44px}
a.item:hover,a.item:focus-visible{background:#f2f2f2;outline:none}
a.item:focus-visible{box-shadow:0 0 0 2px var(--pk-primary,#333) inset}
.item img,.item .ph{width:48px;height:56px;object-fit:cover;border-radius:6px;background:#eee}
.t{font-weight:600}.p{color:#444;font-size:13px}
a.all{display:block;margin-top:4px;padding:10px;border-top:1px solid #eee;text-align:center;font-weight:700;color:inherit;text-decoration:none;border-radius:0 0 8px 8px}
a.all:hover,a.all:focus-visible{background:#f2f2f2;outline:none}
`;

export const SEARCH_MESSAGES = {
  loading: 'Buscando…',
  empty: (q: string) => `Nada encontrado para “${q}”.`,
  error: 'Não deu para buscar agora. Tente de novo.',
} as const;

export function attachSearchSuggest(ctx: ModuleContext, inputs: HTMLInputElement[], undo: Undo): void {
  const { signal } = ctx;
  const searchPath = `${ctx.basePath}/products`;
  const { host, root } = shadowHost('header', ctx.theme, CSS, { 'data-pink-search': '' });
  const panel = h('div', { class: 'panel', role: 'region', 'aria-label': 'Sugestões da busca', hidden: '' });
  const live = h('div', { class: 'state', role: 'status', 'aria-live': 'polite' });
  root.append(panel);
  document.body.append(host);
  undo.add(() => host.remove());

  let active: HTMLInputElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: AbortController | null = null;
  let seq = 0;

  const place = () => {
    if (!active || panel.hidden) return;
    const r = active.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 300), window.innerWidth - 16);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    panel.style.top = `${Math.round(r.bottom + 6)}px`;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.width = `${Math.round(width)}px`;
  };
  const close = () => {
    panel.hidden = true;
    inflight?.abort();
    clearTimeout(timer);
    active?.setAttribute('aria-expanded', 'false');
  };
  const show = (...nodes: Node[]) => {
    panel.replaceChildren(...nodes);
    panel.hidden = false;
    active?.setAttribute('aria-expanded', 'true');
    place();
  };
  const state = (msg: string) => {
    live.textContent = msg;
    show(live);
  };

  const run = async (q: string) => {
    const my = ++seq;
    inflight?.abort();
    inflight = new AbortController();
    const stop = inflight.signal;
    signal.addEventListener('abort', () => inflight?.abort(), { once: true });
    state(SEARCH_MESSAGES.loading);
    const all = `${searchPath}?search_filter=${encodeURIComponent(q)}`;
    try {
      const products = await cached(`suggest:${q.toLowerCase()}`, 5 * 60_000, async () => parseProductCards(await fetchDoc(all, stop), ctx.basePath));
      if (my !== seq || stop.aborted) return;
      // A INK lista cada cor como um produto com o mesmo nome: mostra nomes diferentes.
      const seen = new Set<string>();
      const unique = products.filter((p) => safeHref(p.path) && !seen.has(p.title) && (seen.add(p.title), true)).slice(0, 6);
      if (!unique.length) return state(SEARCH_MESSAGES.empty(q));
      live.textContent = `${unique.length} sugest${unique.length > 1 ? 'ões' : 'ão'}`;
      show(
        h('div', { class: 'sr', style: 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)' }, live),
        ...unique.map((p) =>
          h('a', { class: 'item', href: safeHref(p.path) }, p.imageUrl ? h('img', { src: p.imageUrl, alt: '', loading: 'lazy' }) : h('span', { class: 'ph' }), h('span', {}, h('span', { class: 't' }, p.title), p.priceText ? h('br') : '', p.priceText ? h('span', { class: 'p' }, p.priceText) : '')),
        ),
        h('a', { class: 'all', href: safeHref(all) }, 'Ver todos os resultados'),
      );
    } catch {
      if (my === seq && !stop.aborted) state(SEARCH_MESSAGES.error);
    }
  };

  for (const input of inputs) {
    undo.attr(input, 'autocomplete', 'off');
    undo.attr(input, 'aria-expanded', 'false');
    input.addEventListener(
      'input',
      () => {
        active = input;
        const q = input.value.trim();
        clearTimeout(timer);
        if (q.length < 2) return close();
        timer = setTimeout(() => void run(q.slice(0, 60)), 280);
      },
      { signal },
    );
    input.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') close();
        else if (e.key === 'ArrowDown' && !panel.hidden) {
          const first = root.querySelector<HTMLElement>('a');
          if (first) {
            e.preventDefault();
            first.focus();
          }
        } else if (e.key === 'Enter') close(); // a busca da INK segue normalmente
      },
      { signal },
    );
  }
  // Setas dentro do painel; Esc volta ao campo.
  panel.addEventListener(
    'keydown',
    (e) => {
      const links = [...root.querySelectorAll<HTMLElement>('a')];
      const i = links.indexOf(root.activeElement as HTMLElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
        if (next < 0) active?.focus();
        else links[Math.min(next, links.length - 1)]?.focus();
      } else if (e.key === 'Escape') {
        active?.focus();
        close();
      }
    },
    { signal },
  );
  document.addEventListener('pointerdown', (e) => {
    const path = e.composedPath();
    if (!path.includes(host) && !inputs.some((i) => path.includes(i))) close();
  }, { signal });
  window.addEventListener('resize', place, { signal, passive: true });
  window.addEventListener('scroll', place, { signal, passive: true });
}
