// Contrato público (o que a loja recebe) e sua validação. Sem dependência das
// definições de módulo, para o carregador continuar leve.
import { PAGE_TYPES, isStorePath, type PageType, type Values } from './fields.ts';
import type { Theme } from './identity.ts';

export const SCHEMA_VERSION = 2;

export interface PublicModule {
  pages: PageType[];
  devices: string[];
  settings: Values;
}

export interface PublicConfig {
  schemaVersion: typeof SCHEMA_VERSION;
  storeId: string;
  version: number;
  publishedAt: string;
  basePath: string;
  theme: Theme;
  modules: Record<string, PublicModule>;
}

/** Classifica a página pelos padrões de URL da INK (base = caminho da loja, ex. /vistaentrenos). */
export function classifyPage(pathname: string, basePath: string): PageType {
  const base = basePath.replace(/\/$/, '');
  const p = pathname.replace(/\/$/, '') || '/';
  if (p === (base || '/')) return 'home';
  if (!p.startsWith(`${base}/`)) return 'other';
  const rest = p.slice(base.length);
  if (/^\/product\/[^/]+$/.test(rest)) return 'product';
  if (/^\/(products|collections\/[^/]+|search)$/.test(rest)) return 'listing';
  return 'other';
}

/** Algum módulo publicado roda nesta página? (decisão de injeção no Worker) */
export function hasModuleFor(config: PublicConfig, page: PageType): boolean {
  return Object.values(config.modules).some((m) => m.pages.includes(page));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const SAFE_STRING = /^[^<>\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/;

function deepSafe(v: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.length <= 4000 && SAFE_STRING.test(v);
  if (Array.isArray(v)) return v.length <= 200 && v.every((x) => deepSafe(x, depth + 1));
  if (isRecord(v)) return Object.keys(v).length <= 200 && Object.values(v).every((x) => deepSafe(x, depth + 1));
  return false;
}

/**
 * Revalida a configuração recebida pela loja (Worker e carregador): estrutura,
 * loja esperada, módulos conhecidos e nenhum texto com marcação. Os módulos
 * ainda usam só textContent e montam links por helpers que aceitam apenas
 * caminhos da própria loja ou https.
 */
export function parsePublicConfigWith(raw: unknown, known: (id: string) => boolean, expectedStoreId?: string): PublicConfig | null {
  if (!isRecord(raw) || raw.schemaVersion !== SCHEMA_VERSION) return null;
  if (typeof raw.storeId !== 'string' || (expectedStoreId !== undefined && raw.storeId !== expectedStoreId)) return null;
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 0) return null;
  if (typeof raw.publishedAt !== 'string' || Number.isNaN(Date.parse(raw.publishedAt))) return null;
  if (typeof raw.basePath !== 'string' || (raw.basePath !== '' && !isStorePath(raw.basePath))) return null;
  if (!isRecord(raw.theme) || !isRecord(raw.modules) || !deepSafe(raw)) return null;
  const pages = new Set<string>(PAGE_TYPES.map((p) => p.value));
  for (const [id, m] of Object.entries(raw.modules)) {
    if (!known(id) || !isRecord(m) || !isRecord(m.settings)) return null;
    if (!Array.isArray(m.pages) || !m.pages.every((p) => pages.has(p as string))) return null;
    if (!Array.isArray(m.devices) || !m.devices.every((d) => d === 'mobile' || d === 'desktop')) return null;
  }
  return raw as unknown as PublicConfig;
}
