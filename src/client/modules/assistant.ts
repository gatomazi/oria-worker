// M10 — Assistente da loja. Respostas vêm do servidor (base de respostas da
// loja + catálogo; IA opcional). Aqui só a interface: botão flutuante,
// painel, sugestões, produtos e encaminhamento ao atendimento.
import { h, isMobile, safeHref, shadowHost } from '../runtime/dom.ts';
import type { ClientModule, ModuleContext } from '../runtime/types.ts';

interface Reply {
  answer?: string;
  products?: { title: string; path: string; priceText: string; imageUrl: string }[];
  contact?: { label: string; url: string } | null;
  link?: { label: string; path: string };
  related?: string[];
  remaining?: number;
  error?: string;
  message?: string;
}

const CSS = `
:host{position:fixed;z-index:32}
.launch{display:inline-flex;align-items:center;gap:8px;min-height:48px;padding:10px 16px;border:0;border-radius:999px;background:var(--ac);color:var(--on-ac);font-weight:700;box-shadow:0 6px 18px rgba(0,0,0,.25)}
.launch svg{width:20px;height:20px}
.invite{position:absolute;bottom:58px;right:0;max-width:240px;padding:10px 12px;background:#fff;color:#1f1f1f;border-radius:12px;box-shadow:0 6px 18px rgba(0,0,0,.2);font-size:14px}
:host([data-side="left"]) .invite{right:auto;left:0}
.invite button{margin-left:6px;border:0;background:transparent;color:#666;font-size:16px}
.panel{position:fixed;bottom:16px;width:min(380px,calc(100vw - 24px));max-height:min(620px,calc(100vh - 32px));display:flex;flex-direction:column;background:#fff;color:#1f1f1f;border-radius:var(--pk-radius);box-shadow:0 18px 48px rgba(0,0,0,.3);overflow:hidden}
:host([data-side="right"]) .panel{right:12px}
:host([data-side="left"]) .panel{left:12px}
.top{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:12px 14px;background:var(--ac);color:var(--on-ac)}
.top p{margin:0;font-weight:700}
.top button{border:1px solid currentColor;background:transparent;color:inherit;border-radius:8px;min-height:34px;padding:4px 10px}
.log{flex:1;overflow-y:auto;padding:12px;display:grid;gap:10px;align-content:start}
.msg{max-width:88%;padding:9px 12px;border-radius:12px;font-size:14px;line-height:1.45;white-space:pre-line}
.bot{background:#f2f2f2;justify-self:start}
.me{background:var(--ac);color:var(--on-ac);justify-self:end}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{border:1px solid #cfcfcf;background:#fff;border-radius:999px;padding:6px 10px;font-size:13px;color:#1f1f1f}
.prods{display:grid;gap:6px}
.prod{display:grid;grid-template-columns:48px 1fr;gap:8px;align-items:center;text-decoration:none;color:#1f1f1f;font-size:13px;border:1px solid #e6e6e6;border-radius:8px;padding:6px}
.prod img{width:48px;height:48px;object-fit:cover;border-radius:6px;background:#eee}
.act{display:inline-flex;min-height:38px;align-items:center;padding:6px 12px;border-radius:8px;background:#fff;border:1px solid var(--ac);color:#1f1f1f;text-decoration:none;font-weight:600;font-size:13.5px}
form{display:flex;gap:6px;padding:10px;border-top:1px solid #eee}
input{flex:1;min-height:44px;border:1px solid #cfcfcf;border-radius:10px;padding:8px 12px;font:inherit;font-size:16px}
.send{min-height:44px;background:var(--ac);color:var(--on-ac);padding:8px 14px}
.foot{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:0 12px 10px;font-size:12px;color:#666}
@media (max-width:767px){.panel{left:0!important;right:0!important;bottom:0;width:100%;max-height:85vh;border-radius:16px 16px 0 0}}
`;

const assistantModule: ClientModule = {
  mount(ctx: ModuleContext) {
    const s = ctx.settings as { name: string; greeting: string; suggestions: string[]; contactLabel: string; hours: string; proactive: string; proactiveDelay: number; proactiveMessage: string; maxMessages: number; position: string; colors: { bg: string; fg: string } };
    const side: 'left' | 'right' = s.position === 'inferior-esquerda' ? 'left' : 'right';
    const { signal } = ctx;
    const previewToken = document.querySelector<HTMLScriptElement>('script[data-pink-loader]')?.dataset.pinkPreview ?? '';
    let sessionId = '';
    try {
      sessionId = sessionStorage.getItem('pink-assistant-session') ?? '';
      if (!sessionId) {
        sessionId = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
        sessionStorage.setItem('pink-assistant-session', sessionId);
      }
    } catch {
      sessionId = Math.random().toString(36).slice(2, 14);
    }

    const { host, root } = shadowHost('assistant', ctx.theme, CSS, { 'data-side': side });
    root.append(h('style', {}, `:host{--ac:${s.colors.bg};--on-ac:${s.colors.fg}}`));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M4 5h16v11H9l-5 4z"/>';
    const launch = h('button', { type: 'button', class: 'launch', 'aria-expanded': 'false', 'aria-controls': 'pk-assist' }, svg, s.name);
    const log = h('div', { class: 'log', role: 'log', 'aria-live': 'polite' });
    const input = h('input', { type: 'text', maxlength: '400', 'aria-label': 'Sua pergunta', placeholder: 'Escreva sua pergunta', autocomplete: 'off' });
    const send = h('button', { type: 'submit', class: 'btn send' }, 'Enviar');
    const form = h('form', {}, input, send);
    const remainingEl = h('span');
    const close = h('button', { type: 'button' }, 'Fechar');
    const panel = h('div', { class: 'panel', id: 'pk-assist', role: 'dialog', 'aria-label': s.name, hidden: true }, h('div', { class: 'top' }, h('p', {}, s.name), close), log, form, h('div', { class: 'foot' }, h('span', {}, s.hours ? `Atendimento: ${s.hours}` : ''), remainingEl));
    root.append(launch, panel);

    const bubble = (text: string, who: 'bot' | 'me') => {
      const el = h('div', { class: `msg ${who}` }, text);
      log.append(el);
      log.scrollTop = log.scrollHeight;
      return el;
    };
    const chips = (items: string[]) => {
      if (!items.length) return;
      const box = h('div', { class: 'chips' }, ...items.map((t) => {
        const c = h('button', { type: 'button', class: 'chip' }, t);
        c.addEventListener('click', () => void ask(t), { signal });
        return c;
      }));
      log.append(box);
    };
    let started = false;
    const isOpen = () => !panel.hidden;
    const setOpen = (open: boolean) => {
      panel.hidden = !open;
      launch.hidden = open && isMobile();
      launch.setAttribute('aria-expanded', String(open));
      if (open) {
        invite?.remove();
        if (!started) {
          started = true;
          bubble(s.greeting, 'bot');
          chips(s.suggestions);
        }
        ctx.floating.opened('assistant');
        input.focus();
      } else launch.focus();
      ctx.floating.layout();
    };
    launch.addEventListener('click', () => setOpen(!isOpen()), { signal });
    close.addEventListener('click', () => setOpen(false), { signal });
    root.addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Escape' && isOpen() && setOpen(false), { signal });

    async function ask(text: string): Promise<void> {
      const q = text.trim();
      if (!q) return;
      bubble(q, 'me');
      input.value = '';
      send.disabled = true;
      const typing = bubble('…', 'bot');
      try {
        const res = await fetch('/__pink/assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit', signal, body: JSON.stringify({ sessionId, message: q, previewToken: previewToken || undefined }) });
        const r = (await res.json()) as Reply;
        typing.remove();
        bubble(r.answer ?? r.message ?? 'Não consegui responder agora.', 'bot');
        if (r.products?.length) {
          log.append(h('div', { class: 'prods' }, ...r.products.map((p) => h('a', { class: 'prod', href: safeHref(p.path) }, p.imageUrl ? h('img', { src: p.imageUrl, alt: '', loading: 'lazy' }) : h('span'), h('span', {}, p.title, p.priceText ? h('br') : '', p.priceText)))));
        }
        const acts: HTMLElement[] = [];
        if (r.link && safeHref(r.link.path)) acts.push(h('a', { class: 'act', href: safeHref(r.link.path) }, r.link.label));
        if (r.contact && safeHref(r.contact.url).startsWith('https://')) acts.push(h('a', { class: 'act', href: safeHref(r.contact.url), target: '_blank', rel: 'noopener' }, r.contact.label));
        if (acts.length) log.append(h('div', { class: 'chips' }, ...acts));
        if (r.related?.length) chips(r.related.slice(0, 2));
        if (typeof r.remaining === 'number') {
          remainingEl.textContent = r.remaining > 0 ? `${r.remaining} pergunta(s) restante(s)` : 'Limite desta visita atingido';
          input.disabled = r.remaining <= 0;
        }
        log.scrollTop = log.scrollHeight;
      } catch {
        typing.remove();
        if (!signal.aborted) bubble('Não consegui responder agora. Tente de novo em instantes.', 'bot');
      } finally {
        send.disabled = false;
      }
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void ask(input.value);
    }, { signal });

    // Convite (opcional), uma vez por visita.
    let invite: HTMLElement | null = null;
    let inviteTimer: ReturnType<typeof setTimeout> | undefined;
    let invited = false;
    try {
      invited = sessionStorage.getItem('pink-assistant-invited') === '1';
    } catch {
      invited = false;
    }
    if (s.proactive === 'convite' && s.proactiveMessage && !invited) {
      inviteTimer = setTimeout(() => {
        if (signal.aborted || isOpen() || ctx.floating.blocked()) return;
        const x = h('button', { type: 'button', 'aria-label': 'Dispensar convite' }, '×');
        invite = h('div', { class: 'invite', role: 'status' }, s.proactiveMessage, x);
        x.addEventListener('click', () => invite?.remove(), { signal });
        root.append(invite);
        try {
          sessionStorage.setItem('pink-assistant-invited', '1');
        } catch {
          // ok
        }
      }, s.proactiveDelay * 1000);
    }

    document.body.append(host);
    ctx.floating.register({ id: 'assistant', side, yields: false, el: host, isPanelOpen: isOpen, collapse: () => setOpen(false) }, signal);
    return {
      destroy() {
        clearTimeout(inviteTimer);
        host.remove();
      },
    };
  },
};

export default assistantModule;
