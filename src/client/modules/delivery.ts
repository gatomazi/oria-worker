// M12 — Prazo de entrega na página do produto. A data vem da INK: o módulo
// usa o próprio formulário de CEP da INK (não chama o endpoint por fora) e lê
// o resultado que a INK escreve na página. A produção configurada pela loja
// aparece separada, como informação.
import { h, Undo } from '../runtime/dom.ts';
import { belowBuy, belowPrice, whenFrameReady } from '../runtime/page.ts';
import { shadowHost } from '../runtime/dom.ts';
import type { ClientModule, ModuleContext } from '../runtime/types.ts';

const CSS = `
:host{margin:12px 0}
.box{display:grid;gap:8px;padding:12px 14px;border:1px solid #e3e3e3;border-radius:var(--pk-radius);background:#fff;color:#1f1f1f;font-size:14px}
.prod{margin:0;font-weight:700}
form{display:flex;gap:8px;flex-wrap:wrap}
input{flex:1 1 140px;min-height:42px;border:1px solid #cfcfcf;border-radius:8px;padding:6px 12px;font:inherit;font-size:16px}
.go{background:var(--ac);color:var(--on-ac);min-height:42px}
.res{margin:0;line-height:1.45}
.res strong{color:#1f1f1f}
.note{margin:0;font-size:12.5px;color:#666}
.src{font-size:12px;color:#666}
`;

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const WEEKDAY = '(?:(?:segunda|terça|terca|quarta|quinta|sexta)(?:-feira)?|sábado|sabado|domingo),?\\s*';

/**
 * Texto do prazo como a loja escreve ("Entrega entre Sexta, 30 de Outubro e Sábado, 31 de Outubro .")
 * → datas em DD/MM ("Entrega entre 30/10 e 31/10."). O resto do texto fica como veio.
 */
export function deliveryText(raw: string): string {
  const re = new RegExp(`(?:${WEEKDAY})?(\\d{1,2})\\s+de\\s+(${MONTHS.join('|')})(?:\\s+de\\s+\\d{4})?`, 'gi');
  return raw
    .replace(re, (_m, d: string, mon: string) => `${d.padStart(2, '0')}/${String(MONTHS.indexOf(mon.toLowerCase()) + 1).padStart(2, '0')}`)
    .replace(/\s+([.,;])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const deliveryModule: ClientModule = {
  async mount(ctx: ModuleContext) {
    const s = ctx.settings as { productionMin: number; productionMax: number; productionLabel: string; calculator: boolean; note: string; position: string; colors: { bg: string; fg: string } };
    const spot = s.position === 'abaixo-preco' ? belowPrice() : belowBuy();
    if (!spot) return null;
    const { signal } = ctx;
    const undo = new Undo();
    const { host, root } = shadowHost('delivery', ctx.theme, CSS);
    root.append(h('style', {}, `:host{--ac:${s.colors.bg};--on-ac:${s.colors.fg}}`));
    const production = s.productionLabel.replace('{min}', String(s.productionMin)).replace('{max}', String(s.productionMax));
    const box = h('div', { class: 'box', role: 'group', 'aria-label': 'Prazo de entrega' }, h('p', { class: 'prod' }, production));
    root.append(box);
    undo.insert(host, spot.parent, spot.before);

    if (s.calculator) {
      const frame = document.querySelector('turbo-frame#delivery_estimates_frame');
      await whenFrameReady(frame, signal, 8000);
      const nativeForm = document.querySelector<HTMLFormElement>('#delivery-estimates-content-modal-frame form[action$="/delivery_estimates"], form[data-controller~="ink-store--delivery-estimate"]');
      const nativeInput = nativeForm?.querySelector<HTMLInputElement>('input[name="postal_code"]');
      if (nativeForm && nativeInput && !signal.aborted) {
        const cep = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'postal-code', maxlength: '9', placeholder: 'Seu CEP', 'aria-label': 'CEP' });
        const go = h('button', { type: 'submit', class: 'btn go' }, 'Calcular entrega');
        const res = h('p', { class: 'res', role: 'status', 'aria-live': 'polite' });
        const form = h('form', {}, cep, go);
        cep.addEventListener('input', () => {
          const d = cep.value.replace(/\D/g, '').slice(0, 8);
          cep.value = d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
        }, { signal });
        const readNative = () => {
          const t = (document.querySelector('#remaining_delivery_time')?.textContent ?? '').replace(/\s+/g, ' ').trim();
          return t;
        };
        let waiting: MutationObserver | null = null;
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          if (!/^\d{5}-\d{3}$/.test(cep.value)) {
            res.textContent = 'Informe um CEP com 8 números.';
            return;
          }
          // Usa o formulário da própria INK: mesma consulta, mesmo resultado.
          const live = document.querySelector<HTMLFormElement>('#delivery-estimates-content-modal-frame form[action$="/delivery_estimates"], form[data-controller~="ink-store--delivery-estimate"]');
          const liveInput = live?.querySelector<HTMLInputElement>('input[name="postal_code"]');
          if (!live || !liveInput) {
            res.textContent = 'O cálculo de entrega não está disponível agora. Tente de novo em instantes.';
            return;
          }
          liveInput.value = cep.value;
          liveInput.dispatchEvent(new Event('input', { bubbles: true }));
          go.disabled = true;
          res.textContent = 'Calculando…';
          const before = readNative();
          const target = document.querySelector('#remaining_delivery_time');
          waiting?.disconnect();
          const finish = (text: string) => {
            waiting?.disconnect();
            go.disabled = false;
            res.replaceChildren(text ? h('span', {}, h('strong', {}, deliveryText(text)), h('br'), h('span', { class: 'src' }, `Para o CEP ${cep.value}`)) : 'Não encontramos prazo para este CEP. Confira o CEP ou tente de novo.');
          };
          const timer = setTimeout(() => finish(readNative() !== before ? readNative() : ''), 10000);
          waiting = new MutationObserver(() => {
            const now = readNative();
            if (now && now !== before) {
              clearTimeout(timer);
              finish(now);
            }
          });
          if (target) waiting.observe(target, { childList: true, subtree: true, characterData: true });
          document.addEventListener('turbo:before-stream-render', () => setTimeout(() => {
            const now = readNative();
            if (now && now !== before) {
              clearTimeout(timer);
              finish(now);
            }
          }, 30), { signal });
          live.requestSubmit();
        }, { signal });
        box.append(form, res);
        undo.add(() => waiting?.disconnect());
      }
    }
    if (s.note) box.append(h('p', { class: 'note' }, s.note));
    return { destroy: () => undo.run() };
  },
};

export default deliveryModule;
