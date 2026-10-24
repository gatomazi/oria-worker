// Coordenador de elementos flutuantes (mini player, assistente). Evita cobrir
// compra, carrinho, menu, ajuda da INK e aviso de cookies; no celular, só um
// painel aberto por vez.
import { isMobile } from './dom.ts';
import { ink } from './page.ts';

export interface FloatingWidget {
  id: string;
  side: 'left' | 'right';
  /** "ceder": some quando outro painel estiver aberto. */
  yields: boolean;
  el: HTMLElement;
  isPanelOpen(): boolean;
  collapse(): void;
}

export class Floating {
  private widgets = new Map<string, FloatingWidget>();
  private lifetime: AbortController | null = null;
  private observers: MutationObserver[] = [];
  private raf = 0;

  register(w: FloatingWidget, signal: AbortSignal): void {
    this.widgets.set(w.id, w);
    this.start();
    signal.addEventListener('abort', () => {
      this.widgets.delete(w.id);
      if (!this.widgets.size) this.stop();
      else this.layout();
    }, { once: true });
    this.layout();
  }

  /** Um painel abriu: no celular, recolhe os demais. */
  opened(id: string): void {
    if (isMobile()) for (const w of this.widgets.values()) if (w.id !== id && w.isPanelOpen()) w.collapse();
    this.layout();
  }

  /** Algo da INK que não pode ser coberto está em uso? */
  blocked(): boolean {
    const added = ink.lastAdded();
    const drawer = ink.cartDrawer();
    return (
      (!!drawer && drawer.classList.contains('open')) ||
      (!!added && added.children.length > 0 && added.getClientRects().length > 0 && (added.textContent ?? '').trim().length > 0) ||
      !!document.querySelector('#modal-wrapper, #menu-hamburger[aria-expanded="true"], .modal-size-product.flex, [data-pink-dialog-open]')
    );
  }

  layout = (): void => {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => {
      const blocked = this.blocked();
      const anyPanel = [...this.widgets.values()].find((w) => w.isPanelOpen());
      const vh = window.innerHeight;
      const occupied = (el: HTMLElement | null) => {
        if (!el || el.hidden || el.getClientRects().length === 0) return 0;
        const r = el.getBoundingClientRect();
        return r.top < vh && r.bottom > vh - 200 ? Math.max(0, vh - r.top) : 0;
      };
      const bottomBar = Math.max(occupied(ink.mobileBuyBar()), occupied(ink.cookieBanner()));
      const help = ink.helpButton();
      const helpRect = help && help.getClientRects().length ? help.getBoundingClientRect() : null;
      const helpOnRight = !!helpRect && helpRect.left > window.innerWidth / 2;
      const stack: Record<'left' | 'right', number> = { left: 16 + bottomBar, right: 16 + bottomBar };
      if (helpRect && helpOnRight) stack.right = Math.max(stack.right, vh - helpRect.top + 12);
      if (helpRect && !helpOnRight) stack.left = Math.max(stack.left, vh - helpRect.top + 12);
      for (const w of this.widgets.values()) {
        const hide = blocked || (w.yields && !!anyPanel && anyPanel !== w && !w.isPanelOpen());
        w.el.style.setProperty('display', hide ? 'none' : 'block');
        w.el.style.setProperty('bottom', `${stack[w.side]}px`);
        w.el.style.setProperty(w.side, '16px');
        w.el.style.setProperty(w.side === 'left' ? 'right' : 'left', 'auto');
        if (!hide) stack[w.side] += (w.el.getBoundingClientRect().height || 56) + 12;
      }
    });
  };

  private start(): void {
    if (this.lifetime) return;
    this.lifetime = new AbortController();
    const { signal } = this.lifetime;
    window.addEventListener('resize', this.layout, { signal, passive: true });
    window.addEventListener('scroll', this.layout, { signal, passive: true });
    for (const type of ['turbo:before-stream-render', 'turbo:frame-render', 'click']) document.addEventListener(type, () => setTimeout(this.layout, 60), { signal });
    for (const el of [ink.cartDrawer(), ink.lastAdded(), ink.cookieBanner(), document.querySelector('#menu-hamburger')]) {
      if (!el) continue;
      const o = new MutationObserver(this.layout);
      o.observe(el, { attributes: true, attributeFilter: ['class', 'hidden', 'aria-expanded'], childList: el.id === 'last_added_product' });
      this.observers.push(o);
    }
  }

  private stop(): void {
    this.lifetime?.abort();
    this.lifetime = null;
    this.observers.forEach((o) => o.disconnect());
    this.observers = [];
    cancelAnimationFrame(this.raf);
  }
}
