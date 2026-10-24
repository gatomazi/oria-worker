// M09 — Mini player. Usa a biblioteca e o player do M08. Mudo, compacto,
// respeita o fechamento (sessão ou dia), aparece depois de alguns segundos e
// se recolhe quando carrinho, compra, menu, modais ou o assistente estão em uso.
import { h, isMobile, shadowHost } from '../runtime/dom.ts';
import { mediaSrc, openPlayer, type LibraryVideo } from '../runtime/video.ts';
import type { ClientModule, ModuleContext } from '../runtime/types.ts';

function closedKey(storeId: string) {
  return `pink-mini-closed:${storeId}`;
}

function wasClosed(storeId: string, frequency: string): boolean {
  try {
    if (frequency === 'sessao') return sessionStorage.getItem(closedKey(storeId)) === '1';
    if (frequency === 'dia') return localStorage.getItem(closedKey(storeId)) === new Date().toISOString().slice(0, 10);
    return sessionStorage.getItem(`${closedKey(storeId)}:${location.pathname}`) === '1';
  } catch {
    return false;
  }
}

function markClosed(storeId: string, frequency: string): void {
  try {
    if (frequency === 'sessao') sessionStorage.setItem(closedKey(storeId), '1');
    else if (frequency === 'dia') localStorage.setItem(closedKey(storeId), new Date().toISOString().slice(0, 10));
    else sessionStorage.setItem(`${closedKey(storeId)}:${location.pathname}`, '1');
  } catch {
    // sem armazenamento: fecha só nesta página
  }
}

const miniPlayerModule: ClientModule = {
  mount(ctx: ModuleContext) {
    const s = ctx.settings as { source: string; videos: LibraryVideo[]; productVideos: LibraryVideo[]; position: string; size: string; frequency: string; delaySeconds: number; priority: string; colors: { bg: string; fg: string } };
    if (wasClosed(ctx.storeId, s.frequency)) return null;
    const here = location.pathname;
    const forProduct = ctx.page === 'product' && s.source === 'produto-primeiro' ? s.productVideos.find((v) => v.productPaths.includes(here)) : undefined;
    const video = forProduct ?? s.videos.find((v) => mediaSrc(v.videoUrl));
    if (!video || !mediaSrc(video.videoUrl)) return null;
    const w = s.size === 'medio' ? 168 : 120;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const { host, root } = shadowHost(
      'miniPlayer',
      ctx.theme,
      `:host{position:fixed;z-index:31;width:${w}px}
      .mini{position:relative;border-radius:var(--pk-radius);overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,.28);background:#111;aspect-ratio:9/16}
      video,img{display:block;width:100%;height:100%;object-fit:cover}
      .open{position:absolute;inset:0;border:0;background:transparent;cursor:pointer}
      .x{position:absolute;top:6px;right:6px;width:28px;height:28px;border-radius:50%;border:0;background:rgba(0,0,0,.6);color:#fff;font-size:16px;line-height:1;z-index:2}
      .t{position:absolute;left:0;right:0;bottom:0;margin:0;padding:18px 8px 8px;font-size:12px;font-weight:700;color:#fff;background:linear-gradient(transparent,rgba(0,0,0,.7))}`,
    );
    const media = reduce
      ? mediaSrc(video.posterUrl)
        ? h('img', { src: mediaSrc(video.posterUrl), alt: '' })
        : h('video', { src: mediaSrc(video.videoUrl), muted: true, playsinline: true, preload: 'metadata' })
      : h('video', { src: mediaSrc(video.videoUrl), muted: true, playsinline: true, loop: true, autoplay: true, preload: 'none', poster: mediaSrc(video.posterUrl) || undefined });
    if (media instanceof HTMLVideoElement) media.muted = true;
    const open = h('button', { type: 'button', class: 'open', 'aria-label': `Assistir com som: ${video.title}` });
    const x = h('button', { type: 'button', class: 'x', 'aria-label': 'Fechar vídeo' }, '×');
    root.append(h('div', { class: 'mini' }, media, h('p', { class: 't' }, video.title), open, x));
    host.style.display = 'none';
    const side: 'left' | 'right' = s.position === 'inferior-direita' ? 'right' : 'left';
    let closed = false;
    const { signal } = ctx;
    open.addEventListener('click', () => {
      if (media instanceof HTMLVideoElement) media.pause();
      openPlayer(video, ctx.theme, s.colors, 'Ver peça', signal);
    }, { signal });
    x.addEventListener('click', () => {
      closed = true;
      markClosed(ctx.storeId, s.frequency);
      host.remove();
    }, { signal });
    document.addEventListener('visibilitychange', () => media instanceof HTMLVideoElement && (document.hidden ? media.pause() : !reduce && void media.play().catch(() => undefined)), { signal });

    const show = setTimeout(() => {
      if (closed || signal.aborted) return;
      document.body.append(host);
      ctx.floating.register({ id: 'miniPlayer', side, yields: s.priority === 'ceder' || isMobile(), el: host, isPanelOpen: () => false, collapse: () => undefined }, signal);
      if (media instanceof HTMLVideoElement && !reduce) {
        media.preload = 'metadata';
        void media.play().catch(() => undefined);
      }
    }, Math.max(0, s.delaySeconds) * 1000);

    return {
      destroy() {
        clearTimeout(show);
        if (media instanceof HTMLVideoElement) media.pause();
        host.remove();
      },
    };
  },
};

export default miniPlayerModule;
