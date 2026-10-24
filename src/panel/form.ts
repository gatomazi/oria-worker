// Gera o formulário de um módulo a partir do esquema de campos. O lojista vê
// rótulos, opções e ajudas; nunca seletores, JSON ou código.
import { CODE_PATTERN, withDefaults, type Field, type FieldError, type Values } from '../shared/fields.ts';
import type { Identity } from '../shared/identity.ts';
import type { Video } from '../shared/registry.ts';

export interface FormContext {
  identity: Identity;
  videos: Video[];
  /** Sugestões de caminhos da loja (coleções, listagens, produtos). */
  suggestions: { label: string; path: string }[];
  onChange(): void;
}

export interface FormHandle {
  el: HTMLElement;
  read(): Values;
  showErrors(errors: FieldError[], prefix: string): void;
}

let uid = 0;
const nextId = (p: string) => `${p}-${++uid}`;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | undefined> = {}, ...children: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== false && c !== undefined) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

const BRT = '-03:00';
const isoToLocal = (iso: unknown) => (typeof iso === 'string' && iso ? new Date(Date.parse(iso) - 3 * 3600_000).toISOString().slice(0, 16) : '');
const localToIso = (v: string) => (v ? `${v}:00${BRT}` : null);

const TOKEN_COLOR: Record<string, (i: Identity) => string> = {
  primary: (i) => i.primary,
  accent: (i) => i.accent,
  surface: (i) => i.surface,
  text: (i) => i.text,
  neutral: () => '#FFFFFF',
};
const TOKEN_LABEL: Record<string, string> = { primary: 'Principal', accent: 'Destaque', surface: 'Fundo claro', text: 'Texto', neutral: 'Branco' };

interface Control {
  field: Field;
  wrap: HTMLElement;
  read(): unknown;
  errorEl: HTMLElement;
  /** Para listas: controles dos itens. */
  children?: () => { index: number; handle: FormHandle }[];
}

export function buildForm(fields: Field[], values: Values, ctx: FormContext): FormHandle {
  const root = h('div', { class: 'fields' });
  const controls: Control[] = [];

  for (const field of fields) {
    const c = control(field, values[field.key], ctx);
    controls.push(c);
    root.append(c.wrap);
  }

  const applyVisibility = () => {
    const current = read();
    for (const c of controls) {
      const sw = c.field.showWhen;
      c.wrap.hidden = !!sw && !sw.in.includes(current[sw.key] as string | boolean);
    }
  };
  root.addEventListener('input', applyVisibility);
  root.addEventListener('change', applyVisibility);

  function read(): Values {
    const out: Values = {};
    for (const c of controls) out[c.field.key] = c.read();
    return out;
  }

  function showErrors(errors: FieldError[], prefix: string): void {
    for (const c of controls) {
      const path = prefix ? `${prefix}.${c.field.key}` : c.field.key;
      const mine = errors.filter((e) => e.field === path);
      c.errorEl.textContent = mine.map((e) => e.message).join(' ');
      c.wrap.classList.toggle('has-error', mine.length > 0);
      c.children?.().forEach(({ index, handle }) => handle.showErrors(errors, `${path}.${index}`));
    }
  }

  applyVisibility();
  return { el: root, read, showErrors };
}

function control(field: Field, value: unknown, ctx: FormContext): Control {
  const id = nextId('f');
  const errorEl = h('p', { class: 'err', id: `${id}-err` });
  const help = field.help ? h('p', { class: 'help', id: `${id}-help` }, field.help) : null;
  const describedBy = [help ? `${id}-help` : '', `${id}-err`].filter(Boolean).join(' ');
  const label = h('label', { for: id }, field.label);
  const wrap = h('div', { class: `field field-${field.type}`, 'data-key': field.key });
  let read: () => unknown = () => value;
  let children: Control['children'];

  switch (field.type) {
    case 'text': {
      const input = field.multiline
        ? h('textarea', { id, rows: '3', maxlength: String(field.max), 'aria-describedby': describedBy })
        : h('input', { id, type: 'text', maxlength: String(field.max), autocomplete: 'off', placeholder: field.placeholder, 'aria-describedby': describedBy });
      (input as HTMLInputElement).value = typeof value === 'string' ? value : '';
      const count = h('span', { class: 'count' });
      const upd = () => {
        const n = [...(input as HTMLInputElement).value].length;
        count.textContent = `${n}/${field.max}`;
        count.dataset.over = String(n > field.max);
      };
      input.addEventListener('input', () => {
        upd();
        ctx.onChange();
      });
      upd();
      wrap.append(label, input, h('div', { class: 'meta' }, errorEl, count));
      read = () => (input as HTMLInputElement).value;
      break;
    }
    case 'code': {
      const input = h('input', { id, type: 'text', maxlength: '24', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', class: 'mono', 'aria-describedby': describedBy });
      input.value = typeof value === 'string' ? value : '';
      input.addEventListener('input', () => {
        const pos = input.selectionStart;
        input.value = input.value.toUpperCase();
        input.setSelectionRange(pos, pos);
        input.classList.toggle('looks-bad', !!input.value && !CODE_PATTERN.test(input.value));
        ctx.onChange();
      });
      wrap.append(label, input, h('div', { class: 'meta' }, errorEl, h('span', { class: 'count' }, 'Precisa existir na INK com as mesmas regras.')));
      read = () => input.value.toUpperCase();
      break;
    }
    case 'number': {
      const input = h('input', { id, type: 'number', min: String(field.min), max: String(field.max), step: String(field.step ?? (field.integer ? 1 : 'any')), inputmode: 'decimal', 'aria-describedby': describedBy });
      input.value = typeof value === 'number' ? String(value) : '';
      input.addEventListener('input', () => ctx.onChange());
      wrap.append(label, h('div', { class: 'with-unit' }, input, field.unit ? h('span', { class: 'unit' }, field.unit) : null), errorEl);
      read = () => (input.value === '' ? NaN : Number(input.value));
      break;
    }
    case 'toggle': {
      const input = h('input', { id, type: 'checkbox', role: 'switch', 'aria-describedby': describedBy });
      input.checked = value === true;
      input.addEventListener('change', () => ctx.onChange());
      wrap.append(h('label', { class: 'switch', for: id }, input, h('span', { class: 'switch-track', 'aria-hidden': 'true' }), h('span', {}, field.label)), errorEl);
      read = () => input.checked;
      break;
    }
    case 'select': {
      if (field.options.length <= 3 && field.options.every((o) => o.label.length < 34)) {
        const group = h('div', { class: 'seg-choice', role: 'radiogroup', 'aria-labelledby': `${id}-lbl` });
        const name = nextId('r');
        for (const o of field.options) {
          const rid = nextId('o');
          const r = h('input', { type: 'radio', name, id: rid, value: o.value });
          r.checked = value === o.value;
          r.addEventListener('change', () => ctx.onChange());
          group.append(r, h('label', { for: rid }, o.label));
        }
        wrap.append(h('p', { class: 'lbl', id: `${id}-lbl` }, field.label), group, errorEl);
        read = () => group.querySelector<HTMLInputElement>('input:checked')?.value ?? '';
      } else {
        const sel = h('select', { id, 'aria-describedby': describedBy });
        for (const o of field.options) {
          const opt = h('option', { value: o.value }, o.label);
          if (o.value === value) opt.selected = true;
          sel.append(opt);
        }
        sel.addEventListener('change', () => ctx.onChange());
        wrap.append(label, sel, errorEl);
        read = () => sel.value;
      }
      break;
    }
    case 'multiselect': {
      const group = h('div', { class: 'chips', role: 'group', 'aria-labelledby': `${id}-lbl` });
      const current = new Set(Array.isArray(value) ? (value as string[]) : []);
      for (const o of field.options) {
        const cid = nextId('c');
        const cb = h('input', { type: 'checkbox', id: cid, value: o.value });
        cb.checked = current.has(o.value);
        cb.addEventListener('change', () => ctx.onChange());
        group.append(cb, h('label', { for: cid }, o.label));
      }
      wrap.append(h('p', { class: 'lbl', id: `${id}-lbl` }, field.label), group, errorEl);
      read = () => [...group.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value);
      break;
    }
    case 'colorToken': {
      const group = h('div', { class: 'tokens', role: 'radiogroup', 'aria-labelledby': `${id}-lbl` });
      const name = nextId('t');
      for (const [token, fn] of Object.entries(TOKEN_COLOR)) {
        const tid = nextId('tk');
        const r = h('input', { type: 'radio', name, id: tid, value: token });
        r.checked = value === token;
        r.addEventListener('change', () => ctx.onChange());
        const sw = h('label', { for: tid, class: 'token' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), TOKEN_LABEL[token]!);
        (sw.firstChild as HTMLElement).style.background = fn(ctx.identity);
        group.append(r, sw);
      }
      wrap.append(h('p', { class: 'lbl', id: `${id}-lbl` }, field.label), group, errorEl);
      read = () => group.querySelector<HTMLInputElement>('input:checked')?.value ?? 'primary';
      break;
    }
    case 'hexColor': {
      const picker = h('input', { type: 'color', 'aria-label': `${field.label}: seletor` });
      const text = h('input', { id, type: 'text', maxlength: '7', class: 'mono hex', 'aria-describedby': describedBy });
      const v = typeof value === 'string' ? value : '#000000';
      picker.value = v.toLowerCase();
      text.value = v.toUpperCase();
      picker.addEventListener('input', () => {
        text.value = picker.value.toUpperCase();
        ctx.onChange();
      });
      text.addEventListener('input', () => {
        if (/^#[0-9a-f]{6}$/i.test(text.value)) picker.value = text.value.toLowerCase();
        ctx.onChange();
      });
      wrap.append(label, h('div', { class: 'color-row' }, picker, text), errorEl);
      read = () => text.value.trim().toUpperCase();
      break;
    }
    case 'datetime': {
      const input = h('input', { id, type: 'datetime-local', 'aria-describedby': describedBy });
      input.value = isoToLocal(value);
      input.addEventListener('input', () => ctx.onChange());
      wrap.append(label, input, h('div', { class: 'meta' }, errorEl, h('span', { class: 'count' }, 'Horário de Brasília')));
      read = () => localToIso(input.value);
      break;
    }
    case 'storePath':
    case 'httpsUrl':
    case 'phone': {
      const listId = nextId('dl');
      const input = h('input', {
        id,
        type: field.type === 'phone' ? 'tel' : field.type === 'httpsUrl' ? 'url' : 'text',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: 'placeholder' in field ? field.placeholder : field.type === 'phone' ? '55 61 99999-0000' : undefined,
        list: field.type === 'storePath' ? listId : undefined,
        'aria-describedby': describedBy,
      });
      input.value = typeof value === 'string' ? value : '';
      input.addEventListener('input', () => ctx.onChange());
      wrap.append(label, input);
      if (field.type === 'storePath') {
        const dl = h('datalist', { id: listId });
        for (const s of ctx.suggestions) dl.append(h('option', { value: s.path }, s.label));
        wrap.append(dl);
      }
      wrap.append(errorEl);
      read = () => input.value.trim();
      break;
    }
    case 'videoRefs': {
      const group = h('div', { class: 'video-pick', role: 'group', 'aria-labelledby': `${id}-lbl` });
      const current = Array.isArray(value) ? (value as string[]) : [];
      if (!ctx.videos.length) group.append(h('p', { class: 'empty' }, 'A biblioteca ainda não tem vídeos. Cadastre em "Vídeos".'));
      for (const v of ctx.videos) {
        const cid = nextId('v');
        const cb = h('input', { type: 'checkbox', id: cid, value: v.id });
        cb.checked = current.includes(v.id);
        cb.addEventListener('change', () => ctx.onChange());
        group.append(h('div', { class: 'video-opt' }, cb, h('label', { for: cid }, v.title, v.productPaths.length ? h('small', {}, ` · ${v.productPaths.length} produto(s)`) : null)));
      }
      wrap.append(h('p', { class: 'lbl', id: `${id}-lbl` }, field.label), group, errorEl);
      if (help) wrap.append(help);
      read = () => [...group.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value);
      return { field, wrap, read, errorEl };
    }
    case 'list': {
      const items: { handle: FormHandle; box: HTMLElement }[] = [];
      const listEl = h('div', { class: 'repeater' });
      const add = h('button', { type: 'button', class: 'btn btn-small' }, `+ ${field.itemLabel}`);
      const renumber = () => {
        items.forEach(({ box }, i) => {
          const t = box.querySelector('.item-title');
          if (t) t.textContent = `${field.itemLabel} ${i + 1}`;
        });
        add.disabled = items.length >= field.max;
      };
      const addItem = (v: Values) => {
        const handle = buildForm(field.fields, v, ctx);
        const box = h('div', { class: 'item' });
        const up = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Mover para cima' }, '↑');
        const down = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Mover para baixo' }, '↓');
        const del = h('button', { type: 'button', class: 'icon-btn danger', 'aria-label': `Remover ${field.itemLabel.toLowerCase()}` }, 'Remover');
        const entry = { handle, box };
        up.addEventListener('click', () => move(entry, -1));
        down.addEventListener('click', () => move(entry, 1));
        del.addEventListener('click', () => {
          items.splice(items.indexOf(entry), 1);
          box.remove();
          renumber();
          ctx.onChange();
        });
        box.append(h('div', { class: 'item-head' }, h('span', { class: 'item-title' }), h('span', { class: 'item-actions' }, up, down, del)), handle.el);
        items.push(entry);
        listEl.append(box);
        renumber();
      };
      const move = (entry: { handle: FormHandle; box: HTMLElement }, dir: number) => {
        const i = items.indexOf(entry);
        const j = i + dir;
        if (j < 0 || j >= items.length) return;
        items.splice(i, 1);
        items.splice(j, 0, entry);
        listEl.replaceChildren(...items.map((x) => x.box));
        renumber();
        ctx.onChange();
      };
      for (const v of Array.isArray(value) ? (value as Values[]) : []) addItem(v);
      add.addEventListener('click', () => {
        addItem(withDefaults(field.fields, {}, {}));
        ctx.onChange();
        (listEl.lastElementChild?.querySelector('input, textarea, select') as HTMLElement | null)?.focus();
      });
      wrap.append(h('p', { class: 'lbl' }, field.label), help ?? '', listEl, add, errorEl);
      read = () => items.map((x) => x.handle.read());
      children = () => items.map((x, index) => ({ index, handle: x.handle }));
      return { field, wrap, read, errorEl, children };
    }
  }
  if (help) wrap.insertBefore(help, errorEl.parentElement === wrap ? errorEl : wrap.lastChild);
  return { field, wrap, read, errorEl, children };
}
