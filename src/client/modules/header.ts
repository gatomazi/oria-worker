// M01 — Cabeçalho, menu e busca. Ajusta o cabeçalho NATIVO da INK (barras de
// celular e computador) sem trocar destinos, carrinho nem conta. Tudo que é
// alterado entra numa pilha de desfazer; ao desligar, a página volta ao original.
import { h, safeHref, Undo } from '../runtime/dom.ts';
import type { ClientModule, ModuleContext } from '../runtime/types.ts';
import { attachSearchSuggest } from './search-suggest.ts';

interface MenuItem {
  label: string;
  path: string;
  group: string;
}

/** Itens de conta/pedido do menu do celular: nunca são escondidos. */
const ACCOUNT_LINK = /store_sessions|\/orders|trackings|guest_reviews/;

const headerModule: ClientModule = {
  mount(ctx: ModuleContext) {
    const s = ctx.settings as {
      layout: string;
      behavior: string;
      colors: { bg: string; fg: string };
      logoUrl: string;
      logoWidth: number;
      menu: MenuItem[];
      searchMode: string;
      searchPlaceholder: string;
      instantSearch?: boolean;
      benefits: string;
    };
    const header = document.querySelector<HTMLElement>('header.header');
    if (!header) return null;
    const navs = [...header.querySelectorAll<HTMLElement>(':scope > nav.navbar')];
    const desktopNav = navs.find((n) => n.querySelector(':scope > ul.navbar-list'));
    const mobileNav = navs.find((n) => n !== desktopNav);
    // Estrutura diferente da homologada: não mexe (o nativo continua).
    if (!desktopNav || !mobileNav) return null;

    const undo = new Undo();
    const { signal } = ctx;
    undo.attr(header, 'data-pink-header', '');
    const bg = s.colors.bg;
    const fg = s.colors.fg;
    const css: string[] = [
      `header.header[data-pink-header],header.header[data-pink-header] .brand-color,header.header[data-pink-header] .navbar-list.brand-color,#product-sidebar,#collection-sidebar{background-color:${bg}!important;color:${fg}!important}`,
      `header.header[data-pink-header] a,header.header[data-pink-header] .navbar-list__item,header.header[data-pink-header] button,header.header[data-pink-header] [data-feather],header.header[data-pink-header] .text-store-font{color:${fg}!important}`,
      `header.header[data-pink-header] .menu-filters a,header.header[data-pink-header] .menu-user a{color:#1f1f1f!important}`,
      // Logo cabe na faixa em qualquer formato (quadrado, horizontal, vertical): limitado pela
      // largura configurada E por uma altura máxima, sem cortar. No celular a faixa cresce até
      // essa altura e a busca vem logo abaixo, sem cobrir a marca.
      `header.header[data-pink-header] a.brand{display:flex;align-items:center;justify-content:center;flex:none;line-height:0}`,
      `header.header[data-pink-header] a.brand img{width:auto!important;height:auto!important;max-width:${s.logoWidth}px!important;max-height:60px!important;object-fit:contain}`,
      `@media (max-width:1023px){header.header[data-pink-header] a.brand img{max-width:min(${s.logoWidth}px,40vw)!important;max-height:48px!important}` +
        `header.header[data-pink-header] .navbar__top{height:auto!important;min-height:48px;align-items:center!important;padding-bottom:4px}}`,
    ];

    // Disposição (computador): nativo = links | logo | busca+ícones.
    if (s.layout === 'logo-esquerda') {
      css.push(
        `header.header[data-pink-header] nav.navbar > a.brand{order:-1;margin-right:24px}`,
        `header.header[data-pink-header] nav.navbar > ul.navbar-list{order:0;margin-right:auto}`,
        `header.header[data-pink-header] nav.navbar > .inline-flex{order:1}`,
      );
    }
    // Faixa de benefícios da INK.
    if (s.benefits === 'ocultar') {
      const benefits = header.querySelector<HTMLElement>('.header-benefits');
      if (benefits) undo.hide(benefits);
    }
    // Busca sempre visível (a INK esconde o campo até receber foco).
    if (s.searchMode === 'barra') {
      css.push(
        `#search_filter{opacity:1!important;pointer-events:auto!important;min-width:min(280px,24vw)}`,
        `#search_filter_mobile{opacity:1!important;height:44px!important;margin:6px 0 10px!important;pointer-events:auto!important}`,
      );
    }
    const searchInputs = [...header.querySelectorAll<HTMLInputElement>('input[name="search_filter"]')];
    for (const input of searchInputs) {
      if (s.searchPlaceholder) undo.attr(input, 'placeholder', s.searchPlaceholder);
    }
    if (s.instantSearch && searchInputs.length) attachSearchSuggest(ctx, searchInputs, undo);
    // Logo da identidade (se definido).
    if (s.logoUrl && safeHref(s.logoUrl).startsWith('https://')) {
      for (const img of header.querySelectorAll<HTMLImageElement>('a.brand img')) undo.attr(img, 'src', safeHref(s.logoUrl));
    }

    // Menu configurado: substitui só os links de navegação; conta e carrinho ficam.
    const menu = s.menu.filter((m) => safeHref(m.path));
    if (menu.length) {
      const groups = new Map<string, MenuItem[]>();
      const order: (MenuItem | string)[] = [];
      for (const m of menu) {
        if (m.group) {
          if (!groups.has(m.group)) {
            groups.set(m.group, []);
            order.push(m.group);
          }
          groups.get(m.group)!.push(m);
        } else order.push(m);
      }
      const current = location.pathname + location.search;
      const link = (m: MenuItem) => h('a', { href: safeHref(m.path), 'aria-current': current === m.path ? 'page' : undefined }, m.label);

      // Computador: lista horizontal com submenus <details>.
      const deskList = desktopNav.querySelector<HTMLElement>(':scope > ul.navbar-list')!;
      for (const li of deskList.querySelectorAll<HTMLElement>(':scope > li')) undo.hide(li);
      for (const entry of order) {
        const li = h('li', { class: 'navbar-list__item', 'data-pink-menu': '' });
        if (typeof entry === 'string') {
          const d = h('details', { class: 'pink-menu-group' }, h('summary', {}, entry), h('div', { class: 'pink-menu-panel' }, ...groups.get(entry)!.map(link)));
          li.append(d);
          document.addEventListener('click', (e) => !d.contains(e.target as Node) && d.removeAttribute('open'), { signal });
        } else li.append(link(entry));
        undo.insert(li, deskList, null);
      }
      css.push(
        `.pink-menu-group{position:relative}.pink-menu-group summary{cursor:pointer;list-style:none}.pink-menu-group summary::-webkit-details-marker{display:none}`,
        `.pink-menu-group summary::after{content:" ▾";font-size:.8em}`,
        `.pink-menu-panel{position:absolute;top:calc(100% + 8px);left:0;z-index:60;min-width:200px;display:grid;gap:2px;padding:8px;background:#fff;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.18)}`,
        `header.header[data-pink-header] .pink-menu-panel a{color:#1f1f1f!important;padding:8px 10px;border-radius:6px;text-decoration:none;white-space:nowrap}`,
        `header.header[data-pink-header] .pink-menu-panel a:hover{background:#f2f2f2}`,
        `header.header[data-pink-header] [data-pink-menu] a[aria-current="page"]{text-decoration:underline;text-underline-offset:6px}`,
      );

      // Celular: no topo da lista; itens de conta/pedidos continuam.
      const mobileList = mobileNav.querySelector<HTMLElement>('#navbar-list-mobile');
      const mobileSection = mobileList?.querySelector<HTMLElement>(':scope > section');
      if (mobileList && mobileSection) {
        for (const li of mobileSection.querySelectorAll<HTMLElement>(':scope > li')) {
          const a = li.querySelector('a');
          if (!a || !ACCOUNT_LINK.test(a.getAttribute('href') ?? '')) undo.hide(li);
        }
        for (const entry of order) {
          if (typeof entry === 'string') {
            const d = h('details', { class: 'pink-m-group' }, h('summary', {}, entry), ...groups.get(entry)!.map((m) => h('div', {}, link(m))));
            undo.insert(h('li', { 'data-pink-menu': '' }, d), mobileSection, mobileSection.firstChild);
          } else undo.insert(h('li', { 'data-pink-menu': '' }, link(entry)), mobileSection, mobileSection.firstChild);
        }
        // Mantém a ordem configurada (inseridos em ordem invertida acima).
        const ours = [...mobileSection.querySelectorAll(':scope > li[data-pink-menu]')].reverse();
        ours.forEach((li) => mobileSection.insertBefore(li, mobileSection.firstChild));
        css.push(`#navbar-list-mobile [data-pink-menu] a,#navbar-list-mobile .pink-m-group summary{display:block;font-size:16px;font-weight:500;padding:6px 0}#navbar-list-mobile .pink-m-group div a{padding-left:14px;font-size:15px}`);
      }
    }

    // Comportamento ao rolar.
    if (s.behavior === 'normal') undo.style(header, 'position', 'relative', 'important');
    else {
      undo.style(header, 'position', 'sticky', 'important');
      undo.style(header, 'top', '0px', 'important');
    }
    if (s.behavior === 'reaparece') {
      css.push(`header.header[data-pink-header]{transition:transform .22s ease}header.header[data-pink-header][data-pink-away]{transform:translateY(-100%)}`, `@media (prefers-reduced-motion:reduce){header.header[data-pink-header]{transition:none}}`);
      let lastY = window.scrollY;
      let raf = 0;
      window.addEventListener(
        'scroll',
        () => {
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => {
            const y = window.scrollY;
            const menuOpen = header.querySelector('#menu-hamburger[aria-expanded="true"], details[open], :focus-within');
            const away = y > header.offsetHeight + 40 && y > lastY && !menuOpen;
            if (away) header.setAttribute('data-pink-away', '');
            else if (y < lastY - 4 || y < header.offsetHeight) header.removeAttribute('data-pink-away');
            lastY = y;
          });
        },
        { signal, passive: true },
      );
      // Teclado: foco dentro do cabeçalho sempre o mostra.
      header.addEventListener('focusin', () => header.removeAttribute('data-pink-away'), { signal });
      undo.add(() => header.removeAttribute('data-pink-away'));
    }
    undo.css('header', css.join('\n'));

    return { destroy: () => undo.run() };
  },
};

export default headerModule;
