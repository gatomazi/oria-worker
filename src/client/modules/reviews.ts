// M07 — Avaliações com fotos. Fonte: avaliações publicadas na própria INK
// (/reviews da loja). Mostra nome público, data e nota de cada uma; cada foto
// abre o depoimento de origem. Nunca calcula nota geral a partir da seleção.
// Sem avaliações publicadas, não mostra nada.
import { parseReviewImage, parseReviews, type Review, type ReviewPhoto } from '../../shared/ink-parse.ts';
import { cached, fetchDoc, h, shadowHost, Undo } from '../runtime/dom.ts';
import { afterBanner, beforeFooter, insertAt } from '../runtime/page.ts';
import type { ClientModule, ModuleContext } from '../runtime/types.ts';

const CSS = `
:host{container-type:inline-size}
.sec{display:grid;gap:12px;color:#1f1f1f}
.head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
h2{margin:0;font-size:22px;line-height:1.2;letter-spacing:-.01em}
.src{font-size:13px;color:#555}
.list{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}
.list.carrossel{grid-auto-flow:column;grid-auto-columns:minmax(200px,1fr);grid-template-columns:none;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:6px}
.list.carrossel > *{scroll-snap-align:start}
.card{display:grid;gap:8px;align-content:start;padding:12px;border:1px solid #e3e3e3;border-radius:var(--pk-radius);background:#fff;text-align:left;font:inherit;color:inherit}
button.card{cursor:pointer}
button.card:hover{border-color:var(--ac)}
.photo{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:calc(var(--pk-radius) / 2);background:#f1f1f1}
.stars{color:var(--ac);letter-spacing:2px;font-size:14px}
.who{margin:0;font-weight:700;font-size:14px}
.when{margin:0;font-size:12.5px;color:#666}
.txt{margin:0;font-size:14px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}
.ver{font-size:12px;color:#2d6a3e;font-weight:600}
.note{margin:0;font-size:12.5px;color:#555}
dialog{max-width:min(560px,calc(100vw - 24px));width:100%;border:0;border-radius:var(--pk-radius);padding:0;box-shadow:0 18px 48px rgba(0,0,0,.3)}
dialog::backdrop{background:rgba(0,0,0,.55)}
.dlg{display:grid;gap:10px;padding:14px}
.dlg img{width:100%;max-height:60vh;object-fit:contain;background:#111;border-radius:calc(var(--pk-radius) / 2)}
.close{justify-self:end;background:transparent;border:1px solid #ccc;color:#1f1f1f;min-height:36px}
`;

const stars = (n: number) => '★'.repeat(Math.max(0, Math.min(5, n))) + '☆'.repeat(5 - Math.max(0, Math.min(5, n)));

const reviewsModule: ClientModule = {
  async mount(ctx: ModuleContext) {
    const s = ctx.settings as { title: string; selection: string; highlights: string[]; max: number; layout: string; showRating: boolean; position: string; colors: { bg: string; fg: string } };
    const { signal } = ctx;
    const sort = s.selection === 'recentes' ? 'recents' : 'rate';
    let data: { reviews: Review[]; photos: ReviewPhoto[] };
    try {
      data = await cached(`reviews:${sort}`, 10 * 60_000, async () => parseReviews(await fetchDoc(`${ctx.basePath}/reviews?sort=${sort}`, signal)));
    } catch {
      return null;
    }
    if (signal.aborted) return null;
    let photos = data.photos;
    let reviews = data.reviews;
    if (s.selection === 'destaques') {
      const want = new Set(s.highlights);
      photos = photos.filter((p) => want.has(`foto-${p.reviewImageId}`));
      reviews = reviews.filter((r) => want.has(`avaliacao-${r.id}`));
    }
    const usePhotos = s.selection !== 'recentes' && photos.length > 0;
    if (!(usePhotos ? photos.length : reviews.length)) return null; // nada publicado: nada aparece

    const spot = ctx.page === 'product' || s.position === 'antes-rodape' ? beforeFooter() : afterBanner();
    if (!spot) return null;
    const undo = new Undo();
    const { host, root } = shadowHost('reviews', ctx.theme, CSS);
    root.append(h('style', {}, `:host{--ac:${s.colors.bg}}`));
    const list = h('div', { class: `list ${s.layout}`, role: 'list' });
    const dialog = h('dialog', { 'aria-label': 'Avaliação' });
    root.append(
      h(
        'section',
        { class: 'sec', 'aria-label': s.title },
        h('div', { class: 'head' }, h('h2', {}, s.title), h('a', { class: 'src', href: `${ctx.basePath}/reviews` }, 'Ver todas as avaliações')),
        s.selection === 'destaques' ? h('p', { class: 'note' }, 'Seleção de avaliações publicadas na loja.') : null,
        list,
      ),
      dialog,
    );

    if (usePhotos) {
      for (const p of photos.slice(0, s.max)) {
        const card = h('button', { type: 'button', class: 'card', role: 'listitem', 'aria-label': `Abrir avaliação com foto${p.rating ? `, nota ${p.rating}` : ''}` }, h('img', { class: 'photo', src: p.imageUrl, alt: 'Foto enviada por cliente', loading: 'lazy', decoding: 'async' }), s.showRating && p.rating ? h('span', { class: 'stars', 'aria-hidden': 'true' }, stars(Math.round(p.rating))) : null);
        card.addEventListener('click', () => void openPhoto(p), { signal });
        list.append(card);
      }
    } else {
      for (const r of reviews.slice(0, s.max)) {
        list.append(
          h(
            'article',
            { class: 'card', role: 'listitem' },
            s.showRating && r.rating ? h('span', { class: 'stars', 'aria-label': `Nota ${r.rating} de 5` }, stars(r.rating)) : null,
            h('p', { class: 'txt' }, r.text),
            h('p', { class: 'who' }, r.author),
            h('p', { class: 'when' }, r.date),
            r.verified ? h('span', { class: 'ver' }, 'Compra verificada') : null,
          ),
        );
      }
    }

    // A foto abre o depoimento de origem (detalhe vindo da própria INK).
    async function openPhoto(p: ReviewPhoto): Promise<void> {
      dialog.replaceChildren(h('div', { class: 'dlg' }, h('p', {}, 'Carregando avaliação…')));
      dialog.showModal();
      document.body.setAttribute('data-pink-dialog-open', '');
      try {
        const res = await fetch(`${ctx.basePath}/store_review_images/${p.reviewImageId}`, { headers: { accept: 'text/vnd.turbo-stream.html, text/html' }, credentials: 'same-origin', signal });
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        const d = parseReviewImage(doc);
        if (!d) throw new Error('sem detalhe');
        const close = h('button', { type: 'button', class: 'btn close' }, 'Fechar');
        close.addEventListener('click', () => dialog.close(), { signal });
        dialog.replaceChildren(
          h(
            'div',
            { class: 'dlg' },
            close,
            h('img', { src: d.imageUrl || p.imageUrl, alt: 'Foto enviada na avaliação' }),
            s.showRating && d.rating ? h('span', { class: 'stars', 'aria-label': `Nota ${d.rating} de 5` }, stars(d.rating)) : null,
            d.text ? h('p', { class: 'txt' }, d.text) : null,
            h('p', { class: 'who' }, d.author),
            h('p', { class: 'when' }, d.date),
            d.verified ? h('span', { class: 'ver' }, 'Compra verificada') : null,
            d.products.length ? h('p', { class: 'note' }, `Produtos comprados: ${d.products.join(', ')}`) : null,
          ),
        );
        close.focus();
      } catch {
        dialog.replaceChildren(h('div', { class: 'dlg' }, h('img', { src: p.imageUrl, alt: 'Foto enviada na avaliação' }), h('p', { class: 'note' }, 'Não foi possível abrir o depoimento agora.')));
      }
    }
    dialog.addEventListener('close', () => document.body.removeAttribute('data-pink-dialog-open'), { signal });
    dialog.addEventListener('click', (e) => e.target === dialog && dialog.close(), { signal });

    insertAt(spot, host);
    undo.add(() => host.remove());
    undo.add(() => document.body.removeAttribute('data-pink-dialog-open'));
    return { destroy: () => undo.run() };
  },
};

export default reviewsModule;
