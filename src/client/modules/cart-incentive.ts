// M06 — Incentivo para mais itens. Lê o carrinho que a INK renderiza, mostra
// quanto falta para a próxima faixa da campanha REAL configurada e, após uma
// adição confirmada pela INK, sugere produtos. Valores calculados aqui são
// estimativas; o total que vale é o da INK. Sem leitura confiável do
// carrinho, mostra só a regra geral. Se a barra de frete nativa da INK
// estiver ativa, a faixa de frete daqui sai (sem duplicar).
import { formatBrl, parseMostSolds, parseProductCards, parseProductPage, type CardProduct, type CartState } from '../../shared/ink-parse.ts';
import { cached, fetchDoc, h, safeHref, shadowHost } from '../runtime/dom.ts';
import type { ClientModule, ModuleContext } from '../runtime/types.ts';

interface Tier {
  threshold: number;
  benefit: 'frete' | 'percentual' | 'valor' | 'brinde';
  amount: number;
  label: string;
}

interface Settings {
  campaignName: string;
  measure: 'valor' | 'itens';
  tiers: Tier[];
  eligibility: 'todos' | 'colecao';
  eligiblePath: string;
  showInCart: boolean;
  showAfterAdd: boolean;
  recommendations: 'mais-vendidos' | 'colecao' | 'manual';
  recommendationPath: string;
  manualProducts: string[];
  recommendationCount: number;
  chooseMoreLabel: string;
  chooseMorePath: string;
  colors: { bg: string; fg: string };
}

export interface Progress {
  /** Quantidade elegível (centavos ou peças); null quando não dá para saber. */
  current: number | null;
  reached: Tier[];
  next: Tier | null;
  missing: number | null;
  estimate: boolean;
}

/** Cálculo puro (testado à parte). */
export function computeProgress(s: Pick<Settings, 'measure' | 'tiers'>, cart: CartState | null, eligible: Set<string> | null, nativeFreight: boolean): Progress {
  const tiers = s.tiers.filter((t) => !(nativeFreight && t.benefit === 'frete')).sort((a, b) => a.threshold - b.threshold);
  if (!cart) return { current: null, reached: [], next: tiers[0] ?? null, missing: null, estimate: true };
  // Participação: por id do produto (a INK não põe link do produto no item do carrinho) ou pelo caminho.
  const isEligible = (i: CartState['items'][number]) => !!eligible && ((!!i.productId && eligible.has(`id:${i.productId}`)) || (!!i.path && eligible.has(i.path)));
  const items = eligible ? cart.items.filter(isEligible) : cart.items;
  if (eligible && cart.items.some((i) => !i.productId && !i.path)) return { current: null, reached: [], next: tiers[0] ?? null, missing: null, estimate: true };
  let current: number | null;
  if (s.measure === 'itens') current = items.reduce((n, i) => n + i.quantity, 0);
  else if (items.every((i) => i.unitCents !== null)) current = items.reduce((n, i) => n + (i.unitCents ?? 0) * i.quantity, 0);
  else current = null;
  if (current === null) return { current: null, reached: [], next: tiers[0] ?? null, missing: null, estimate: true };
  const unit = s.measure === 'itens' ? 1 : 100;
  const reached = tiers.filter((t) => current! >= t.threshold * unit);
  const next = tiers.find((t) => current! < t.threshold * unit) ?? null;
  return { current, reached, next, missing: next ? next.threshold * unit - current : 0, estimate: s.measure === 'valor' };
}

function benefitText(t: Tier): string {
  return t.label;
}

function ruleText(s: Settings, t: Tier): string {
  return s.measure === 'itens' ? `${t.label} a partir de ${t.threshold} peça${t.threshold > 1 ? 's' : ''}` : `${t.label} a partir de ${formatBrl(t.threshold * 100)}`;
}

const CSS = `
.box{display:grid;gap:8px;padding:12px 14px;border-radius:var(--pk-radius);background:#fff;border:1px solid #e3e3e3;color:#1f1f1f;font-size:14px}
.msg{margin:0;font-weight:700;font-size:15px;line-height:1.35}
.msg strong{color:var(--ac)}
.bar{position:relative;height:8px;border-radius:999px;background:#ececec;overflow:hidden}
.fill{position:absolute;inset:0 auto 0 0;background:var(--ac);border-radius:999px;transition:width .3s ease}
.marks{display:flex;justify-content:space-between;gap:6px;font-size:12px;color:#555}
.mark[data-on="true"]{color:#1f1f1f;font-weight:700}
.fine{margin:0;font-size:12px;color:#666}
.recs{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;margin-top:4px}
.rec{display:grid;gap:4px;text-decoration:none;color:#1f1f1f;font-size:12.5px;line-height:1.3}
.rec img{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:6px;background:#f1f1f1}
.rec span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.more{justify-self:start;min-height:40px;font-size:14px;background:var(--ac);color:var(--on-ac)}
h3{margin:4px 0 0;font-size:14px}
@media (prefers-reduced-motion:reduce){.fill{transition:none}}
`;

const cartModule: ClientModule = {
  async mount(ctx: ModuleContext) {
    const s = ctx.settings as unknown as Settings;
    if (!s.tiers.length) return null;
    const { signal } = ctx;
    const nodes = new Set<HTMLElement>();
    let eligible: Set<string> | null = null;
    if (s.eligibility === 'colecao' && s.eligiblePath) {
      try {
        eligible = new Set(await cached(`eligible:${s.eligiblePath}`, 5 * 60_000, async () => parseProductCards(await fetchDoc(s.eligiblePath, signal), ctx.basePath).flatMap((p) => [p.path, `id:${p.id}`])));
      } catch {
        eligible = null; // sem como confirmar participação: mostra só a regra geral
      }
    }
    const style = `:host{--ac:${s.colors.bg};--on-ac:${s.colors.fg}}`;

    function block(cart: CartState | null, extraTitle?: string): HTMLElement {
      const { host, root } = shadowHost('cartIncentive', ctx.theme, CSS);
      root.append(h('style', {}, style));
      const nativeFreight = (cart?.nativeFreightGoalCents ?? 0) > 0;
      const p = computeProgress(s, cart, s.eligibility === 'colecao' ? eligible : null, nativeFreight);
      const tiers = s.tiers.filter((t) => !(nativeFreight && t.benefit === 'frete')).sort((a, b) => a.threshold - b.threshold);
      const box = h('div', { class: 'box', role: 'group', 'aria-label': `Campanha ${s.campaignName}` });
      if (extraTitle) box.append(h('h3', {}, extraTitle));
      if (p.current === null || (s.eligibility === 'colecao' && !eligible)) {
        // Regra geral, sem inventar valores.
        box.append(h('p', { class: 'msg' }, tiers.map((t) => ruleText(s, t)).join(' · ')), h('p', { class: 'fine' }, `Campanha ${s.campaignName}. Confira no carrinho as condições e os itens participantes.`));
        return wrap(host, box, root);
      }
      const fmt = (n: number) => (s.measure === 'itens' ? `${n} peça${n > 1 ? 's' : ''}` : formatBrl(n));
      const msg = h('p', { class: 'msg' });
      if (p.next) {
        msg.append('Faltam ', h('strong', {}, fmt(p.missing!)), ` para ${benefitText(p.next)}`);
        if (p.reached.length) msg.append(` (já garantido: ${p.reached[p.reached.length - 1]!.label})`);
      } else if (p.reached.length) msg.append('Você chegou a ', h('strong', {}, p.reached[p.reached.length - 1]!.label));
      const top = tiers[tiers.length - 1]!.threshold * (s.measure === 'itens' ? 1 : 100);
      const pct = Math.min(100, Math.round(((p.current ?? 0) / top) * 100));
      const fill = h('div', { class: 'fill' });
      fill.style.width = `${pct}%`;
      const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Progresso na campanha' }, fill);
      const marks = h('div', { class: 'marks', 'aria-hidden': 'true' }, ...tiers.map((t) => h('span', { class: 'mark', 'data-on': String(p.reached.includes(t)) }, s.measure === 'itens' ? `${t.threshold} pç` : formatBrl(t.threshold * 100))));
      box.append(msg, bar, marks, h('p', { class: 'fine' }, `Campanha ${s.campaignName}${eligible ? ' · só itens participantes' : ''}.${p.estimate ? ' Valores estimados a partir do carrinho; o total final é o da INK.' : ''}`));
      return wrap(host, box, root);
    }

    function wrap(host: HTMLElement, box: HTMLElement, root: ShadowRoot): HTMLElement {
      root.append(box);
      host.setAttribute('data-pink-cart-block', '');
      nodes.add(host);
      return host;
    }

    // --- dentro da gaveta do carrinho
    const placeInCart = (cart: CartState | null) => {
      if (!s.showInCart || signal.aborted) return;
      document.querySelectorAll('.cart-drawer [data-pink-cart-block]').forEach((n) => n.remove());
      const drawer = document.querySelector('.cart-drawer turbo-frame#cart');
      if (!drawer) return;
      const host = block(cart);
      // Dentro da lista (como item) para não espremer os produtos; vazio: no topo do estado vazio.
      const list = drawer.querySelector('.cart-drawer__main ul');
      const empty = drawer.querySelector('.empty-cart');
      if (list) {
        const li = h('li', { role: 'none', 'data-pink-cart-block': '' }, host);
        li.style.cssText = 'list-style:none;margin:0 0 12px';
        list.insertBefore(li, list.firstChild);
        nodes.add(li);
      } else if (empty) {
        host.style.margin = '0 16px 12px';
        empty.insertBefore(host, empty.firstChild);
      }
    };
    ctx.cart.onChange(placeInCart, signal);
    placeInCart(ctx.cart.read());

    // --- após adicionar (confirmado pela INK)
    if (s.showAfterAdd) {
      ctx.cart.onAdded(async (modal) => {
        if (signal.aborted) return;
        const cart = ctx.cart.read();
        const host = block(cart, 'Aproveite a campanha');
        const footer = modal.querySelector('.add-product-modal__modal-content__footer');
        if (footer?.parentNode) footer.parentNode.insertBefore(host, footer.nextSibling);
        else modal.append(host);
        const root = host.shadowRoot!;
        const box = root.querySelector('.box')!;
        const more = h('a', { class: 'btn more', href: safeHref(s.chooseMorePath) || safeHref(ctx.basePath) || '/' }, s.chooseMoreLabel);
        box.append(more);
        try {
          const recs = await recommendations(s, ctx, signal);
          if (recs.length && !signal.aborted) {
            box.insertBefore(h('div', { class: 'recs', 'aria-label': 'Sugestões' }, ...recs.map((r) => h('a', { class: 'rec', href: safeHref(r.path) }, r.imageUrl ? h('img', { src: r.imageUrl, alt: '', loading: 'lazy' }) : null, h('span', {}, r.title), r.priceText ? h('strong', {}, r.priceText) : null))), more);
          }
        } catch {
          // sem sugestões: confirmação e incentivo continuam
        }
      }, signal);
    }

    return {
      destroy() {
        nodes.forEach((n) => n.remove());
        document.querySelectorAll('[data-pink-cart-block]').forEach((n) => n.remove());
      },
    };
  },
};

async function recommendations(s: Settings, ctx: ModuleContext, signal: AbortSignal): Promise<CardProduct[]> {
  const here = location.pathname;
  let list: CardProduct[] = [];
  if (s.recommendations === 'mais-vendidos') list = await cached('most-sold', 5 * 60_000, async () => parseMostSolds(await fetchDoc(`${ctx.basePath}/cart/most_solds?empty_cart=true`, signal), ctx.basePath));
  else if (s.recommendations === 'colecao' && s.recommendationPath) list = await cached(`cards:${s.recommendationPath}`, 5 * 60_000, async () => parseProductCards(await fetchDoc(s.recommendationPath, signal), ctx.basePath));
  else if (s.recommendations === 'manual') {
    const docs = await Promise.allSettled(s.manualProducts.slice(0, s.recommendationCount + 1).map((p) => fetchDoc(p, signal).then((d) => ({ d, p }))));
    list = docs
      .filter((r): r is PromiseFulfilledResult<{ d: Document; p: string }> => r.status === 'fulfilled')
      .map(({ value }) => {
        const info = parseProductPage(value.d);
        return { id: info.id, path: value.p, title: info.name, priceText: info.price ? formatBrl(Math.round(info.price * 100)) : '', imageUrl: info.image };
      });
  }
  return list.filter((p) => p.path !== here).slice(0, s.recommendationCount);
}

export default cartModule;
