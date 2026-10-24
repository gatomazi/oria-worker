// M04 — Compartilhamento de produto: WhatsApp, copiar link e o compartilhar
// nativo do celular. O link vai limpo (sem parâmetros), no domínio da loja.
import { copyText, h, shadowHost, Undo } from '../runtime/dom.ts';
import { belowBuy, belowPrice, productInfo } from '../runtime/page.ts';
import type { ClientModule, ModuleContext } from '../runtime/types.ts';

const ICONS: Record<string, string> = {
  whatsapp: 'M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm5.4 14.1c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.4-.7-2.8-1.1-4.6-4-4.8-4.2-.1-.2-1.1-1.5-1.1-2.9s.7-2 1-2.3c.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.3.5-.4.4c-.1.1-.3.3-.1.6.1.3.7 1.2 1.6 1.9 1.1 1 2 1.3 2.3 1.4.3.1.5.1.6-.1l.9-1.1c.2-.3.4-.2.6-.1l1.9.9c.3.1.5.2.5.3.1.2.1.8-.1 1.4Z',
  copy: 'M9 9V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-4M5 9h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z',
  native: 'M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6',
};

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]!);
  if (name === 'whatsapp') path.setAttribute('fill', 'currentColor');
  else {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
  }
  svg.append(path);
  return svg;
}

const shareModule: ClientModule = {
  mount(ctx: ModuleContext) {
    const s = ctx.settings as { label: string; channels: string[]; message: string; position: string; colors: { bg: string; fg: string } };
    const spot = s.position === 'abaixo-preco' ? belowPrice() : belowBuy();
    if (!spot) return null;
    const name = (productInfo().name || document.querySelector('h1')?.textContent || 'Produto').trim().slice(0, 140);
    // Link limpo: canônico da loja quando bate com esta página; senão a própria URL sem parâmetros.
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? '';
    const url = canonical && new URL(canonical).pathname === location.pathname ? canonical : location.origin + location.pathname;
    const text = s.message.replace('{produto}', name);

    const undo = new Undo();
    const { signal } = ctx;
    const { host, root } = shadowHost(
      'share',
      ctx.theme,
      `:host{margin:14px 0}
      .box{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
      .label{margin:0 6px 0 0;font-size:14px;font-weight:600;color:#1f1f1f}
      .btn{min-height:40px;padding:8px 14px;font-size:14px;background:#fff;color:#1f1f1f;border:1px solid #d4d4d4}
      .btn:hover{border-color:var(--ac)}
      svg{width:18px;height:18px;color:var(--ac)}
      .status{flex-basis:100%;margin:0;font-size:13px;color:#333;min-height:0}
      .status:not(:empty){min-height:1.4em}`,
    );
    root.append(h('style', {}, `:host{--ac:${s.colors.bg}}`));
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const box = h('div', { class: 'box' }, h('p', { class: 'label' }, s.label));
    if (s.channels.includes('whatsapp')) {
      const a = h('a', { class: 'btn', href: `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`, target: '_blank', rel: 'noopener' }, icon('whatsapp'), 'WhatsApp');
      box.append(a);
    }
    if (s.channels.includes('copy')) {
      const b = h('button', { class: 'btn', type: 'button' }, icon('copy'), 'Copiar link');
      b.addEventListener(
        'click',
        async () => {
          const ok = await copyText(url, root);
          status.textContent = ok ? 'Link copiado.' : `Não foi possível copiar. O link é: ${url}`;
        },
        { signal },
      );
      box.append(b);
    }
    if (s.channels.includes('native') && typeof navigator.share === 'function') {
      const b = h('button', { class: 'btn', type: 'button' }, icon('native'), 'Compartilhar');
      b.addEventListener(
        'click',
        async () => {
          try {
            await navigator.share({ title: name, text, url });
          } catch (err) {
            if ((err as Error).name !== 'AbortError') status.textContent = 'O compartilhamento não abriu. Use copiar link.';
          }
        },
        { signal },
      );
      box.append(b);
    }
    root.append(box, status);
    undo.insert(host, spot.parent, spot.before);
    return { destroy: () => undo.run() };
  },
};

export default shareModule;
