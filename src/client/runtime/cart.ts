// Leitura do carrinho renderizado pela INK e detecção de adição confirmada.
// Nada de interceptar fetch: observa só a gaveta do carrinho e o modal pós-adição.
import { readCart, type CartState } from '../../shared/ink-parse.ts';
import { ink } from './page.ts';

type Listener = (state: CartState | null) => void;

export class CartService {
  private basePath: string;
  private listeners = new Set<Listener>();
  private addedListeners = new Set<(modal: HTMLElement) => void>();
  private last = '';
  private observers: MutationObserver[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lifetime = new AbortController();

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  read(): CartState | null {
    try {
      return readCart(document, this.basePath);
    } catch {
      return null;
    }
  }

  /** Abre a gaveta nativa do carrinho (clica no botão visível da INK). */
  open(): boolean {
    const btn = ink.cartButtons().find((b) => b.getClientRects().length > 0);
    btn?.click();
    return !!btn;
  }

  isOpen(): boolean {
    const d = ink.cartDrawer();
    return !!d && d.classList.contains('open') && d.getClientRects().length > 0;
  }

  onChange(fn: Listener, signal: AbortSignal): void {
    this.ensureWatching();
    this.listeners.add(fn);
    signal.addEventListener('abort', () => this.listeners.delete(fn), { once: true });
  }

  /** Chamado quando a INK confirma a adição (modal "Produto adicionado"). */
  onAdded(fn: (modal: HTMLElement) => void, signal: AbortSignal): void {
    this.ensureWatching();
    this.addedListeners.add(fn);
    signal.addEventListener('abort', () => this.addedListeners.delete(fn), { once: true });
  }

  private ensureWatching(): void {
    if (this.observers.length) return;
    const schedule = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.check(), 40);
    };
    const drawer = ink.cartDrawer();
    if (drawer) {
      const o = new MutationObserver(schedule);
      o.observe(drawer, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-quantityheader', 'value'] });
      this.observers.push(o);
    }
    const added = ink.lastAdded();
    if (added) {
      const o = new MutationObserver(() => {
        const modal = added.querySelector<HTMLElement>('#modal-wrapper, .add-product-modal') ?? (added.children.length ? (added.firstElementChild as HTMLElement) : null);
        if (modal && /adicionad/i.test(modal.textContent ?? '') && !modal.hasAttribute('data-pink-seen')) {
          modal.setAttribute('data-pink-seen', '');
          for (const fn of this.addedListeners) {
            try {
              fn(modal);
            } catch {
              // um ouvinte com erro não derruba os outros
            }
          }
        }
      });
      o.observe(added, { childList: true, subtree: true });
      this.observers.push(o);
    }
    for (const type of ['turbo:before-stream-render', 'turbo:frame-render', 'turbo:frame-load']) {
      document.addEventListener(type, schedule, { signal: this.lifetime.signal });
    }
    schedule();
  }

  private check(): void {
    const state = this.read();
    const sig = JSON.stringify(state);
    if (sig === this.last) return;
    this.last = sig;
    for (const fn of this.listeners) {
      try {
        fn(state);
      } catch {
        // idem
      }
    }
  }

  stop(): void {
    this.observers.forEach((o) => o.disconnect());
    this.observers = [];
    this.lifetime.abort();
    this.lifetime = new AbortController();
    clearTimeout(this.timer);
    this.listeners.clear();
    this.addedListeners.clear();
    this.last = '';
  }
}
