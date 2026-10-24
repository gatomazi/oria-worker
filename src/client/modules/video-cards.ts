// M08 — Cards de vídeos com produtos. Capas leves; o vídeo só carrega ao
// abrir. No início, os vídeos escolhidos; na página do produto, os vinculados
// a ela.
import { h, shadowHost, Undo } from '../runtime/dom.ts';
import { afterBanner, beforeFooter, belowBuy, insertAt } from '../runtime/page.ts';
import { mediaSrc, openPlayer, type LibraryVideo } from '../runtime/video.ts';
import type { ClientModule, ModuleContext } from '../runtime/types.ts';

const videoCardsModule: ClientModule = {
  mount(ctx: ModuleContext) {
    const s = ctx.settings as { title: string; videos: LibraryVideo[]; productVideos: LibraryVideo[]; ctaLabel: string; shape: string; position: string; colors: { bg: string; fg: string } };
    const here = location.pathname;
    const list = ctx.page === 'product' ? s.productVideos.filter((v) => v.productPaths.includes(here)) : s.videos;
    const playable = list.filter((v) => mediaSrc(v.videoUrl));
    if (!playable.length) return null;
    const spot = ctx.page === 'product' ? belowBuy() : s.position === 'antes-rodape' ? beforeFooter() : afterBanner();
    if (!spot) return null;
    const ratio = s.shape === 'quadrado' ? '1/1' : '9/16';
    const { host, root } = shadowHost(
      'videoCards',
      ctx.theme,
      `:host{container-type:inline-size}
      .sec{display:grid;gap:12px;color:#1f1f1f}
      h2{margin:0;font-size:${ctx.page === 'product' ? 17 : 22}px;letter-spacing:-.01em}
      .row{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(150px,200px);gap:10px;overflow-x:auto;padding-bottom:6px;scroll-snap-type:x mandatory}
      .card{position:relative;display:grid;align-content:end;aspect-ratio:${ratio};border:0;border-radius:var(--pk-radius);overflow:hidden;background:#222;color:#fff;text-align:left;padding:0;scroll-snap-align:start}
      .card img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
      .card::after{content:"";position:absolute;inset:0;background:linear-gradient(transparent 55%,rgba(0,0,0,.65))}
      .play{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:48px;height:48px;border-radius:50%;background:rgba(255,255,255,.92);display:grid;place-items:center;z-index:1}
      .play::before{content:"";margin-left:4px;border-left:14px solid #111;border-top:9px solid transparent;border-bottom:9px solid transparent}
      .lbl{position:relative;z-index:1;margin:0;padding:10px;font-weight:700;font-size:14px;line-height:1.25}`,
    );
    const row = h('div', { class: 'row', role: 'list' });
    for (const v of playable) {
      const b = h('button', { type: 'button', class: 'card', role: 'listitem', 'aria-label': `Assistir: ${v.title}` }, mediaSrc(v.posterUrl) ? h('img', { src: mediaSrc(v.posterUrl), alt: '', loading: 'lazy', decoding: 'async' }) : null, h('span', { class: 'play', 'aria-hidden': 'true' }), h('p', { class: 'lbl' }, v.title));
      b.addEventListener('click', () => openPlayer(v, ctx.theme, s.colors, s.ctaLabel, ctx.signal), { signal: ctx.signal });
      row.append(b);
    }
    root.append(h('section', { class: 'sec', 'aria-label': s.title }, h('h2', {}, ctx.page === 'product' ? 'Vídeos desta peça' : s.title), row));
    const undo = new Undo();
    if (ctx.page === 'product') undo.insert(host, spot.parent, spot.before);
    else {
      insertAt(spot, host);
      undo.add(() => host.remove());
    }
    return { destroy: () => undo.run() };
  },
};

export default videoCardsModule;
