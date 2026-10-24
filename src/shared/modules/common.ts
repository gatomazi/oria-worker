// Peças comuns às definições de módulo.
import { DEVICES, PAGE_TYPES, type Field, type FieldError, type PageType, type Values } from '../fields.ts';
import type { ProjectContext } from '../registry.ts';

export const pagesField = (allowed: PageType[], label = 'Páginas'): Field => ({
  key: 'pages',
  type: 'multiselect',
  label,
  min: 1,
  options: PAGE_TYPES.filter((p) => allowed.includes(p.value)).map((p) => ({ value: p.value, label: p.label })),
});

export const devicesField: Field = { key: 'devices', type: 'multiselect', label: 'Dispositivos', min: 1, options: DEVICES };

export function targetsFrom(settings: Values, fallbackPages: PageType[]): { pages: PageType[]; devices: string[] } {
  const pages = Array.isArray(settings.pages) ? (settings.pages as PageType[]) : fallbackPages;
  const devices = Array.isArray(settings.devices) ? (settings.devices as string[]) : ['mobile', 'desktop'];
  return { pages, devices };
}

/** Resolve um token de cor da identidade para {bg, fg}. */
export function color(ctx: ProjectContext, token: unknown): { bg: string; fg: string } {
  const key = (typeof token === 'string' && token in ctx.theme.colors ? token : 'primary') as keyof ProjectContext['theme']['colors'];
  return ctx.theme.colors[key];
}

export function within(startsAt: unknown, endsAt: unknown, now: number): boolean {
  if (typeof startsAt === 'string' && now < Date.parse(startsAt)) return false;
  if (typeof endsAt === 'string' && now >= Date.parse(endsAt)) return false;
  return true;
}

export function dateOrder(prefix: string, startsAt: unknown, endsAt: unknown): FieldError[] {
  if (typeof startsAt === 'string' && typeof endsAt === 'string' && Date.parse(endsAt) <= Date.parse(startsAt)) {
    return [{ field: `${prefix}endsAt`, message: 'Fim da vigência: precisa ser depois do início.' }];
  }
  return [];
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function list(v: unknown): Values[] {
  return Array.isArray(v) ? (v as Values[]) : [];
}
