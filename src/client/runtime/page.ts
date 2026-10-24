// Superfícies da página INK. É o único lugar com seletores da loja: ao
// homologar outra variação de tema, muda aqui, não nos módulos.
import { parseProductPage } from '../../shared/ink-parse.ts';

export interface Spot {
  parent: Node;
  before: Node | null;
  /** A superfície não tem margens laterais: o módulo centraliza e cria as suas. */
  gutter: boolean;
}

const OUTSIDE_MAIN = '.modal-buy-together, #quick_add_frame, #modal-wrapper, turbo-frame#cart, .cart-drawer, #last_added_product';

export const ink = {
  header: () => document.querySelector<HTMLElement>('header.header'),
  footer: () => document.querySelector<HTMLElement>('footer.footer, footer'),
  banner: () => document.querySelector<HTMLElement>('section.carousel-container'),
  showcase: () => document.querySelector<HTMLElement>('#products[data-controller~="ink-store--showcase"], #products'),
  cartDrawer: () => document.querySelector<HTMLElement>('.cart-drawer'),
  cartButtons: () => [...document.querySelectorAll<HTMLElement>('#shopping-cart-menu-desk, #shopping-cart-menu-mob, [id^="shopping-cart-menu"]')],
  lastAdded: () => document.querySelector<HTMLElement>('#last_added_product'),
  helpButton: () => document.querySelector<HTMLElement>('[data-controller~="ink-store--help-button"]'),
  cookieBanner: () => document.querySelector<HTMLElement>('.cookie-acceptance'),
  mobileBuyBar: () => document.querySelector<HTMLElement>('.form-product-options__add-to-cart-mobile'),
  gallery: () => document.querySelector<HTMLElement>('section.section-product-v2 [data-controller~="ink-store--carousel"]'),
};

/** Formulário do produto principal (ignora "Compre junto", quick-add, modais e carrinho). */
export function mainProductForm(): HTMLFormElement | null {
  return [...document.querySelectorAll<HTMLFormElement>('form[id^="form-product-"]')].find((f) => !f.closest(OUTSIDE_MAIN)) ?? null;
}

export function productInfo() {
  return parseProductPage(document);
}

const spot = (el: Element | null | undefined, where: 'before' | 'after', gutter: boolean): Spot | null =>
  el?.parentNode ? { parent: el.parentNode, before: where === 'before' ? el : el.nextSibling, gutter } : null;

export function afterHeader(): Spot | null {
  return spot(ink.header(), 'after', true);
}

export function beforeFooter(): Spot | null {
  return spot(ink.footer(), 'before', true) ?? (document.body ? { parent: document.body, before: null, gutter: true } : null);
}

export function afterBanner(): Spot | null {
  return spot(ink.banner(), 'after', true) ?? afterHeader();
}

export function beforeShowcase(): Spot | null {
  return spot(ink.showcase(), 'before', true) ?? afterBanner();
}

/** Logo abaixo do preço do produto principal. */
export function belowPrice(): Spot | null {
  const form = mainProductForm();
  const price = form?.querySelector('p.text-4xl')?.closest('div.flex.flex-col') ?? form?.querySelector('p.text-4xl');
  return spot(price, 'after', false);
}

/** Abaixo do bloco de compra (depois do formulário do produto). */
export function belowBuy(): Spot | null {
  const form = mainProductForm();
  return spot(form, 'after', false);
}

export function insertAt(s: Spot, node: HTMLElement): void {
  if (s.gutter) node.style.cssText += 'display:block;max-width:1200px;margin:16px auto 24px;padding:0 16px;box-sizing:border-box;';
  s.parent.insertBefore(node, s.before && s.before.parentNode === s.parent ? s.before : null);
}

/** Espera um turbo-frame carregar (sem mexer nele enquanto busca). */
export function whenFrameReady(frame: Element | null, signal: AbortSignal, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    if (!frame) return resolve(false);
    // Frame com src só está pronto quando o Turbo marca "complete" (o conteúdo inicial é provisório).
    const ready = () => frame.hasAttribute('complete') || !frame.getAttribute('src');
    if (ready()) return resolve(true);
    const done = (v: boolean) => {
      clearTimeout(t);
      obs.disconnect();
      resolve(v);
    };
    const obs = new MutationObserver(() => {
      if (ready()) done(true);
    });
    obs.observe(frame, { attributes: true, attributeFilter: ['complete', 'busy'] });
    frame.addEventListener('turbo:frame-load', () => done(true), { once: true, signal });
    signal.addEventListener('abort', () => done(false), { once: true });
    const t = setTimeout(() => done(ready()), timeoutMs);
  });
}
