// Registro de módulos e contrato de configuração v2.
// Cada módulo declara: identificador, campos (esquema), padrões, páginas,
// integrações de que depende e a projeção pública. O painel, o servidor, o
// Worker e o carregador usam esta mesma definição para todas as lojas.
import {
  isHttpsUrl,
  isPlainText,
  isStorePath,
  validateFields,
  withDefaults,
  type Field,
  type FieldError,
  type PageType,
  type Values,
} from './fields.ts';
import { DEFAULT_IDENTITY, toTheme, validateIdentity, type Identity, type Theme } from './identity.ts';

import { SCHEMA_VERSION, parsePublicConfigWith, type PublicConfig, type PublicModule } from './public-config.ts';
export { SCHEMA_VERSION, classifyPage, hasModuleFor, type PublicConfig, type PublicModule } from './public-config.ts';

export interface Video {
  id: string;
  title: string;
  videoUrl: string;
  posterUrl: string;
  productPaths: string[];
  caption: string;
}

export interface Library {
  videos: Video[];
}

export interface ModuleState {
  enabled: boolean;
  settings: Values;
}

export interface StoreConfig {
  schemaVersion: typeof SCHEMA_VERSION;
  identity: Identity;
  library: Library;
  modules: Record<string, ModuleState>;
}

export interface ProjectContext {
  theme: Theme;
  library: Library;
  basePath: string;
  now: number;
}

export interface ModuleDef {
  id: string;
  code: string;
  name: string;
  summary: string;
  /** Páginas em que o módulo pode rodar. */
  pages: PageType[];
  fields: Field[];
  defaults: Values;
  /** Integrações da INK de que depende (aparecem no estado da instalação). */
  integrations: string[];
  /** Regras entre campos, além do esquema. */
  check?(settings: Values, ctx: { library: Library }): FieldError[];
  /** Regras extras no momento de publicar (ex.: vigência vencida). */
  publishCheck?(settings: Values, now: number): FieldError[];
  /** Páginas e dispositivos efetivos segundo as escolhas do lojista. */
  targets(settings: Values): { pages: PageType[]; devices: string[] };
  /** O que a loja recebe. Montado campo a campo; nada de rascunho ou nota interna. */
  project(settings: Values, ctx: ProjectContext): Values | null;
}

// --------------------------------------------------------------- registro

const REGISTRY = new Map<string, ModuleDef>();

export function registerModule(def: ModuleDef): void {
  if (REGISTRY.has(def.id)) throw new Error(`módulo duplicado: ${def.id}`);
  REGISTRY.set(def.id, def);
}

export function moduleDefs(): ModuleDef[] {
  return [...REGISTRY.values()];
}

export function moduleDef(id: string): ModuleDef | undefined {
  return REGISTRY.get(id);
}

// ------------------------------------------------------------- configuração

export function defaultConfig(identity: Identity = DEFAULT_IDENTITY): StoreConfig {
  const modules: Record<string, ModuleState> = {};
  for (const def of REGISTRY.values()) {
    modules[def.id] = { enabled: false, settings: withDefaults(def.fields, def.defaults, {}) };
  }
  return { schemaVersion: SCHEMA_VERSION, identity: { ...identity }, library: { videos: [] }, modules };
}

/**
 * Sugestões para lojas NOVAS. Os padrões dos módulos preservam o que as lojas existentes já
 * mostram (um campo novo nunca muda uma loja que já está no ar); aqui ficam os pontos de partida
 * melhores para quem começa agora.
 */
export const NEW_STORE_SETTINGS: Record<string, Record<string, unknown>> = {
  coupons: { styleMobile: 'compacto' },
};

export function newStoreConfig(identity: Identity = DEFAULT_IDENTITY): StoreConfig {
  const c = defaultConfig(identity);
  for (const [id, over] of Object.entries(NEW_STORE_SETTINGS)) if (c.modules[id]) c.modules[id]!.settings = { ...c.modules[id]!.settings, ...over };
  return c;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const VIDEO_ID = /^[a-z0-9]{6,32}$/;

function validateLibrary(raw: unknown): { value: Library; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const src = isRecord(raw) && Array.isArray(raw.videos) ? raw.videos : [];
  if (src.length > 40) errors.push({ field: 'library.videos', message: 'Biblioteca: no máximo 40 vídeos.' });
  const seen = new Set<string>();
  const videos: Video[] = src.slice(0, 40).map((v, i) => {
    const r = isRecord(v) ? v : {};
    const path = `library.videos.${i}`;
    const id = typeof r.id === 'string' && VIDEO_ID.test(r.id) && !seen.has(r.id) ? r.id : '';
    if (!id) errors.push({ field: `${path}.id`, message: 'Vídeo: identificador inválido.' });
    seen.add(id);
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    if (!title || title.length > 80 || !isPlainText(title)) errors.push({ field: `${path}.title`, message: 'Vídeo: título obrigatório, até 80 caracteres, só texto.' });
    const caption = typeof r.caption === 'string' ? r.caption.trim() : '';
    if (caption.length > 140 || !isPlainText(caption)) errors.push({ field: `${path}.caption`, message: 'Vídeo: legenda até 140 caracteres, só texto.' });
    const videoUrl = typeof r.videoUrl === 'string' ? r.videoUrl.trim() : '';
    if (!isHttpsUrl(videoUrl) && !/^\/__pink\/media\/[a-z0-9]{16,40}$/.test(videoUrl)) {
      errors.push({ field: `${path}.videoUrl`, message: 'Vídeo: envie o arquivo ou informe um endereço https do vídeo (.mp4).' });
    }
    const posterUrl = typeof r.posterUrl === 'string' ? r.posterUrl.trim() : '';
    if (posterUrl && !isHttpsUrl(posterUrl) && !/^\/__pink\/media\/[a-z0-9]{16,40}$/.test(posterUrl)) {
      errors.push({ field: `${path}.posterUrl`, message: 'Vídeo: a capa precisa ser um arquivo enviado ou um endereço https.' });
    }
    const productPaths = Array.isArray(r.productPaths) ? r.productPaths.filter((p): p is string => typeof p === 'string').map((p) => p.trim()).filter(Boolean) : [];
    if (productPaths.length > 6 || productPaths.some((p) => !isStorePath(p))) {
      errors.push({ field: `${path}.productPaths`, message: 'Vídeo: até 6 produtos, cada um com o caminho da página do produto na loja.' });
    }
    return { id, title, caption, videoUrl, posterUrl, productPaths: productPaths.slice(0, 6) };
  });
  return { value: { videos }, errors };
}

/** Valida e normaliza a configuração inteira de uma loja (rascunho ou publicação). */
export function parseStoreConfig(raw: unknown): { value: StoreConfig; errors: FieldError[] } {
  const src = isRecord(raw) ? raw : {};
  const errors: FieldError[] = [];
  if (src.schemaVersion !== SCHEMA_VERSION) errors.push({ field: 'schemaVersion', message: 'Formato de configuração não reconhecido.' });
  const identity = validateIdentity(src.identity ?? DEFAULT_IDENTITY);
  errors.push(...identity.errors);
  const library = validateLibrary(src.library);
  errors.push(...library.errors);
  const videoIds = new Set(library.value.videos.map((v) => v.id));
  const rawModules = isRecord(src.modules) ? src.modules : {};
  const modules: Record<string, ModuleState> = {};
  for (const def of REGISTRY.values()) {
    const m = isRecord(rawModules[def.id]) ? (rawModules[def.id] as Record<string, unknown>) : {};
    const enabled = m.enabled === true;
    const filled = withDefaults(def.fields, def.defaults, m.settings);
    const r = validateFields(def.fields, filled, `modules.${def.id}`, { videoIds, complete: enabled });
    // Regras entre campos só valem para o que vai ao ar.
    const extra = enabled ? (def.check?.(r.value, { library: library.value }) ?? []) : [];
    errors.push(...r.errors, ...extra.map((e) => ({ ...e, field: `modules.${def.id}.${e.field}` })));
    modules[def.id] = { enabled, settings: r.value };
  }
  return { value: { schemaVersion: SCHEMA_VERSION, identity: identity.value, library: library.value, modules }, errors };
}

/** Erros que impedem publicar (somente módulos ligados). */
export function publishErrors(config: StoreConfig, entitled: Set<string>, now: number): FieldError[] {
  const errors: FieldError[] = [];
  for (const def of REGISTRY.values()) {
    const m = config.modules[def.id];
    if (!m?.enabled) continue;
    if (!entitled.has(def.id)) {
      errors.push({ field: `modules.${def.id}.enabled`, message: `${def.name}: módulo não liberado para esta loja.` });
      continue;
    }
    errors.push(...(def.publishCheck?.(m.settings, now) ?? []).map((e) => ({ ...e, field: `modules.${def.id}.${e.field}` })));
  }
  return errors;
}

export function toPublicConfig(
  store: { id: string; basePath: string },
  version: number,
  publishedAt: string,
  config: StoreConfig,
  entitled: Set<string>,
  now = Date.now(),
): PublicConfig {
  const theme = toTheme(config.identity);
  const modules: Record<string, PublicModule> = {};
  for (const def of REGISTRY.values()) {
    const m = config.modules[def.id];
    if (!m?.enabled || !entitled.has(def.id)) continue;
    const settings = def.project(m.settings, { theme, library: config.library, basePath: store.basePath, now });
    if (!settings) continue;
    const t = def.targets(m.settings);
    modules[def.id] = { pages: t.pages.filter((p) => def.pages.includes(p)), devices: t.devices, settings };
  }
  return { schemaVersion: SCHEMA_VERSION, storeId: store.id, version, publishedAt, basePath: store.basePath, theme, modules };
}

/** Validação da camada pública restrita aos módulos registrados. */
export function parsePublicConfig(raw: unknown, expectedStoreId?: string): PublicConfig | null {
  return parsePublicConfigWith(raw, (id) => REGISTRY.has(id), expectedStoreId);
}
