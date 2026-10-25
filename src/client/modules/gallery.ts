// M03 — Galeria com miniaturas. Miniaturas das fotos reais abaixo da imagem
// principal: numa linha que rola de lado (padrão) ou em grade. Cada miniatura só aciona o
// controle NATIVO da galeria (o "ponto" da INK): zoom, gestos e a troca de
// foto ao escolher cor continuam da INK. Nunca mexe na variante comprada.
import { h, shadowHost, Undo } from '../runtime/dom.ts';
import { ink } from '../runtime/page.ts';
import type { ClientModule, ModuleContext } from '../runtime/types.ts';

const SIZES: Record<string, number> = { pequena: 52, media: 68, grande: 88 };

function svgPath(d: string): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '2');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

const galleryModule: ClientModule = {
  mount(ctx: ModuleContext) {
    const s = ctx.settings as { size: string; layout?: string; activeStyle: string; hideBullets: boolean };
    const row = s.layout !== 'grade';
    const root = ink.gallery();
    if (!root) return null;
    const slides = [...root.querySelectorAll<HTMLElement>('li[data-ink-store--carousel-target="item"]')];
    const items = slides
      .map((li) => {
        const holder = li.querySelector<HTMLElement>('[data-indicator-id]');
        const img = li.querySelector<HTMLImageElement>('img');
        const dotSel = holder?.getAttribute('data-indicator-id') ?? '';
        const dot = /^#dot-image-\d+$/.test(dotSel) ? document.querySelector<HTMLElement>(dotSel) : null;
        return img && dot ? { img, dot, alt: img.alt } : null;
      })
      .filter((x): x is { img: HTMLImageElement; dot: HTMLElement; alt: string } => !!x);
    // Uma foto só, ou estrutura diferente da homologada: a galeria nativa segue sozinha.
    if (items.length < 2 || items.length > 60) return null;

    const undo = new Undo();
    const { signal } = ctx;
    const px = SIZES[s.size] ?? 68;
    const { host, root: shadow } = shadowHost(
      'gallery',
      ctx.theme,
      `:host{display:block;margin-top:10px;min-width:0;max-width:100%;${row ? 'width:100%;' : ''}}
      .wrap{position:relative;min-width:0;max-width:100%}
      .thumbs{list-style:none;margin:0;padding:0;gap:8px;${
        row
          ? `display:flex;overflow-x:auto;overscroll-behavior-x:contain;scroll-snap-type:x proximity;scroll-padding-inline:2px;scrollbar-width:none;padding:2px;margin:-2px;-webkit-overflow-scrolling:touch`
          : `display:grid;grid-template-columns:repeat(auto-fill,minmax(${px}px,1fr))`
      }}
      .thumbs::-webkit-scrollbar{display:none}
      ${row ? `li{flex:0 0 ${px}px;scroll-snap-align:start}` : ''}
      /* Há mais fotos para o lado: a borda esmaece. */
      .wrap[data-more~="fim"] .thumbs{-webkit-mask-image:linear-gradient(to right,#000 calc(100% - 40px),transparent);mask-image:linear-gradient(to right,#000 calc(100% - 40px),transparent)}
      .wrap[data-more~="inicio"] .thumbs{-webkit-mask-image:linear-gradient(to left,#000 calc(100% - 40px),transparent);mask-image:linear-gradient(to left,#000 calc(100% - 40px),transparent)}
      .wrap[data-more~="inicio"][data-more~="fim"] .thumbs{-webkit-mask-image:linear-gradient(to right,transparent,#000 40px,#000 calc(100% - 40px),transparent);mask-image:linear-gradient(to right,transparent,#000 40px,#000 calc(100% - 40px),transparent)}
      .nav{position:absolute;top:50%;width:32px;height:32px;margin-top:-16px;border-radius:50%;border:0;padding:0;display:none;align-items:center;justify-content:center;background:#fff;color:#1f1f1f;box-shadow:0 1px 2px rgba(0,0,0,.12),0 4px 12px rgba(0,0,0,.12);z-index:1;transition:opacity .15s ease}
      .nav svg{width:16px;height:16px}
      .prev{left:-4px}.next{right:-4px}
      @media (hover:hover) and (pointer:fine){.wrap[data-more~="inicio"] .prev,.wrap[data-more~="fim"] .next{display:flex}}
      .nav:hover{background:#f4f4f4}
      button.thumb{display:block;width:100%;aspect-ratio:1/1;padding:0;border:2px solid transparent;border-radius:calc(var(--pk-radius) / 2);overflow:hidden;background:#f1f1f1}
      img{display:block;width:100%;height:100%;object-fit:cover}
      button.thumb[aria-current="true"]{border-color:var(--pk-primary)}
      ${s.activeStyle === 'opaco' ? 'button.thumb:not([aria-current="true"]) img{opacity:.55}button.thumb:hover img{opacity:1}' : ''}`,
    );
    const buttons = items.map((it, i) => {
      const b = h('button', { type: 'button', class: 'thumb', 'aria-label': `Ver foto ${i + 1} de ${items.length}` }, h('img', { src: it.img.currentSrc || it.img.src, alt: '', loading: 'lazy', decoding: 'async', width: String(px), height: String(px) }));
      // Delegado ao controle nativo: a INK cuida da troca, do zoom e dos gestos.
      b.addEventListener('click', () => it.dot.click(), { signal });
      return b;
    });
    const list = h('ul', { class: 'thumbs', 'aria-label': 'Fotos do produto' }, ...buttons.map((b) => h('li', {}, b)));
    const arrow = (cls: string, label: string, d: string) =>
      h('button', { type: 'button', class: `nav ${cls}`, 'aria-label': label, tabindex: '-1' }, svgPath(d));
    const prev = arrow('prev', 'Fotos anteriores', 'M10 3 5 8l5 5');
    const next = arrow('next', 'Mais fotos', 'M6 3l5 5-5 5');
    const wrap = h('div', { class: 'wrap' }, prev, list, next);
    shadow.append(wrap);
    // Linha: setas no computador e esmaecido nas pontas quando há mais fotos para o lado.
    const edges = () => {
      if (!row) return;
      const more: string[] = [];
      if (list.scrollLeft > 2) more.push('inicio');
      if (list.scrollLeft + list.clientWidth < list.scrollWidth - 2) more.push('fim');
      if (more.length) wrap.setAttribute('data-more', more.join(' '));
      else wrap.removeAttribute('data-more');
    };
    const page = (dir: 1 | -1) => list.scrollBy?.({ left: dir * Math.max(px, list.clientWidth * 0.8), behavior: 'smooth' });
    prev.addEventListener('click', () => page(-1), { signal });
    next.addEventListener('click', () => page(1), { signal });
    list.addEventListener('scroll', edges, { signal, passive: true });
    window.addEventListener('resize', edges, { signal, passive: true });
    const container = root.closest('section.section-product-v2') ?? root.parentElement!;
    undo.insert(host, container, root.nextSibling);

    // A dica de zoom da INK fica no rodapé da seção: sobe junto com as miniaturas.
    const tooltip = container.querySelector<HTMLElement>('#zoom-image-tooltip');
    if (tooltip) {
      const lift = () => undo.style(tooltip, 'bottom', `${host.getBoundingClientRect().height + 40}px`, 'important');
      const ro = new ResizeObserver(lift);
      ro.observe(host);
      undo.add(() => ro.disconnect());
    }

    let shown = -1;
    const sync = () => {
      let active = items.findIndex((it) => it.dot.getAttribute('aria-current') === 'true');
      if (active < 0) active = slides.findIndex((li) => !li.classList.contains('hidden'));
      buttons.forEach((b, i) => b.setAttribute('aria-current', String(i === active)));
      // Foto trocada (seta da INK, gesto, cor escolhida): a miniatura dela entra na linha visível.
      // Rola só a lista, nunca a página.
      const b = buttons[active];
      if (row && b && active !== shown) {
        const li = b.parentElement!;
        const left = li.offsetLeft - list.offsetLeft;
        if (left < list.scrollLeft || left + li.offsetWidth > list.scrollLeft + list.clientWidth) {
          list.scrollTo?.({ left: Math.max(0, left - (list.clientWidth - li.offsetWidth) / 2), behavior: shown < 0 ? 'auto' : 'smooth' });
        }
      }
      shown = active;
      edges();
    };
    const obs = new MutationObserver(sync);
    for (const it of items) obs.observe(it.dot, { attributes: true, attributeFilter: ['aria-current', 'class'] });
    for (const li of slides) obs.observe(li, { attributes: true, attributeFilter: ['class'] });
    undo.add(() => obs.disconnect());
    sync();

    if (s.hideBullets) {
      const dots = items[0]!.dot.closest('ul');
      if (dots) undo.hide(dots);
    }
    requestAnimationFrame(edges);
    return { destroy: () => undo.run() };
  },
};

export default galleryModule;
