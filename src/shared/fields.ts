// Esquema declarativo de campos. A mesma definição gera o formulário do
// painel, os valores padrão e a validação no servidor e na loja. Nenhum campo
// aceita HTML, JavaScript, seletor CSS ou JSON livre.

export interface FieldBase {
  key: string;
  label: string;
  help?: string;
  /** Mostra o campo só quando outro campo do mesmo nível tem um destes valores. */
  showWhen?: { key: string; in: (string | boolean)[] };
  /** Opção secundária: fica num grupo recolhido ("Mais opções") no painel. */
  advanced?: boolean;
}

export type Field =
  | (FieldBase & { type: 'text'; max: number; required?: boolean; multiline?: boolean; placeholder?: string })
  | (FieldBase & { type: 'number'; min: number; max: number; step?: number; unit?: string; integer?: boolean })
  | (FieldBase & { type: 'toggle' })
  | (FieldBase & { type: 'select'; options: Option[] })
  | (FieldBase & { type: 'multiselect'; options: Option[]; min?: number })
  | (FieldBase & { type: 'colorToken' })
  | (FieldBase & { type: 'hexColor' })
  | (FieldBase & { type: 'code'; required?: boolean })
  | (FieldBase & { type: 'datetime' })
  | (FieldBase & { type: 'storePath'; required?: boolean; placeholder?: string })
  | (FieldBase & { type: 'httpsUrl'; required?: boolean; placeholder?: string; accept?: 'image' | 'video' | 'any' })
  | (FieldBase & { type: 'phone'; required?: boolean })
  | (FieldBase & { type: 'videoRefs'; max: number })
  | (FieldBase & {
      type: 'list';
      itemLabel: string;
      titleKey: string;
      min: number;
      max: number;
      fields: Field[];
      /** Linha de resumo de um item recolhido no painel (ex.: código · vigência · condição). */
      summary?: (item: Values) => string;
    });

export interface Option {
  value: string;
  label: string;
}

export interface FieldError {
  field: string;
  message: string;
}

export type Values = Record<string, unknown>;

/** Tokens de cor da identidade da loja: módulos referenciam o token, não repetem a cor. */
export const COLOR_TOKENS: Option[] = [
  { value: 'primary', label: 'Cor principal da marca' },
  { value: 'accent', label: 'Cor de destaque' },
  { value: 'surface', label: 'Fundo claro' },
  { value: 'text', label: 'Texto' },
  { value: 'neutral', label: 'Neutro (branco/cinza)' },
];

export const PAGE_TYPES = [
  { value: 'home', label: 'Início' },
  { value: 'listing', label: 'Listagens e coleções' },
  { value: 'product', label: 'Página de produto' },
  { value: 'other', label: 'Outras páginas' },
] as const;
export type PageType = (typeof PAGE_TYPES)[number]['value'];

export const DEVICES: Option[] = [
  { value: 'mobile', label: 'Celular' },
  { value: 'desktop', label: 'Computador' },
];

// ------------------------------------------------------------------ regras

const CONTROL_CHARS = /[\u0000-\u0009\u000B-\u001F\u007F\u2028\u2029]/;
const ANGLE = /[<>]/;
export const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,23}$/;
export const HEX_PATTERN = /^#[0-9A-F]{6}$/;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
// Caminho dentro da própria loja: sem protocolo, sem "//", sem ".." e sem espaços.
const STORE_PATH = /^\/(?!\/)[A-Za-z0-9\-._~%/]*(\?[A-Za-z0-9\-._~%=&+]*)?$/;

export function isPlainText(value: string, multiline = false): boolean {
  if (ANGLE.test(value) || CONTROL_CHARS.test(value)) return false;
  return multiline || !value.includes('\n');
}

export function isStorePath(value: string): boolean {
  return STORE_PATH.test(value) && !value.split('?')[0]!.split('/').includes('..');
}

export function isHttpsUrl(value: string): boolean {
  if (value.length > 600 || /\s/.test(value)) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function visible(field: Field, values: Values): boolean {
  if (!field.showWhen) return true;
  return field.showWhen.in.includes(values[field.showWhen.key] as string | boolean);
}

// ---------------------------------------------------------------- padrões

export function defaultFor(field: Field): unknown {
  switch (field.type) {
    case 'text':
    case 'storePath':
    case 'httpsUrl':
    case 'phone':
    case 'code':
      return '';
    case 'number':
      return field.min;
    case 'toggle':
      return false;
    case 'select':
      return field.options[0]?.value ?? '';
    case 'multiselect':
      return field.options.map((o) => o.value);
    case 'colorToken':
      return 'primary';
    case 'hexColor':
      return '#000000';
    case 'datetime':
      return null;
    case 'videoRefs':
    case 'list':
      return [];
  }
}

/** Completa valores ausentes com os padrões declarados (sobrescritas parciais ficam válidas). */
export function withDefaults(fields: Field[], defaults: Values, raw: unknown): Values {
  const src = isRecord(raw) ? raw : {};
  const out: Values = {};
  for (const f of fields) {
    out[f.key] = src[f.key] !== undefined ? src[f.key] : defaults[f.key] !== undefined ? structuredClone(defaults[f.key]) : defaultFor(f);
  }
  return out;
}

// --------------------------------------------------------------- validação

export interface ValidateContext {
  /** Ids de vídeos existentes na biblioteca da loja. */
  videoIds?: Set<string>;
  /**
   * Completude (obrigatórios e mínimos de lista). Desligada para módulos
   * inativos: o rascunho salva mesmo incompleto, mas segurança e formato
   * (texto simples, caminhos, cores, tamanhos) valem sempre.
   */
  complete?: boolean;
}

export function validateFields(fields: Field[], raw: unknown, prefix: string, ctx: ValidateContext = {}): { value: Values; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const src = isRecord(raw) ? raw : {};
  const value: Values = {};
  for (const f of fields) {
    const path = prefix ? `${prefix}.${f.key}` : f.key;
    const v = src[f.key];
    const err = (message: string) => errors.push({ field: path, message: `${f.label}: ${message}` });
    // Campos escondidos mantêm o valor, mas só são exigidos quando visíveis.
    const required = ctx.complete !== false && visible(f, src);
    switch (f.type) {
      case 'text': {
        const s = typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim() : '';
        if (v !== undefined && typeof v !== 'string') err('valor inválido.');
        else if (f.required && required && !s) err('campo obrigatório.');
        else if ([...s].length > f.max) err(`use no máximo ${f.max} caracteres.`);
        else if (!isPlainText(s, f.multiline)) err('use apenas texto simples (sem < >, sem quebras de linha fora das áreas de texto).');
        value[f.key] = s;
        break;
      }
      case 'number': {
        const n = typeof v === 'number' ? v : Number.NaN;
        if (!Number.isFinite(n) || n < f.min || n > f.max || (f.integer && !Number.isInteger(n))) {
          err(`informe um número entre ${f.min} e ${f.max}${f.unit ? ` ${f.unit}` : ''}.`);
          value[f.key] = f.min;
        } else value[f.key] = n;
        break;
      }
      case 'toggle':
        if (typeof v !== 'boolean') err('valor inválido.');
        value[f.key] = v === true;
        break;
      case 'select':
        if (!f.options.some((o) => o.value === v)) err('escolha uma das opções.');
        value[f.key] = f.options.some((o) => o.value === v) ? v : f.options[0]?.value;
        break;
      case 'multiselect': {
        const arr = Array.isArray(v) ? v : [];
        const ok = arr.filter((x) => f.options.some((o) => o.value === x));
        if (!Array.isArray(v) || ok.length !== arr.length) err('escolha entre as opções disponíveis.');
        else if (new Set(ok).size !== ok.length) err('opção repetida.');
        else if (required && ok.length < (f.min ?? 0)) err(`escolha pelo menos ${f.min}.`);
        value[f.key] = [...new Set(ok)];
        break;
      }
      case 'colorToken':
        if (!COLOR_TOKENS.some((o) => o.value === v)) err('escolha uma das cores da identidade.');
        value[f.key] = COLOR_TOKENS.some((o) => o.value === v) ? v : 'primary';
        break;
      case 'hexColor': {
        const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
        if (!HEX_PATTERN.test(s)) err('use uma cor no formato #RRGGBB.');
        value[f.key] = HEX_PATTERN.test(s) ? s : '#000000';
        break;
      }
      case 'code': {
        const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
        if (!s) {
          if (f.required && required) err('campo obrigatório.');
        } else if (!CODE_PATTERN.test(s)) err('use de 3 a 24 caracteres: letras sem acento, números, hífen ou sublinhado.');
        value[f.key] = s;
        break;
      }
      case 'datetime': {
        if (v === null || v === undefined || v === '') value[f.key] = null;
        else if (typeof v !== 'string' || !ISO_WITH_OFFSET.test(v) || Number.isNaN(Date.parse(v))) {
          err('data inválida.');
          value[f.key] = null;
        } else value[f.key] = v;
        break;
      }
      case 'storePath': {
        const s = typeof v === 'string' ? v.trim() : '';
        if (!s) {
          if (f.required && required) err('campo obrigatório.');
        } else if (!isStorePath(s) || s.length > 300) err('use um caminho da própria loja começando com "/", por exemplo /minhaloja/collections/verao.');
        value[f.key] = s;
        break;
      }
      case 'httpsUrl': {
        const s = typeof v === 'string' ? v.trim() : '';
        if (!s) {
          if (f.required && required) err('campo obrigatório.');
        } else if (!isHttpsUrl(s)) err('use um endereço completo começando com https://');
        value[f.key] = s;
        break;
      }
      case 'phone': {
        const digits = typeof v === 'string' ? v.replace(/\D/g, '') : '';
        if (!digits) {
          if (f.required && required) err('campo obrigatório.');
        } else if (digits.length < 12 || digits.length > 13) err('use DDI + DDD + número, por exemplo 55 61 99999-0000.');
        value[f.key] = digits;
        break;
      }
      case 'videoRefs': {
        const arr = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
        if (!Array.isArray(v) || arr.length !== v.length) err('seleção inválida.');
        else if (arr.length > f.max) err(`escolha no máximo ${f.max}.`);
        else if (ctx.videoIds && arr.some((id) => !ctx.videoIds!.has(id))) err('há vídeo que não existe mais na biblioteca.');
        value[f.key] = [...new Set(arr)];
        break;
      }
      case 'list': {
        const arr = Array.isArray(v) ? v : [];
        if (v !== undefined && !Array.isArray(v)) err('valor inválido.');
        else if (required && arr.length < f.min) err(`adicione pelo menos ${f.min} ${f.itemLabel.toLowerCase()}.`);
        else if (arr.length > f.max) err(`no máximo ${f.max} itens.`);
        value[f.key] = arr.slice(0, f.max).map((item, i) => {
          const r = validateFields(f.fields, item, `${path}.${i}`, ctx);
          errors.push(...r.errors);
          return r.value;
        });
        break;
      }
    }
  }
  return { value, errors };
}

// ----------------------------------------------------------------- contraste

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Cor legível sobre um fundo: quase-preto ou branco, a de maior contraste. */
export function onColor(hex: string): string {
  return contrastRatio(hex, '#111111') >= contrastRatio(hex, '#FFFFFF') ? '#111111' : '#FFFFFF';
}
