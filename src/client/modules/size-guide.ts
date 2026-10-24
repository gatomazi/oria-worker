// M11 — Guia de medidas. Complementa (não substitui) o guia nativo da INK:
// tabelas por modelagem e uma ajuda explicável — comparar com uma peça que a
// pessoa já tem e veste bem. Sem fórmula de altura/peso.
import { h, shadowHost, Undo } from '../runtime/dom.ts';
import { belowPrice, mainProductForm, productInfo, whenFrameReady } from '../runtime/page.ts';
import type { ClientModule, ModuleContext } from '../runtime/types.ts';

export interface SizeRow {
  size: string;
  width: number;
  length: number;
}

/**
 * Sugestão explicável: tamanho cuja LARGURA da peça é a mais próxima da peça
 * de referência (empate: comprimento mais próximo). Devolve também o vizinho
 * menor e maior para a pessoa decidir.
 */
export function suggestSize(rows: SizeRow[], width: number, length: number | null) {
  if (!rows.length || !(width > 0)) return null;
  const sorted = [...rows].sort((a, b) => a.width - b.width);
  let best = 0;
  sorted.forEach((r, i) => {
    const d = Math.abs(r.width - width);
    const db = Math.abs(sorted[best]!.width - width);
    if (d < db || (d === db && length !== null && Math.abs(r.length - length) < Math.abs(sorted[best]!.length - length))) best = i;
  });
  const pick = sorted[best]!;
  return {
    size: pick,
    widthDiff: Math.round((pick.width - width) * 10) / 10,
    lengthDiff: length !== null ? Math.round((pick.length - length) * 10) / 10 : null,
    smaller: sorted[best - 1] ?? null,
    larger: sorted[best + 1] ?? null,
  };
}

const CSS = `
:host{display:inline-block;margin:6px 0}
.link{background:transparent;border:0;padding:4px 0;color:var(--ac);font-weight:600;text-decoration:underline;text-underline-offset:3px;min-height:auto}
dialog{width:min(560px,calc(100vw - 24px));max-height:calc(100vh - 24px);border:0;border-radius:var(--pk-radius);padding:0;color:#1f1f1f;box-shadow:0 20px 50px rgba(0,0,0,.3)}
dialog::backdrop{background:rgba(0,0,0,.55)}
.in{display:grid;gap:12px;padding:16px}
.top{display:flex;justify-content:space-between;align-items:center;gap:8px}
h2{margin:0;font-size:19px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{padding:8px;border-bottom:1px solid #e6e6e6;text-align:left}
th{font-size:12.5px;color:#555}
tr[data-pick="true"] td{background:color-mix(in srgb,var(--ac) 12%,#fff);font-weight:700}
.note{margin:0;font-size:13px;color:#555;white-space:pre-line}
.fit{display:grid;gap:8px;padding:12px;border:1px solid #e6e6e6;border-radius:calc(var(--pk-radius) / 2)}
.fit h3{margin:0;font-size:15px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:end}
label{display:grid;gap:4px;font-size:13px;font-weight:600}
input{min-height:42px;width:120px;border:1px solid #cfcfcf;border-radius:8px;padding:6px 10px;font:inherit;font-size:16px}
.go{background:var(--ac);color:var(--on-ac)}
.out{margin:0;font-size:14px;line-height:1.5}
.native{background:transparent;border:1px solid #cfcfcf;color:#1f1f1f;min-height:38px;font-size:13.5px}
.x{background:transparent;border:1px solid #cfcfcf;color:#1f1f1f;min-height:36px}
`;

const sizeGuideModule: ClientModule = {
  async mount(ctx: ModuleContext) {
    const s = ctx.settings as { linkLabel: string; tables: { name: string; match: string[]; rows: SizeRow[]; note: string }[]; howToMeasure: string; recommender: boolean; colors: { bg: string; fg: string } };
    const info = productInfo();
    const hay = `${info.name} ${info.category} ${document.querySelector('h1')?.textContent ?? ''}`.toLowerCase();
    // A tabela mais específica (palavra-chave mais longa) vence.
    const table = s.tables
      .map((t) => ({ t, score: Math.max(0, ...t.match.filter((m) => hay.includes(m)).map((m) => m.length)) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.t;
    if (!table || !table.rows.length) return null;

    const undo = new Undo();
    const { signal } = ctx;
    const { host, root } = shadowHost('sizeGuide', ctx.theme, CSS);
    root.append(h('style', {}, `:host{--ac:${s.colors.bg};--on-ac:${s.colors.fg}}`));
    const open = h('button', { type: 'button', class: 'btn link', 'aria-haspopup': 'dialog' }, s.linkLabel);
    const body = h('tbody');
    const draw = (pick?: string) =>
      body.replaceChildren(...table.rows.map((r) => h('tr', { 'data-pick': String(r.size === pick) }, h('td', {}, r.size), h('td', {}, `${r.width} cm`), h('td', {}, `${r.length} cm`))));
    draw();
    const x = h('button', { type: 'button', class: 'btn x' }, 'Fechar');
    const native = document.querySelector<HTMLElement>('#open-modal-size');
    const nativeBtn = native ? h('button', { type: 'button', class: 'btn native' }, 'Ver também a tabela da INK') : null;
    const parts: (HTMLElement | null)[] = [
      h('div', { class: 'top' }, h('h2', {}, `${s.linkLabel} · ${table.name}`), x),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Tamanho'), h('th', {}, 'Largura da peça'), h('th', {}, 'Comprimento'))), body),
      table.note ? h('p', { class: 'note' }, table.note) : null,
      h('p', { class: 'note' }, s.howToMeasure),
    ];
    if (s.recommender) {
      const w = h('input', { type: 'number', inputmode: 'decimal', min: '10', max: '200', step: '0.5', 'aria-label': 'Largura da sua peça em cm' });
      const l = h('input', { type: 'number', inputmode: 'decimal', min: '10', max: '200', step: '0.5', 'aria-label': 'Comprimento da sua peça em cm' });
      const go = h('button', { type: 'submit', class: 'btn go' }, 'Comparar');
      const out = h('p', { class: 'out', role: 'status', 'aria-live': 'polite' });
      const form = h('form', { class: 'fit' }, h('h3', {}, 'Compare com uma peça que você já tem'), h('p', { class: 'note' }, 'Meça uma camiseta sua que veste bem (estendida, sem esticar) e compare com as medidas desta peça.'), h('div', { class: 'row' }, h('label', {}, 'Largura (cm)', w), h('label', {}, 'Comprimento (cm)', l), go), out);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const r = suggestSize(table.rows, Number(w.value), l.value ? Number(l.value) : null);
        if (!r) {
          out.textContent = 'Informe pelo menos a largura da sua peça.';
          return;
        }
        draw(r.size.size);
        const dw = r.widthDiff === 0 ? 'mesma largura' : `${Math.abs(r.widthDiff)} cm ${r.widthDiff > 0 ? 'mais larga' : 'mais estreita'}`;
        const dl = r.lengthDiff === null ? '' : r.lengthDiff === 0 ? ', mesmo comprimento' : `, ${Math.abs(r.lengthDiff)} cm ${r.lengthDiff > 0 ? 'mais comprida' : 'mais curta'}`;
        const alt = [r.smaller ? `mais justo: ${r.smaller.size}` : '', r.larger ? `mais folgado: ${r.larger.size}` : ''].filter(Boolean).join('; ');
        out.textContent = `Mais próximo da sua peça: ${r.size.size} (${dw}${dl}).${alt ? ` Se prefere ${alt}.` : ''} É uma comparação de medidas de peça, não uma garantia de caimento.`;
      }, { signal });
      parts.push(form);
    }
    if (nativeBtn) parts.push(nativeBtn);
    const dialog = h('dialog', { 'aria-label': s.linkLabel }, h('div', { class: 'in' }, ...parts));
    root.append(open, dialog);
    open.addEventListener('click', () => {
      dialog.showModal();
      document.body.setAttribute('data-pink-dialog-open', '');
    }, { signal });
    x.addEventListener('click', () => dialog.close(), { signal });
    dialog.addEventListener('close', () => document.body.removeAttribute('data-pink-dialog-open'), { signal });
    dialog.addEventListener('click', (e) => e.target === dialog && dialog.close(), { signal });
    nativeBtn?.addEventListener('click', () => {
      dialog.close();
      document.querySelector<HTMLElement>('#open-modal-size')?.click();
    }, { signal });

    // Ao lado do link nativo (dentro do quadro de variantes, que carrega depois); senão abaixo do preço.
    const frame = mainProductForm()?.querySelector('#product_variants_options_frame') ?? null;
    const place = () => {
      if (signal.aborted) return;
      const nativeLink = mainProductForm()?.querySelector('#open-modal-size') ?? null;
      if (nativeLink?.parentNode) {
        if (host.previousSibling !== nativeLink) nativeLink.parentNode.insertBefore(host, nativeLink.nextSibling);
      } else if (!host.isConnected) {
        const spot = belowPrice();
        if (spot) spot.parent.insertBefore(host, spot.before);
      }
    };
    await whenFrameReady(frame, signal, 6000);
    place();
    // A INK refaz os campos ao trocar de modelo: reinsere se sumir.
    if (frame) {
      const obs = new MutationObserver(() => place());
      obs.observe(frame, { childList: true, subtree: true });
      undo.add(() => obs.disconnect());
    }
    undo.add(() => host.remove());
    undo.add(() => document.body.removeAttribute('data-pink-dialog-open'));
    return { destroy: () => undo.run() };
  },
};

export default sizeGuideModule;
