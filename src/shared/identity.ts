// Identidade global da loja: definida uma vez, usada por todos os módulos.
import { contrastRatio, onColor, validateFields, type Field, type FieldError, type Values } from './fields.ts';

export const IDENTITY_FIELDS: Field[] = [
  {
    key: 'logoUrl',
    type: 'httpsUrl',
    accept: 'image',
    label: 'Logo',
    help: 'Endereço https da imagem do logo. Em branco, os módulos usam o logo que a loja já mostra.',
  },
  { key: 'primary', type: 'hexColor', label: 'Cor principal', help: 'Botões e destaques principais.' },
  { key: 'accent', type: 'hexColor', label: 'Cor de destaque', help: 'Preços, selos e detalhes.' },
  { key: 'surface', type: 'hexColor', label: 'Fundo claro', help: 'Fundo de cards e faixas.' },
  { key: 'text', type: 'hexColor', label: 'Texto', help: 'Cor do texto sobre o fundo claro.' },
  {
    key: 'font',
    type: 'select',
    label: 'Tipografia',
    help: '"Da loja" usa a fonte que a loja já carrega.',
    options: [
      { value: 'inherit', label: 'Da loja' },
      { value: 'sans', label: 'Sem serifa' },
      { value: 'serif', label: 'Com serifa' },
      { value: 'rounded', label: 'Arredondada' },
    ],
  },
  {
    key: 'style',
    type: 'select',
    label: 'Estilo',
    options: [
      { value: 'suave', label: 'Suave (cantos arredondados)' },
      { value: 'reto', label: 'Reto (cantos vivos)' },
      { value: 'pilula', label: 'Pílula (botões redondos)' },
    ],
  },
];

export interface Identity {
  logoUrl: string;
  primary: string;
  accent: string;
  surface: string;
  text: string;
  font: 'inherit' | 'sans' | 'serif' | 'rounded';
  style: 'suave' | 'reto' | 'pilula';
}

export const DEFAULT_IDENTITY: Identity = {
  logoUrl: '',
  primary: '#1F2937',
  accent: '#B45309',
  surface: '#F8F5F0',
  text: '#1F2937',
  font: 'inherit',
  style: 'suave',
};

export function validateIdentity(raw: unknown): { value: Identity; errors: FieldError[] } {
  const { value, errors } = validateFields(IDENTITY_FIELDS, raw, 'identity');
  const id = value as unknown as Identity;
  if (!errors.length) {
    if (contrastRatio(id.text, id.surface) < 4.5) {
      errors.push({ field: 'identity.text', message: 'Texto: pouco contraste com o fundo claro (mínimo 4,5:1).' });
    }
    if (contrastRatio(id.primary, id.surface) < 3) {
      errors.push({ field: 'identity.primary', message: 'Cor principal: quase some sobre o fundo claro (mínimo 3:1).' });
    }
  }
  return { value: id, errors };
}

/** Tema pronto para a loja: tokens resolvidos em cores, com cor de texto legível sobre cada uma. */
export interface Theme {
  logoUrl: string;
  colors: Record<'primary' | 'accent' | 'surface' | 'text' | 'neutral', { bg: string; fg: string }>;
  fontFamily: string;
  radius: number;
  buttonRadius: number;
}

const FONTS: Record<Identity['font'], string> = {
  inherit: 'inherit',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
  serif: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", system-ui, sans-serif',
};

export function toTheme(id: Identity): Theme {
  const radius = id.style === 'reto' ? 2 : 12;
  return {
    logoUrl: id.logoUrl,
    colors: {
      primary: { bg: id.primary, fg: onColor(id.primary) },
      accent: { bg: id.accent, fg: onColor(id.accent) },
      surface: { bg: id.surface, fg: id.text },
      text: { bg: id.text, fg: onColor(id.text) },
      neutral: { bg: '#FFFFFF', fg: '#1F1F1F' },
    },
    fontFamily: FONTS[id.font],
    radius,
    buttonRadius: id.style === 'pilula' ? 999 : id.style === 'reto' ? 2 : 8,
  };
}

export function asValues(id: Identity): Values {
  return { ...id };
}
