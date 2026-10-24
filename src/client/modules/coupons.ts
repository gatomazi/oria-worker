// M05 — Cupons em destaque e em abas. Copiar só copia; "Usar no carrinho" só
// preenche o campo de cupom da própria INK (a INK valida e aplica). Nunca
// afirma que o desconto foi aplicado.
import { copyText, formatWhen, h, selectContents, shadowHost, Undo } from '../runtime/dom.ts';
import { afterHeader, beforeFooter, belowPrice, insertAt } from '../runtime/page.ts';
import type { ClientModule, ModuleContext } from '../runtime/types.ts';

interface Campaign {
  title: string;
  description: string;
  code: string;
  conditions: string;
  startsAt: string | null;
  endsAt: string | null;
  firstPurchase: boolean;
  nearPrice: boolean;
  badge: string;
}

export const MESSAGES = {
  copied: 'Código copiado. Cole no campo de cupom ao finalizar a compra.',
  copyFailed: 'Não foi possível copiar automaticamente. O código ficou selecionado: copie manualmente.',
  filled: 'Código colocado no campo de cupom do carrinho. Confirme lá: a loja valida as condições.',
  noCartField: 'O campo de cupom aparece no carrinho quando há produtos nele. Copie o código e use lá.',
} as const;

const CSS = `
.wrap{background:var(--bg);color:var(--fg);border:1px solid color-mix(in srgb,var(--fg) 16%,transparent);border-radius:var(--pk-radius);padding:16px 18px}
.tabs{display:flex;gap:6px;overflow-x:auto;margin:0 0 12px;padding:2px;scrollbar-width:thin}
.tab{flex:none;min-height:40px;padding:8px 14px;border-radius:var(--pk-btn-radius);border:1px solid color-mix(in srgb,var(--fg) 25%,transparent);background:transparent;color:inherit;font-weight:600;font-size:14px}
.tab[aria-selected="true"]{background:var(--ac);color:var(--on-ac);border-color:var(--ac)}
.list{display:grid;gap:12px}
.card{display:grid;gap:10px}
.card+.card{border-top:1px dashed color-mix(in srgb,var(--fg) 25%,transparent);padding-top:12px}
.title{margin:0;font-size:18px;line-height:1.25;font-weight:700;letter-spacing:-.01em;text-wrap:balance}
.desc{margin:2px 0 0}
.tag{display:inline-block;margin-top:4px;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:700;background:color-mix(in srgb,var(--ac) 14%,transparent);color:inherit}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:stretch}
.code{flex:2 1 170px;display:flex;align-items:center;justify-content:center;min-height:44px;padding:6px 12px;border:2px dashed var(--ac);border-radius:var(--pk-btn-radius);font:700 16px/1.2 ui-monospace,"SF Mono",Menlo,Consolas,monospace;letter-spacing:.04em;user-select:all;-webkit-user-select:all;white-space:nowrap;text-align:center}
@container (max-width:340px){.code{white-space:normal;overflow-wrap:anywhere}}
.copy{flex:1 1 120px;background:var(--ac);color:var(--on-ac)}
.use{flex:1 1 100%;background:transparent;color:inherit;border:1px solid color-mix(in srgb,var(--fg) 30%,transparent);min-height:40px;font-size:14px}
.status{margin:0;min-height:0;font-size:14px}
.status:not(:empty){min-height:1.45em}
.status[data-tone="error"]{font-weight:600}
.fine{margin:0;font-size:13px;opacity:.85;white-space:pre-line}
@container (min-width:640px){
  .card{grid-template-columns:minmax(0,1.3fr) minmax(260px,1fr);column-gap:24px;align-items:center}
  .card .fine{grid-column:1/-1}
  .use{flex-basis:auto}
  .title{font-size:20px}
}
:host{container-type:inline-size}
`;

function effective(c: Campaign, now: number): boolean {
  if (c.startsAt && now < Date.parse(c.startsAt)) return false;
  if (c.endsAt && now >= Date.parse(c.endsAt)) return false;
  return true;
}

function nextTransition(cs: Campaign[], now: number): number | undefined {
  return cs
    .flatMap((c) => [c.startsAt, c.endsAt])
    .map((d) => (d ? Date.parse(d) : NaN))
    .filter((t) => t > now)
    .sort((a, b) => a - b)[0];
}

function cartCouponInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('.cart-drawer input[name="cart[coupon][code]"]');
}

const couponsModule: ClientModule = {
  mount(ctx: ModuleContext) {
    const s = ctx.settings as {
      mode: string;
      position: string;
      blockPages: string[];
      colors: { bg: string; fg: string };
      accent: { bg: string; fg: string };
      campaigns: Campaign[];
    };
    const now = Date.now();
    const live = s.campaigns.filter((c) => effective(c, now));
    const next = nextTransition(s.campaigns, now);
    if (next) ctx.requestReconcile(next);
    if (!live.length) return null;

    const undo = new Undo();
    const { signal } = ctx;
    const timers = new Set<ReturnType<typeof setTimeout>>();

    // Bloco principal
    if (s.blockPages.includes(ctx.page)) {
      const spot = s.position === 'antes-rodape' ? beforeFooter() : afterHeader();
      if (spot) {
        const { host, root } = shadowHost('coupons', ctx.theme, CSS);
        host.style.setProperty('--bg', s.colors.bg);
        host.style.setProperty('--fg', s.colors.fg);
        host.style.setProperty('--ac', s.accent.bg);
        host.style.setProperty('--on-ac', s.accent.fg);
        root.append(h('style', {}, `:host{--bg:${s.colors.bg};--fg:${s.colors.fg};--ac:${s.accent.bg};--on-ac:${s.accent.fg}}`));
        const wrap = h('section', { class: 'wrap', 'aria-label': 'Cupons da loja' });
        const shown = s.mode === 'unico' ? live.slice(0, 1) : live;
        const cards = shown.map((c, i) => card(c, i, root, signal, timers));
        if (s.mode === 'abas' && cards.length > 1) {
          const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Campanhas' });
          const buttons = shown.map((c, i) => {
            const b = h('button', { class: 'tab', role: 'tab', type: 'button', id: `pk-tab-${i}`, 'aria-controls': `pk-panel-${i}`, 'aria-selected': i === 0 ? 'true' : 'false', tabindex: i === 0 ? '0' : '-1' }, c.title);
            return b;
          });
          const select = (i: number, focus = false) => {
            buttons.forEach((b, j) => {
              b.setAttribute('aria-selected', String(i === j));
              b.tabIndex = i === j ? 0 : -1;
              cards[j]!.hidden = i !== j;
            });
            if (focus) buttons[i]!.focus();
          };
          buttons.forEach((b, i) => {
            b.addEventListener('click', () => select(i), { signal });
            b.addEventListener(
              'keydown',
              (e) => {
                const k = (e as KeyboardEvent).key;
                if (k === 'ArrowRight' || k === 'ArrowLeft') {
                  e.preventDefault();
                  select((i + (k === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length, true);
                }
              },
              { signal },
            );
          });
          cards.forEach((c, i) => {
            c.id = `pk-panel-${i}`;
            c.setAttribute('role', 'tabpanel');
            c.setAttribute('aria-labelledby', `pk-tab-${i}`);
            c.hidden = i !== 0;
          });
          tabs.append(...buttons);
          wrap.append(tabs, ...cards);
        } else {
          wrap.append(h('div', { class: 'list' }, ...cards));
        }
        root.append(wrap);
        insertAt(spot, host);
        ctx.cart.onChange(() => {
          const has = !!cartCouponInput();
          root.querySelectorAll<HTMLButtonElement>('.use').forEach((b) => (b.hidden = !has));
        }, signal);
        undo.add(() => host.remove());
      }
    }

    // Selo perto do preço: cards de produto e página do produto.
    const badge = live.find((c) => c.nearPrice && c.badge);
    if (badge) {
      const mk = () => {
        const b = h('span', { 'data-pink-module': 'coupons', 'data-pink-badge': '' }, badge.badge);
        b.title = badge.firstPurchase ? `${badge.badge} — cupom ${badge.code}, só na primeira compra` : `${badge.badge} — cupom ${badge.code}`;
        b.style.cssText = `display:inline-block;align-self:flex-start;justify-self:start;width:max-content;max-width:100%;margin:4px 0 0;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:700;line-height:1.5;background:${s.accent.bg};color:${s.accent.fg};white-space:nowrap`;
        return b;
      };
      document.querySelectorAll('.card-thumb .card-thumb__prices-v2').forEach((price) => {
        const b = mk();
        undo.insert(b, price.parentNode!, price.nextSibling);
      });
      if (ctx.page === 'product') {
        const spot = belowPrice();
        if (spot) {
          const b = mk();
          b.style.margin = '8px 0 0';
          undo.insert(b, spot.parent, spot.before);
        }
      }
    }

    return {
      destroy() {
        timers.forEach((t) => clearTimeout(t));
        undo.run();
      },
    };
  },
};

function card(c: Campaign, i: number, root: ShadowRoot, signal: AbortSignal, timers: Set<ReturnType<typeof setTimeout>>): HTMLElement {
  const code = h('span', { class: 'code', 'aria-label': `Código do cupom: ${c.code}` }, c.code);
  const copy = h('button', { class: 'btn copy', type: 'button' }, 'Copiar código');
  const use = h('button', { class: 'btn use', type: 'button' }, 'Usar no carrinho');
  const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
  let reset: ReturnType<typeof setTimeout> | undefined;
  const say = (msg: string, tone: 'ok' | 'error') => {
    status.textContent = msg;
    status.dataset.tone = tone;
  };
  copy.addEventListener(
    'click',
    async () => {
      copy.disabled = true;
      const ok = await copyText(c.code, root);
      if (signal.aborted) return;
      copy.disabled = false;
      clearTimeout(reset);
      if (ok) {
        say(MESSAGES.copied, 'ok');
        copy.textContent = 'Copiado';
        reset = setTimeout(() => (copy.textContent = 'Copiar código'), 2500);
        timers.add(reset);
      } else {
        say(MESSAGES.copyFailed, 'error');
        selectContents(code);
      }
    },
    { signal },
  );
  use.addEventListener(
    'click',
    () => {
      // Só preenche o campo da INK; quem valida e aplica é a loja.
      const input = cartCouponInput();
      if (!input) {
        say(MESSAGES.noCartField, 'error');
        return;
      }
      const opener = [...document.querySelectorAll<HTMLElement>('[id^="shopping-cart-menu"]')].find((b) => b.getClientRects().length);
      opener?.click();
      input.value = c.code;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => input.focus(), 250);
      say(MESSAGES.filled, 'ok');
    },
    { signal },
  );
  const validity =
    c.startsAt && c.endsAt
      ? `Vigência: de ${formatWhen(c.startsAt)} até ${formatWhen(c.endsAt)}.`
      : c.endsAt
        ? `Válido até ${formatWhen(c.endsAt)}.`
        : '';
  const el = h(
    'article',
    { class: 'card', 'data-index': String(i) },
    h('div', {}, h('h2', { class: 'title' }, c.title), c.description ? h('p', { class: 'desc' }, c.description) : null, c.firstPurchase ? h('span', { class: 'tag' }, 'Só na primeira compra') : null),
    h('div', { class: 'row' }, code, copy, use),
    status,
    h('p', { class: 'fine' }, c.conditions),
    validity ? h('p', { class: 'fine' }, validity) : null,
  );
  // "Usar no carrinho" só aparece quando o carrinho da INK tem o campo de cupom.
  use.hidden = !cartCouponInput();
  return el;
}

export default couponsModule;
