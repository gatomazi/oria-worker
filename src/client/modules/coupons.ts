// M05 — Cupons em destaque e em abas. Copiar só copia; "Usar no carrinho" só
// preenche o campo de cupom da própria INK (a INK valida e aplica). Nunca
// afirma que o desconto foi aplicado.
import { copyText, fetchDoc, formatWhen, h, selectContents, shadowHost, Undo } from '../runtime/dom.ts';
import { afterHeader, beforeFooter, belowPrice, insertAt } from '../runtime/page.ts';
import { parseProductPromotions, type NativeCoupon } from '../../shared/ink-parse.ts';
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
  /** Lido do frame nativo da INK (vale para o produto da página). */
  fromInk?: boolean;
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
  async mount(ctx: ModuleContext) {
    const s = ctx.settings as {
      mode: string;
      position: string;
      blockPages: string[];
      colors: { bg: string; fg: string };
      accent: { bg: string; fg: string };
      campaigns: Campaign[];
      inkCoupons?: boolean;
      productStyle?: string;
      productTitle?: string;
      cardBadge?: 'foto-esquerda' | 'foto-direita' | 'abaixo-preco';
    };
    const { signal } = ctx;
    const now = Date.now();
    const live = s.campaigns.filter((c) => effective(c, now));
    const next = nextTransition(s.campaigns, now);
    if (next) ctx.requestReconcile(next);
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const render = (live: Campaign[]): (() => void) => {
      const undo = new Undo();

      // Produto: abas compactas junto ao preço (uma por código), no lugar do bloco.
      let compact = false;
      if (ctx.page === 'product' && s.productStyle !== 'bloco' && (s.blockPages.includes('product') || s.inkCoupons)) {
        const spot = belowPrice();
        if (spot) {
          const host = productTabs(live, s.productTitle ?? '', ctx, s.accent, timers);
          undo.insert(host, spot.parent, spot.before);
          compact = true;
          // Os cupons da INK já estão nas abas: o quadro nativo sairia repetido.
          const native = document.querySelector<HTMLElement>('#product_promotions_frame');
          if (native && live.some((c) => c.fromInk)) undo.hide(native);
        }
      }

      // Bloco principal
      if (s.blockPages.includes(ctx.page) && !compact) {
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
      // Selo nos cards só com campanha do painel: o cupom lido da INK vale para ESTE produto.
      const badge = live.find((c) => c.nearPrice && c.badge && !c.fromInk);
      const productBadge = live.find((c) => c.nearPrice && c.badge);
      if (badge || productBadge) {
        const mk = (badge: Campaign) => {
          const b = h('span', { 'data-pink-module': 'coupons', 'data-pink-badge': '' }, badge.badge);
          b.title = badge.firstPurchase ? `${badge.badge} — cupom ${badge.code}, só na primeira compra` : `${badge.badge} — cupom ${badge.code}`;
          b.style.cssText = `display:inline-block;align-self:flex-start;justify-self:start;width:max-content;max-width:100%;margin:4px 0 0;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:700;line-height:1.5;background:${s.accent.bg};color:${s.accent.fg};white-space:nowrap`;
          return b;
        };
        if (badge) document.querySelectorAll('.card-thumb .card-thumb__prices-v2').forEach((price) => {
          const b = mk(badge);
          // Cards estreitos (vitrines no celular): quebra a linha em vez de cortar o texto.
          b.style.whiteSpace = 'normal';
          b.style.width = 'auto';
          b.style.fontSize = '11.5px';
          b.style.lineHeight = '1.3';
          b.style.textAlign = 'center';
          b.style.overflowWrap = 'anywhere';
          // Vitrines com 4 cards lado a lado no celular (~80 px): não cabe selo legível. Fica de fora.
          const card = price.closest<HTMLElement>('.card-thumb');
          const cardW = card?.getBoundingClientRect().width ?? 0;
          if (cardW > 0 && cardW < 120) return;
          // Sobre a foto: no canto de cima do quadro da imagem (a INK já o posiciona como relative),
          // numa linha só. Quadro sem largura (vitrine que a INK esconde no celular) → abaixo do preço.
          const frame = s.cardBadge !== 'abaixo-preco' ? card?.querySelector<HTMLElement>('.card-thumb__image-v2')?.parentElement : null;
          const frameW = frame?.getBoundingClientRect().width ?? 0;
          if (frame && (frameW === 0 ? cardW === 0 : frameW >= 120)) {
            if (getComputedStyle(frame).position === 'static') undo.style(frame, 'position', 'relative');
            const side = s.cardBadge === 'foto-direita' ? 'right' : 'left';
            b.style.cssText += `;position:absolute;top:8px;${side}:8px;z-index:1;margin:0;max-width:calc(100% - 16px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 3px rgba(0,0,0,.16),0 4px 12px rgba(0,0,0,.08);pointer-events:none`;
            undo.insert(b, frame, null);
          } else undo.insert(b, price.parentNode!, price.nextSibling);
        });
        if (ctx.page === 'product' && productBadge && !compact) {
          const spot = belowPrice();
          if (spot) {
            const b = mk(productBadge);
            b.style.margin = '8px 0 0';
            undo.insert(b, spot.parent, spot.before);
          }
        }
      }
      return () => undo.run();
    };

    // Cupons do painel aparecem na hora. Os que a própria INK oferece para este produto
    // (mesmo código e regras) chegam depois e entram em seguida, sem repetir códigos.
    let teardown = live.length ? render(live) : null;
    if (s.inkCoupons && ctx.page === 'product') {
      const fromInk = loadInkCoupons(signal).then((found) => found.filter((n) => !live.some((c) => c.code.toUpperCase() === n.code.toUpperCase())));
      if (!teardown) {
        const add = await fromInk;
        if (signal.aborted || !add.length) return null;
        teardown = render(add);
      } else {
        void fromInk.then((add) => {
          if (signal.aborted || !add.length) return;
          teardown?.();
          teardown = render([...live, ...add]);
        });
      }
    }
    if (!teardown) return null;

    return {
      destroy() {
        timers.forEach((t) => clearTimeout(t));
        teardown?.();
      },
    };
  },
};

const TABS_CSS = `
:host{display:block;margin:14px 0 4px;max-width:460px;container-type:inline-size}
.ttl{margin:0 0 8px;font-size:16px;font-weight:600;line-height:1.4}
.tabs{display:flex;gap:6px;margin-bottom:-1px;overflow-x:auto;scrollbar-width:none;position:relative;z-index:1}
.tabs::-webkit-scrollbar{display:none}
.tabs[data-more]{-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 28px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 28px),transparent)}
.tab{flex:1 0 auto;min-width:0;min-height:40px;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:0 12px;border:1px solid var(--line);border-radius:10px 10px 0 0;background:#fff;color:color-mix(in srgb,var(--ac) 72%,#fff);font:600 13.5px/1 inherit;letter-spacing:.02em;white-space:nowrap;cursor:pointer}
.tab[aria-selected="true"]{background:var(--tint);border-bottom-color:var(--tint);color:var(--ac);cursor:default}
.tab:focus-visible{outline:2px solid var(--ac);outline-offset:-3px}
.tab svg{flex:none;width:14px;height:14px;fill:currentColor}
span.tab{cursor:default;flex:0 0 auto}
.panel{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 14px;border:1px solid var(--line);border-radius:0 10px 10px 10px;background:var(--tint)}
.panel[hidden]{display:none}
.txt{min-width:0;color:var(--ink)}
.main{margin:0;font-weight:600;font-size:14.5px;line-height:1.35}
.sub{margin:2px 0 0;font-size:13.5px;line-height:1.35}
.meta{margin:4px 0 0;font-size:12.5px;opacity:.8}
details{margin-top:4px;font-size:12.5px}
summary{cursor:pointer;text-decoration:underline;text-underline-offset:2px;width:max-content}
details p{margin:4px 0 0;white-space:pre-line}
.acts{flex:none;display:flex;flex-direction:column;align-items:stretch;gap:6px}
.copy{min-height:40px;padding:8px 18px;border:0;border-radius:999px;background:var(--ac);color:var(--on-ac);font-weight:700;font-size:12.5px;letter-spacing:.05em;text-transform:uppercase;cursor:pointer}
.copy[data-done]{background:color-mix(in srgb,var(--ac) 80%,#000)}
.use{min-height:32px;padding:4px 8px;border:0;background:transparent;color:var(--ac);font-weight:600;font-size:12.5px;text-decoration:underline;cursor:pointer}
.status{margin:6px 2px 0;font-size:13px;color:var(--ink)}
.status:empty{display:none}
@container (max-width:420px){.tabs{gap:4px}.tab{padding:0 8px;font-size:12.5px;gap:4px}.tab svg{width:12px;height:12px}}
@container (max-width:380px){.panel{flex-direction:column;align-items:stretch}.acts{flex-direction:row}.copy{flex:1}}
`;
const TAG_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h4.09a1.5 1.5 0 0 1 1.06.44l7 7a1.5 1.5 0 0 1 0 2.12l-4.09 4.09a1.5 1.5 0 0 1-2.12 0l-7-7A1.5 1.5 0 0 1 1 6.59V2.5Zm3.5 3a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"/></svg>';

/** Quadro compacto do produto: uma aba por código, texto curto e "Copiar". */
function productTabs(live: Campaign[], title: string, ctx: ModuleContext, accent: { bg: string; fg: string }, timers: Set<ReturnType<typeof setTimeout>>): HTMLElement {
  const { signal } = ctx;
  const { host, root } = shadowHost('coupons', ctx.theme, TABS_CSS, { 'data-pink-coupon-tabs': '' });
  root.append(h('style', {}, `:host{--ac:${accent.bg};--on-ac:${accent.fg};--tint:color-mix(in srgb,${accent.bg} 7%,#fff);--line:color-mix(in srgb,${accent.bg} 28%,#fff);--ink:color-mix(in srgb,${accent.bg} 70%,#111)}`));
  const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const multi = live.length > 1;
  const icon = () => {
    const t = document.createElement('template');
    t.innerHTML = TAG_ICON;
    return t.content.firstChild!;
  };
  const tabs = live.map((c, i) => {
    const attrs = multi
      ? { class: 'tab', type: 'button', role: 'tab', id: `pk-ct-${i}`, 'aria-controls': `pk-cp-${i}`, 'aria-selected': i === 0 ? 'true' : 'false', tabindex: i === 0 ? '0' : '-1' }
      : { class: 'tab', 'aria-selected': 'true' };
    const el = h(multi ? 'button' : 'span', attrs, icon(), h('span', {}, c.code));
    return el;
  });
  const panels = live.map((c, i) => {
    const copy = h('button', { class: 'copy', type: 'button', 'aria-label': `Copiar o código ${c.code}` }, 'Copiar');
    const use = h('button', { class: 'use', type: 'button' }, 'Usar no carrinho');
    use.hidden = !cartCouponInput();
    let reset: ReturnType<typeof setTimeout> | undefined;
    copy.addEventListener('click', async () => {
      const ok = await copyText(c.code, root);
      if (signal.aborted) return;
      clearTimeout(reset);
      if (ok) {
        status.textContent = MESSAGES.copied;
        copy.textContent = 'Copiado';
        copy.setAttribute('data-done', '');
        reset = setTimeout(() => {
          copy.textContent = 'Copiar';
          copy.removeAttribute('data-done');
        }, 2500);
        timers.add(reset);
      } else {
        status.textContent = `${MESSAGES.copyFailed} Código: ${c.code}`;
      }
    }, { signal });
    use.addEventListener('click', () => {
      // Só preenche o campo da INK; quem valida e aplica é a loja.
      const input = cartCouponInput();
      if (!input) {
        status.textContent = MESSAGES.noCartField;
        return;
      }
      [...document.querySelectorAll<HTMLElement>('[id^="shopping-cart-menu"]')].find((b) => b.getClientRects().length)?.click();
      input.value = c.code;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => input.focus(), 250);
      status.textContent = MESSAGES.filled;
    }, { signal });
    const meta = [c.firstPurchase ? 'Só na primeira compra' : '', c.endsAt ? `Válido até ${formatWhen(c.endsAt)}` : ''].filter(Boolean).join(' · ');
    return h(
      'div',
      { class: 'panel', ...(multi ? { role: 'tabpanel', id: `pk-cp-${i}`, 'aria-labelledby': `pk-ct-${i}` } : {}), hidden: i === 0 ? undefined : '' },
      h('div', { class: 'txt' },
        h('p', { class: 'main' }, c.title),
        c.description ? h('p', { class: 'sub' }, c.description) : null,
        meta ? h('p', { class: 'meta' }, meta) : null,
        c.conditions ? h('details', {}, h('summary', {}, 'Condições'), h('p', {}, c.conditions)) : null,
      ),
      h('div', { class: 'acts' }, copy, use),
    );
  });
  if (multi) {
    const select = (i: number, focus = false) => {
      tabs.forEach((t, j) => {
        t.setAttribute('aria-selected', String(i === j));
        (t as HTMLElement).tabIndex = i === j ? 0 : -1;
        panels[j]!.hidden = i !== j;
      });
      status.textContent = '';
      if (focus) (tabs[i] as HTMLElement).focus();
      (tabs[i] as HTMLElement).scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    };
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => select(i), { signal });
      t.addEventListener('keydown', (e) => {
        const k = (e as KeyboardEvent).key;
        if (k === 'ArrowRight' || k === 'ArrowLeft') {
          e.preventDefault();
          select((i + (k === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length, true);
        }
      }, { signal });
    });
  }
  ctx.cart.onChange(() => {
    const has = !!cartCouponInput();
    root.querySelectorAll<HTMLButtonElement>('.use').forEach((b) => (b.hidden = !has));
  }, signal);
  // Abas que não cabem: rolagem lateral com esmaecido na borda enquanto houver mais à direita.
  const strip = h('div', { class: 'tabs', ...(multi ? { role: 'tablist', 'aria-label': 'Cupons' } : {}) }, ...tabs);
  const more = () => strip.toggleAttribute('data-more', strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2);
  strip.addEventListener('scroll', more, { signal, passive: true });
  window.addEventListener('resize', more, { signal, passive: true });
  requestAnimationFrame(more);
  root.append(
    h('section', { 'aria-label': title || 'Cupons' },
      title ? h('p', { class: 'ttl' }, title) : null,
      strip,
      ...panels,
      status,
    ),
  );
  return host;
}

/** Cupons do frame nativo product_promotions. O frame é "lazy" (só carrega ao rolar): lê o endereço dele direto. */
async function loadInkCoupons(signal: AbortSignal): Promise<Campaign[]> {
  const frame = document.querySelector('#product_promotions_frame');
  if (!frame) return [];
  let found: NativeCoupon[] = [];
  try {
    const src = frame.getAttribute('src');
    if (frame.hasAttribute('complete') || !src) found = parseProductPromotions(frame);
    else {
      const url = new URL(src, location.href);
      if (url.origin !== location.origin) return [];
      found = parseProductPromotions(await fetchDoc(url.pathname + url.search, signal));
    }
  } catch {
    return [];
  }
  return found.map((n) => {
    const tiers = n.rules.filter((r) => /^\d+\s*ite/i.test(r));
    return {
      title: n.firstPurchase ? `Primeira compra${n.off ? `: ${n.off}` : ''}` : tiers.length ? 'Leve mais, pague menos' : n.off ? `Cupom ${n.off}` : `Cupom ${n.code}`,
      description: n.savings,
      code: n.code,
      conditions: `Regras da loja: ${n.rules.join('; ')}.`,
      startsAt: null,
      endsAt: null,
      firstPurchase: n.firstPurchase,
      nearPrice: n.firstPurchase && !!n.off,
      badge: n.firstPurchase && n.off ? `${n.off} na 1ª compra` : '',
      fromInk: true,
    };
  });
}

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
