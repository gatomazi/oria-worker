// M13 — Aviso de cookies. Restiliza o aviso NATIVO da INK (.cookie-acceptance) com a
// identidade da loja: cartão no canto ou faixa no rodapé. Quem mostra, esconde e guarda
// o aceite continua sendo a INK (o botão é o dela); o módulo só muda a aparência e,
// se a loja quiser, o texto. Desmontar devolve tudo como era.
import { Undo } from '../runtime/dom.ts';
import { ink } from '../runtime/page.ts';
import type { ClientModule, ModuleContext } from '../runtime/types.ts';

interface Settings {
  layout: 'cartao' | 'faixa';
  side: 'esquerda' | 'direita';
  message: string;
  buttonLabel: string;
  colors: { bg: string; fg: string };
  accent: { bg: string; fg: string };
}

const SEL = '.cookie-acceptance[data-pink-cookie]';

function css(s: Settings, radius: number, btnRadius: number): string {
  const card = s.layout !== 'faixa';
  const side = s.side === 'direita' ? 'right' : 'left';
  const other = side === 'right' ? 'left' : 'right';
  const r = Math.min(Math.max(radius, 6), 18);
  return `
${SEL}{position:fixed!important;z-index:31;margin:0!important;box-sizing:border-box;display:flex!important;gap:12px 16px;
  bottom:calc(var(--pk-cookie-bottom,0px) + ${card ? '16px' : '0px'})!important;
  background:${s.colors.bg}!important;color:${s.colors.fg}!important;
  font-size:14px!important;line-height:1.5;text-align:left;
  box-shadow:0 1px 2px rgba(0,0,0,.06),0 10px 30px rgba(0,0,0,.14)!important;
  border:1px solid color-mix(in srgb,${s.colors.fg} 10%,transparent);
  ${card
    ? `${side}:16px!important;${other}:auto!important;width:min(380px,calc(100vw - 32px))!important;max-width:none!important;flex-direction:column!important;align-items:stretch;padding:16px 18px!important;border-radius:${r}px!important;`
    : `left:0!important;right:0!important;width:auto!important;max-width:none!important;flex-direction:row!important;align-items:center;justify-content:center;padding:12px max(16px,calc((100vw - 1100px) / 2))!important;border-radius:0!important;border-width:1px 0 0;`}
}
${SEL}:not([hidden]){animation:pk-cookie-in .32s cubic-bezier(.2,.8,.2,1)}
${SEL} p{margin:0!important;color:inherit!important;font:inherit!important;line-height:inherit!important;${card ? '' : 'max-width:70ch;'}}
${SEL} a{color:inherit!important;font-weight:600;text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
${SEL} a:hover{text-decoration-thickness:2px}
${SEL} button{margin:0!important;${card ? 'align-self:flex-end;' : 'flex:none;'}min-height:40px;padding:8px 20px!important;border:0!important;
  border-radius:${btnRadius}px!important;background:${s.accent.bg}!important;color:${s.accent.fg}!important;
  font:inherit;font-size:14px!important;font-weight:700;line-height:1.2;cursor:pointer;width:auto!important;transition:filter .15s ease}
${SEL} button:hover{filter:brightness(1.08)}
${SEL} button:focus-visible{outline:3px solid ${s.accent.bg};outline-offset:2px}
@media (max-width:600px){
  ${SEL}{left:12px!important;right:12px!important;width:auto!important;bottom:calc(var(--pk-cookie-bottom,0px) + 12px)!important;
    flex-direction:row!important;align-items:center;padding:12px 12px 12px 14px!important;border-radius:${r}px!important;border-width:1px;font-size:13px!important;gap:12px}
  ${SEL} p{max-width:none}
  ${SEL} button{align-self:center;flex:none;min-height:40px;padding:8px 14px!important;font-size:13px!important}
}
@keyframes pk-cookie-in{from{transform:translateY(12px);opacity:0}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){${SEL}:not([hidden]){animation:none}}
`;
}

const cookieModule: ClientModule = {
  mount(ctx: ModuleContext) {
    const el = ink.cookieBanner();
    if (!el) return null;
    const s = ctx.settings as unknown as Settings;
    const undo = new Undo();
    undo.attr(el, 'data-pink-cookie', '');
    undo.css('cookieNotice', css(s, ctx.theme.radius, ctx.theme.buttonRadius));

    // Texto: troca só o trecho antes do link; o link da Política de Privacidade fica.
    const p = el.querySelector('p');
    const lead = p?.firstChild;
    if (s.message.trim() && lead?.nodeType === Node.TEXT_NODE) {
      const before = lead.textContent;
      lead.textContent = `${s.message.trim()} `;
      undo.add(() => (lead.textContent = before));
    }
    const button = el.querySelector('button');
    if (button && s.buttonLabel.trim()) {
      const before = button.textContent;
      button.textContent = s.buttonLabel.trim();
      undo.add(() => (button.textContent = before));
    }

    // No celular, a barra de compra fixa da INK fica embaixo: o aviso sobe acima dela.
    const place = () => {
      const bar = ink.mobileBuyBar();
      let lift = 0;
      if (bar && !bar.hidden && bar.getClientRects().length) {
        const r = bar.getBoundingClientRect();
        if (r.bottom >= window.innerHeight - 2 && r.top < window.innerHeight) lift = Math.round(window.innerHeight - r.top);
      }
      el.style.setProperty('--pk-cookie-bottom', `${lift}px`);
    };
    place();
    undo.add(() => el.style.removeProperty('--pk-cookie-bottom'));
    window.addEventListener('resize', place, { signal: ctx.signal, passive: true });
    window.addEventListener('scroll', place, { signal: ctx.signal, passive: true });
    // Avisa os flutuantes (assistente, mini player) que o espaço embaixo mudou.
    ctx.floating.layout();

    return {
      destroy() {
        undo.run();
        ctx.floating.layout();
      },
    };
  },
};

export default cookieModule;
