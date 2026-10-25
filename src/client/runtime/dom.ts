// Utilitários de DOM dos módulos: só textContent, links seguros, Shadow DOM
// com o tema da loja e uma pilha de desfazer para tudo que toca na página.
import type { Theme } from '../../shared/identity.ts';

export const MODULE_ATTR = 'data-pink-module';

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/** Só caminhos da própria loja ("/..." sem "//") ou https. Qualquer outra coisa vira vazio. */
export function safeHref(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  if (/^\/(?!\/)/.test(value) && !/[\s<>"']/.test(value)) return value;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

export function isMobile(): boolean {
  return window.matchMedia('(max-width: 767px)').matches;
}

/** CSS-base comum a todos os módulos, a partir do tema da loja. */
export function themeCss(theme: Theme): string {
  const c = theme.colors;
  return `:host{all:initial;display:block;font-family:${theme.fontFamily === 'inherit' ? 'inherit' : theme.fontFamily};color:${c.surface.fg};
  --pk-primary:${c.primary.bg};--pk-on-primary:${c.primary.fg};--pk-accent:${c.accent.bg};--pk-on-accent:${c.accent.fg};
  --pk-surface:${c.surface.bg};--pk-text:${c.surface.fg};--pk-radius:${theme.radius}px;--pk-btn-radius:${theme.buttonRadius}px;
  font-size:15px;line-height:1.45;-webkit-font-smoothing:antialiased}
*{box-sizing:border-box}
button{font:inherit;cursor:pointer}
button:focus-visible,a:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:3px solid var(--pk-primary);outline-offset:2px}
input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--pk-primary);outline-offset:-1px;border-color:transparent}
input,textarea{caret-color:var(--pk-primary)}
::selection{background:color-mix(in srgb,var(--pk-primary) 22%,transparent)}
[hidden]{display:none!important}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;min-height:44px;padding:10px 18px;border:0;border-radius:var(--pk-btn-radius);font-weight:700;font-size:15px;line-height:1.2;transition:filter .15s ease;text-decoration:none}
.btn:hover{filter:brightness(1.06)}
.btn:active{filter:brightness(.94)}
.btn:disabled{opacity:.6;cursor:progress}
.btn-ghost{background:transparent;border:1px solid currentColor}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}`;
}

/** Hospedeiro com Shadow DOM: o CSS da loja não entra, o nosso não sai. */
export function shadowHost(moduleId: string, theme: Theme, css: string, extra: Record<string, string> = {}): { host: HTMLElement; root: ShadowRoot } {
  const host = h('div', { [MODULE_ATTR]: moduleId, ...extra });
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = themeCss(theme) + css;
  root.append(style);
  return { host, root };
}

export function removeModuleNodes(moduleId: string): void {
  document.querySelectorAll(`[${MODULE_ATTR}="${moduleId}"]`).forEach((n) => n.remove());
}

/**
 * Pilha de desfazer: cada alteração na página da loja registra como voltar.
 * Ao restaurar, só desfaz o que ainda está como deixamos (não briga com a INK).
 */
export class Undo {
  private stack: (() => void)[] = [];

  attr(el: Element, name: string, value: string | null): void {
    const before = el.getAttribute(name);
    if (value === null) el.removeAttribute(name);
    else el.setAttribute(name, value);
    this.stack.push(() => {
      if (el.getAttribute(name) === value) {
        if (before === null) el.removeAttribute(name);
        else el.setAttribute(name, before);
      }
    });
  }

  style(el: HTMLElement, prop: string, value: string, priority = ''): void {
    const hadAttr = el.hasAttribute('style');
    const before = el.style.getPropertyValue(prop);
    const beforePriority = el.style.getPropertyPriority(prop);
    el.style.setProperty(prop, value, priority);
    this.stack.push(() => {
      if (el.style.getPropertyValue(prop) === value) el.style.setProperty(prop, before, beforePriority);
      if (!hadAttr && el.getAttribute('style') === '') el.removeAttribute('style');
    });
  }

  hide(el: HTMLElement): void {
    this.attr(el, 'data-pink-hidden', '');
    this.style(el, 'display', 'none', 'important');
  }

  insert(node: Node, parent: Node, before: Node | null): void {
    parent.insertBefore(node, before && before.parentNode === parent ? before : null);
    this.stack.push(() => node.parentNode?.removeChild(node));
  }

  css(id: string, text: string): void {
    const style = h('style', { 'data-pink-style': id });
    style.textContent = text;
    document.head.append(style);
    this.stack.push(() => style.remove());
  }

  add(fn: () => void): void {
    this.stack.push(fn);
  }

  run(): void {
    while (this.stack.length) {
      try {
        this.stack.pop()!();
      } catch {
        // continua desfazendo o restante
      }
    }
  }
}

export async function copyText(text: string, root: ShadowRoot | Document): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // segue para o método alternativo
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
  (root instanceof ShadowRoot ? root : document.body).appendChild(area);
  try {
    area.select();
    return typeof document.execCommand === 'function' && document.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

export function selectContents(node: Node): void {
  try {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    // seleção indisponível
  }
}

/** Busca uma página da própria loja e devolve o documento (scripts não executam). */
export async function fetchDoc(path: string, signal?: AbortSignal): Promise<Document> {
  const href = safeHref(path);
  if (!href || !href.startsWith('/')) throw new Error('caminho inválido');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    // x-pink-fetch: o Worker repassa sem injetar nada (é leitura de dados, não página).
    const res = await fetch(href, { credentials: 'same-origin', signal: ctrl.signal, headers: { accept: 'text/html', 'x-pink-fetch': '1' } });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return new DOMParser().parseFromString(await res.text(), 'text/html');
  } finally {
    clearTimeout(t);
  }
}

/**
 * Resultado já interpretado, guardado na sessão por alguns minutos: navegar
 * entre páginas não repete a leitura das mesmas páginas da loja.
 */
export async function cached<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
  const k = `pink-cache:${key}`;
  try {
    const hit = JSON.parse(sessionStorage.getItem(k) ?? 'null') as { at: number; v: T } | null;
    if (hit && Date.now() - hit.at < ttlMs) return hit.v;
  } catch {
    // sem armazenamento: busca de novo
  }
  const v = await producer();
  try {
    sessionStorage.setItem(k, JSON.stringify({ at: Date.now(), v }));
  } catch {
    // cheio ou bloqueado: segue sem cache
  }
  return v;
}

export function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(iso));
}
