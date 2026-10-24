// Player compartilhado por M08 (cards) e M09 (mini player): mesma biblioteca,
// mesma experiência. Sem som automático; pausa fora de foco; fecha com Esc.
// Nome e preço da peça vêm da própria página do produto na loja.
import { formatBrl, parseProductPage } from '../../shared/ink-parse.ts';
import type { Theme } from '../../shared/identity.ts';
import { cached, fetchDoc, h, safeHref, shadowHost } from './dom.ts';

export interface LibraryVideo {
  id: string;
  title: string;
  caption: string;
  videoUrl: string;
  posterUrl: string;
  productPaths: string[];
}

const products = new Map<string, Promise<{ name: string; price: string; image: string } | null>>();
export function productSummary(path: string, signal?: AbortSignal) {
  if (!products.has(path)) {
    products.set(
      path,
      cached(`product:${path}`, 10 * 60_000, () =>
        fetchDoc(path, signal).then((d) => {
          const p = parseProductPage(d);
          return p.name ? { name: p.name, price: p.price ? formatBrl(Math.round(p.price * 100)) : '', image: p.image } : null;
        }),
      ).catch(() => null),
    );
  }
  return products.get(path)!;
}

export function mediaSrc(url: string): string {
  return /^\/__pink\/media\/[a-f0-9]{24}$/.test(url) ? url : safeHref(url).startsWith('https://') ? safeHref(url) : '';
}

const CSS = `
dialog{width:min(420px,calc(100vw - 24px));max-height:calc(100vh - 24px);border:0;padding:0;border-radius:var(--pk-radius);background:#111;color:#fff;box-shadow:0 20px 60px rgba(0,0,0,.45)}
dialog::backdrop{background:rgba(0,0,0,.6)}
.wrap{display:grid;gap:0}
video{display:block;width:100%;max-height:70vh;background:#000;aspect-ratio:9/16;object-fit:contain}
.bar{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px}
.t{margin:0;font-weight:700;font-size:15px}
.cap{margin:0 12px 8px;font-size:13px;opacity:.85}
.close{background:transparent;border:1px solid rgba(255,255,255,.4);color:#fff;min-height:36px;padding:6px 12px}
.prods{display:grid;gap:8px;padding:0 12px 12px}
.prod{display:grid;grid-template-columns:56px 1fr auto;gap:10px;align-items:center;background:#fff;color:#1f1f1f;border-radius:calc(var(--pk-radius) / 2);padding:8px;text-decoration:none}
.prod img{width:56px;height:56px;object-fit:cover;border-radius:6px;background:#eee}
.prod p{margin:0;font-size:13.5px;line-height:1.3}
.prod .cta{background:var(--ac);color:var(--on-ac);min-height:36px;padding:6px 12px;font-size:13px}
`;

/** Abre o vídeo em diálogo modal com acesso às peças vinculadas. */
export function openPlayer(v: LibraryVideo, theme: Theme, colors: { bg: string; fg: string }, ctaLabel: string, signal: AbortSignal): void {
  const src = mediaSrc(v.videoUrl);
  if (!src) return;
  const { host, root } = shadowHost('video-player', theme, CSS);
  root.append(h('style', {}, `:host{--ac:${colors.bg};--on-ac:${colors.fg}}`));
  const video = h('video', { src, controls: true, playsinline: true, muted: true, preload: 'metadata', poster: mediaSrc(v.posterUrl) || undefined });
  video.muted = true;
  const close = h('button', { type: 'button', class: 'btn close' }, 'Fechar');
  const prods = h('div', { class: 'prods' });
  const dialog = h('dialog', { 'aria-label': v.title }, h('div', { class: 'wrap' }, h('div', { class: 'bar' }, h('p', { class: 't' }, v.title), close), video, v.caption ? h('p', { class: 'cap' }, v.caption) : null, prods));
  root.append(dialog);
  document.body.append(host);
  document.body.setAttribute('data-pink-dialog-open', '');
  const life = new AbortController();
  const done = () => {
    life.abort();
    video.pause();
    host.remove();
    document.body.removeAttribute('data-pink-dialog-open');
  };
  signal.addEventListener('abort', done, { once: true });
  dialog.addEventListener('close', done, { signal: life.signal });
  dialog.addEventListener('click', (e) => e.target === dialog && dialog.close(), { signal: life.signal });
  close.addEventListener('click', () => dialog.close(), { signal: life.signal });
  document.addEventListener('visibilitychange', () => document.hidden && video.pause(), { signal: life.signal });
  dialog.showModal();
  close.focus();
  void video.play().catch(() => undefined);
  for (const path of v.productPaths.filter((p) => safeHref(p).startsWith('/'))) {
    const row = h('a', { class: 'prod', href: safeHref(path) }, h('img', { alt: '' }), h('p', {}, 'Ver a peça'), h('span', { class: 'btn cta' }, ctaLabel));
    prods.append(row);
    void productSummary(path, life.signal).then((p) => {
      if (!p) return; // sem dados confiáveis: só o link, sem preço
      const [img, text] = [row.children[0] as HTMLImageElement, row.children[1] as HTMLElement];
      if (p.image) img.src = p.image;
      text.replaceChildren(h('strong', {}, p.name), p.price ? h('br') : '', p.price);
    });
  }
}
