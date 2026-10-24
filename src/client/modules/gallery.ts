// M03 — Galeria com miniaturas. Miniaturas das fotos reais abaixo da imagem
// principal, em quantas linhas forem precisas. Cada miniatura só aciona o
// controle NATIVO da galeria (o "ponto" da INK): zoom, gestos e a troca de
// foto ao escolher cor continuam da INK. Nunca mexe na variante comprada.
import { h, shadowHost, Undo } from '../runtime/dom.ts';
import { ink } from '../runtime/page.ts';
import type { ClientModule, ModuleContext } from '../runtime/types.ts';

const SIZES: Record<string, number> = { pequena: 52, media: 68, grande: 88 };

const galleryModule: ClientModule = {
  mount(ctx: ModuleContext) {
    const s = ctx.settings as { size: string; activeStyle: string; hideBullets: boolean };
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
      `:host{margin-top:10px}
      .thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(${px}px,1fr));gap:8px;list-style:none;margin:0;padding:0}
      button{display:block;width:100%;aspect-ratio:1/1;padding:0;border:2px solid transparent;border-radius:calc(var(--pk-radius) / 2);overflow:hidden;background:#f1f1f1}
      img{display:block;width:100%;height:100%;object-fit:cover}
      button[aria-current="true"]{border-color:var(--pk-primary)}
      ${s.activeStyle === 'opaco' ? 'button:not([aria-current="true"]) img{opacity:.55}button:hover img{opacity:1}' : ''}`,
    );
    const buttons = items.map((it, i) => {
      const b = h('button', { type: 'button', 'aria-label': `Ver foto ${i + 1} de ${items.length}` }, h('img', { src: it.img.currentSrc || it.img.src, alt: '', loading: 'lazy', decoding: 'async', width: String(px), height: String(px) }));
      // Delegado ao controle nativo: a INK cuida da troca, do zoom e dos gestos.
      b.addEventListener('click', () => it.dot.click(), { signal });
      return b;
    });
    const list = h('ul', { class: 'thumbs', 'aria-label': 'Fotos do produto' }, ...buttons.map((b) => h('li', {}, b)));
    shadow.append(list);
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

    const sync = () => {
      let active = items.findIndex((it) => it.dot.getAttribute('aria-current') === 'true');
      if (active < 0) active = slides.findIndex((li) => !li.classList.contains('hidden'));
      buttons.forEach((b, i) => b.setAttribute('aria-current', String(i === active)));
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
    void signal;
    return { destroy: () => undo.run() };
  },
};

export default galleryModule;
