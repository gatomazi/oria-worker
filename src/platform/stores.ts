// Lojas, pacotes, liberação de módulos, rascunho, publicação e restauração.
// Toda entrada é revalidada aqui; o painel não é fonte de verdade.
import { isDeepStrictEqual } from 'node:util';
import { randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import { tx } from './db.ts';
import '../shared/modules/index.ts';
import { isPlainText, isStorePath, type FieldError } from '../shared/fields.ts';
import { DEFAULT_IDENTITY, validateIdentity, type Identity } from '../shared/identity.ts';
import {
  defaultConfig,
  moduleDef,
  moduleDefs,
  parseStoreConfig,
  publishErrors,
  toPublicConfig,
  type PublicConfig,
  type StoreConfig,
} from '../shared/registry.ts';

export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly errors: FieldError[];
  constructor(status: number, code: string, message: string, errors: FieldError[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.errors = errors;
  }
}

export const STORE_ID = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const HOSTNAME = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const DEV_HOST = /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?\.localhost$/;

/** Capacidades de integração da INK, preenchidas pelo operador. */
export interface Integration {
  /** Turbo Drive ativo na navegação (afeta montagem/desmontagem). */
  turbo: boolean;
  /** Página de busca da loja (caminho), usada pelo cabeçalho e pelo chat. */
  searchPath: string;
  /** WhatsApp de atendimento (DDI+DDD+número) para o chat e o compartilhamento. */
  supportWhatsapp: string;
  /**
   * Somente proxy local: deixa passar adicionar/alterar itens do carrinho
   * (POST <base>/cart e <base>/cart/item) com a sessão. Checkout e demais
   * escritas continuam bloqueados. Desligado por padrão.
   */
  proxyCart: boolean;
}

export const DEFAULT_INTEGRATION: Integration = { turbo: false, searchPath: '', supportWhatsapp: '', proxyCart: false };

export interface Store {
  id: string;
  name: string;
  kind: 'ink' | 'demo';
  status: 'setup' | 'active' | 'paused';
  ownerName: string;
  ownerEmail: string;
  domain: string;
  basePath: string;
  devHost: string;
  devOrigin: string;
  integration: Integration;
  extraModules: string[];
  packages: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface Package {
  id: string;
  name: string;
  description: string;
  modules: string[];
}

export interface PublicationSummary {
  version: number;
  publishedAt: string;
  action: string;
  note: string;
  publishedBy: string | null;
  enabledModules: string[];
}

export interface StoreView {
  store: Store;
  entitled: string[];
  draft: { config: StoreConfig; updatedAt: string };
  published: { version: number; publishedAt: string; action: string; config: StoreConfig } | null;
  draftMatchesPublished: boolean;
  history: PublicationSummary[];
}

function json<T>(s: unknown, fallback: T): T {
  try {
    return typeof s === 'string' ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

const nowIso = (now: Date) => now.toISOString();

export class StoreService {
  private db: Db;
  private now: () => Date;

  constructor(db: Db, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  audit(userId: number | null, storeId: string | null, action: string, detail = ''): void {
    this.db.prepare('INSERT INTO audit (at, user_id, store_id, action, detail) VALUES (?, ?, ?, ?, ?)').run(nowIso(this.now()), userId, storeId, action, detail);
  }

  // ------------------------------------------------------------- lojas

  private rowToStore(r: Record<string, unknown>): Store {
    const packages = (this.db.prepare('SELECT package_id FROM store_packages WHERE store_id = ? ORDER BY package_id').all(r.id as string) as { package_id: string }[]).map(
      (p) => p.package_id,
    );
    return {
      id: String(r.id),
      name: String(r.name),
      kind: r.kind as Store['kind'],
      status: r.status as Store['status'],
      ownerName: String(r.owner_name),
      ownerEmail: String(r.owner_email),
      domain: String(r.domain),
      basePath: String(r.base_path),
      devHost: String(r.dev_host),
      devOrigin: String(r.dev_origin),
      integration: { ...DEFAULT_INTEGRATION, ...json<Partial<Integration>>(r.integration, {}) },
      extraModules: json<string[]>(r.extra_modules, []),
      packages,
      notes: String(r.notes),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  /** Só devolve lojas cujo id passa no padrão; nunca monta caminho a partir de texto livre. */
  get(id: unknown): Store | null {
    if (typeof id !== 'string' || !STORE_ID.test(id)) return null;
    const r = this.db.prepare('SELECT * FROM stores WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToStore(r) : null;
  }

  list(): Store[] {
    return (this.db.prepare('SELECT * FROM stores ORDER BY created_at, id').all() as Record<string, unknown>[]).map((r) => this.rowToStore(r));
  }

  byDevHost(host: string): Store | null {
    const r = this.db.prepare('SELECT * FROM stores WHERE dev_host = ?').get(host.toLowerCase()) as Record<string, unknown> | undefined;
    return r ? this.rowToStore(r) : null;
  }

  entitled(store: Store): Set<string> {
    const set = new Set<string>(store.extraModules);
    for (const pid of store.packages) {
      const p = this.getPackage(pid);
      p?.modules.forEach((m) => set.add(m));
    }
    for (const m of [...set]) if (!moduleDef(m)) set.delete(m);
    return set;
  }

  validateStoreInput(raw: unknown, existing: Store | null): { value: Omit<Store, 'createdAt' | 'updatedAt' | 'packages'> & { packages: string[] }; errors: FieldError[] } {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const errors: FieldError[] = [];
    const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string).trim() : '');
    const id = existing ? existing.id : str('id').toLowerCase();
    if (!existing) {
      if (!STORE_ID.test(id)) errors.push({ field: 'id', message: 'Identificador: 3 a 40 caracteres, letras minúsculas, números e hífen.' });
      else if (this.get(id)) errors.push({ field: 'id', message: 'Identificador: já existe uma loja com este identificador.' });
    }
    const name = str('name');
    if (!name || name.length > 80 || !isPlainText(name)) errors.push({ field: 'name', message: 'Nome da loja: obrigatório, até 80 caracteres.' });
    const ownerName = str('ownerName');
    if (ownerName.length > 80 || !isPlainText(ownerName)) errors.push({ field: 'ownerName', message: 'Responsável: até 80 caracteres.' });
    const ownerEmail = str('ownerEmail').toLowerCase();
    if (ownerEmail && !/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/.test(ownerEmail)) errors.push({ field: 'ownerEmail', message: 'E-mail do responsável inválido.' });
    const domain = str('domain').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!HOSTNAME.test(domain)) errors.push({ field: 'domain', message: 'Domínio: informe o domínio da loja, por exemplo www.minhaloja.com.br.' });
    const basePath = str('basePath').replace(/\/$/, '');
    if (basePath && (!isStorePath(basePath) || basePath.includes('?') || basePath.length > 60)) {
      errors.push({ field: 'basePath', message: 'Caminho da loja: algo como /minhaloja (ou vazio se a loja fica na raiz).' });
    }
    const kind = existing?.kind ?? (r.kind === 'demo' ? 'demo' : 'ink');
    const devHost = (str('devHost') || `${id}.localhost`).toLowerCase();
    if (!DEV_HOST.test(devHost)) errors.push({ field: 'devHost', message: 'Endereço local: use <nome>.localhost.' });
    else {
      const other = this.byDevHost(devHost);
      if (other && other.id !== id) errors.push({ field: 'devHost', message: 'Endereço local já usado por outra loja.' });
    }
    const devOrigin = kind === 'demo' ? (existing?.devOrigin ?? str('devOrigin')) : `https://${domain}`;
    if (kind === 'demo' && !/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(devOrigin)) errors.push({ field: 'devOrigin', message: 'Loja demo: origem local inválida.' });
    const statusRaw = str('status') || existing?.status || 'setup';
    const status = (['setup', 'active', 'paused'] as const).includes(statusRaw as Store['status']) ? (statusRaw as Store['status']) : 'setup';
    const integ = (typeof r.integration === 'object' && r.integration !== null ? r.integration : {}) as Record<string, unknown>;
    const searchPath = typeof integ.searchPath === 'string' ? integ.searchPath.trim() : existing?.integration.searchPath ?? '';
    if (searchPath && !isStorePath(searchPath)) errors.push({ field: 'integration.searchPath', message: 'Caminho da busca: caminho da loja, por exemplo /minhaloja/products.' });
    const whats = (typeof integ.supportWhatsapp === 'string' ? integ.supportWhatsapp : existing?.integration.supportWhatsapp ?? '').replace(/\D/g, '');
    if (whats && (whats.length < 12 || whats.length > 13)) errors.push({ field: 'integration.supportWhatsapp', message: 'WhatsApp: DDI + DDD + número.' });
    const integration: Integration = {
      turbo: typeof integ.turbo === 'boolean' ? integ.turbo : existing?.integration.turbo ?? false,
      searchPath,
      supportWhatsapp: whats,
      proxyCart: typeof integ.proxyCart === 'boolean' ? integ.proxyCart : existing?.integration.proxyCart ?? false,
    };
    const extraModules = Array.isArray(r.extraModules) ? r.extraModules.filter((m): m is string => typeof m === 'string') : existing?.extraModules ?? [];
    if (extraModules.some((m) => !moduleDef(m))) errors.push({ field: 'extraModules', message: 'Módulo desconhecido na liberação.' });
    const packages = Array.isArray(r.packages) ? r.packages.filter((p): p is string => typeof p === 'string') : existing?.packages ?? [];
    if (packages.some((p) => !this.getPackage(p))) errors.push({ field: 'packages', message: 'Pacote desconhecido.' });
    const notes = str('notes');
    if (notes.length > 1000 || !isPlainText(notes, true)) errors.push({ field: 'notes', message: 'Observações: até 1000 caracteres, só texto.' });
    return {
      value: { id, name, kind, status, ownerName, ownerEmail, domain, basePath, devHost, devOrigin, integration, extraModules: [...new Set(extraModules)], packages: [...new Set(packages)], notes },
      errors,
    };
  }

  /** Cadastra a loja, a identidade inicial e o rascunho com os módulos liberados prontos para configurar. */
  createStore(raw: unknown, identityRaw: unknown, userId: number | null): Store {
    const { value, errors } = this.validateStoreInput(raw, null);
    const identity = validateIdentity(identityRaw ?? DEFAULT_IDENTITY);
    errors.push(...identity.errors);
    if (errors.length) throw new ServiceError(422, 'invalid_store', 'Revise os dados da loja.', errors);
    const now = nowIso(this.now());
    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO stores (id, name, kind, status, owner_name, owner_email, domain, base_path, dev_host, dev_origin, integration, extra_modules, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(value.id, value.name, value.kind, value.status, value.ownerName, value.ownerEmail, value.domain, value.basePath, value.devHost, value.devOrigin, JSON.stringify(value.integration), JSON.stringify(value.extraModules), value.notes, now, now);
      for (const p of value.packages) this.db.prepare('INSERT INTO store_packages (store_id, package_id) VALUES (?, ?)').run(value.id, p);
      this.db.prepare('INSERT INTO drafts (store_id, config, updated_at, updated_by) VALUES (?, ?, ?, ?)').run(value.id, JSON.stringify(defaultConfig(identity.value)), now, userId);
    });
    this.audit(userId, value.id, 'store.create', value.name);
    return this.get(value.id)!;
  }

  updateStore(id: string, raw: unknown, userId: number | null): Store {
    const existing = this.mustGet(id);
    const { value, errors } = this.validateStoreInput(raw, existing);
    if (errors.length) throw new ServiceError(422, 'invalid_store', 'Revise os dados da loja.', errors);
    tx(this.db, () => {
      this.db
        .prepare(
          `UPDATE stores SET name = ?, status = ?, owner_name = ?, owner_email = ?, domain = ?, base_path = ?, dev_host = ?, dev_origin = ?, integration = ?, extra_modules = ?, notes = ?, updated_at = ? WHERE id = ?`,
        )
        .run(value.name, value.status, value.ownerName, value.ownerEmail, value.domain, value.basePath, value.devHost, value.devOrigin, JSON.stringify(value.integration), JSON.stringify(value.extraModules), value.notes, nowIso(this.now()), id);
      this.db.prepare('DELETE FROM store_packages WHERE store_id = ?').run(id);
      for (const p of value.packages) this.db.prepare('INSERT INTO store_packages (store_id, package_id) VALUES (?, ?)').run(id, p);
    });
    this.audit(userId, id, 'store.update');
    return this.get(id)!;
  }

  mustGet(id: string): Store {
    const s = this.get(id);
    if (!s) throw new ServiceError(404, 'unknown_store', 'Loja não cadastrada.');
    return s;
  }

  // ----------------------------------------------------------- pacotes

  getPackage(id: string): Package | null {
    const r = this.db.prepare('SELECT * FROM packages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? { id: String(r.id), name: String(r.name), description: String(r.description), modules: json<string[]>(r.modules, []) } : null;
  }

  listPackages(): Package[] {
    return (this.db.prepare('SELECT id FROM packages ORDER BY created_at, id').all() as { id: string }[]).map((r) => this.getPackage(r.id)!);
  }

  savePackage(raw: unknown, userId: number | null): Package {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const errors: FieldError[] = [];
    const id = typeof r.id === 'string' ? r.id.trim().toLowerCase() : '';
    if (!STORE_ID.test(id)) errors.push({ field: 'id', message: 'Identificador do pacote: letras minúsculas, números e hífen.' });
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name || name.length > 60 || !isPlainText(name)) errors.push({ field: 'name', message: 'Nome do pacote: obrigatório, até 60 caracteres.' });
    const description = typeof r.description === 'string' ? r.description.trim() : '';
    if (description.length > 300 || !isPlainText(description)) errors.push({ field: 'description', message: 'Descrição: até 300 caracteres.' });
    const modules = Array.isArray(r.modules) ? [...new Set(r.modules.filter((m): m is string => typeof m === 'string'))] : [];
    if (!modules.length || modules.some((m) => !moduleDef(m))) errors.push({ field: 'modules', message: 'Escolha pelo menos um módulo válido.' });
    if (errors.length) throw new ServiceError(422, 'invalid_package', 'Revise o pacote.', errors);
    const now = nowIso(this.now());
    this.db
      .prepare(
        `INSERT INTO packages (id, name, description, modules, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, modules = excluded.modules, updated_at = excluded.updated_at`,
      )
      .run(id, name, description, JSON.stringify(modules), now, now);
    this.audit(userId, null, 'package.save', id);
    return this.getPackage(id)!;
  }

  // ------------------------------------------------------ configuração

  private draftRow(store: Store): { config: StoreConfig; updatedAt: string } {
    const r = this.db.prepare('SELECT config, updated_at FROM drafts WHERE store_id = ?').get(store.id) as { config: string; updated_at: string } | undefined;
    const parsed = parseStoreConfig(json(r?.config, defaultConfig()));
    // Módulos novos no registro aparecem com seus padrões, sem quebrar rascunhos antigos.
    return { config: parsed.value, updatedAt: r?.updated_at ?? store.createdAt };
  }

  private latestPublication(storeId: string): { version: number; publishedAt: string; action: string; config: StoreConfig } | null {
    const r = this.db.prepare('SELECT * FROM publications WHERE store_id = ? ORDER BY version DESC LIMIT 1').get(storeId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return { version: Number(r.version), publishedAt: String(r.published_at), action: String(r.action), config: parseStoreConfig(json(r.config, {})).value };
  }

  history(storeId: string, limit = 30): PublicationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT p.version, p.published_at, p.action, p.note, p.config, u.name AS by_name
         FROM publications p LEFT JOIN users u ON u.id = p.published_by WHERE p.store_id = ? ORDER BY p.version DESC LIMIT ?`,
      )
      .all(storeId, limit) as Record<string, unknown>[];
    return rows.map((r) => {
      const cfg = json<{ modules?: Record<string, { enabled?: boolean }> }>(r.config, {});
      return {
        version: Number(r.version),
        publishedAt: String(r.published_at),
        action: String(r.action),
        note: String(r.note),
        publishedBy: (r.by_name as string | null) ?? null,
        enabledModules: Object.entries(cfg.modules ?? {})
          .filter(([, m]) => m?.enabled)
          .map(([id]) => id),
      };
    });
  }

  view(id: string): StoreView {
    const store = this.mustGet(id);
    const draft = this.draftRow(store);
    const published = this.latestPublication(id);
    return {
      store,
      entitled: [...this.entitled(store)],
      draft,
      published,
      draftMatchesPublished: published !== null && isDeepStrictEqual(draft.config, published.config),
      history: this.history(id),
    };
  }

  saveDraft(id: string, raw: unknown, expectedUpdatedAt: unknown, userId: number | null): StoreView {
    const store = this.mustGet(id);
    const parsed = parseStoreConfig(raw);
    if (parsed.errors.length) throw new ServiceError(422, 'invalid_config', 'Revise os campos destacados.', parsed.errors);
    const entitled = this.entitled(store);
    const blocked = Object.entries(parsed.value.modules).filter(([mid, m]) => m.enabled && !entitled.has(mid));
    if (blocked.length) {
      throw new ServiceError(
        403,
        'module_not_entitled',
        'Há módulo ativado que não está liberado para esta loja.',
        blocked.map(([mid]) => ({ field: `modules.${mid}.enabled`, message: `${moduleDef(mid)?.name ?? mid}: não liberado para esta loja.` })),
      );
    }
    tx(this.db, () => {
      const current = this.draftRow(store);
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== current.updatedAt) {
        throw new ServiceError(409, 'draft_changed', 'O rascunho foi alterado em outra janela. Recarregue para não sobrescrever.');
      }
      this.db
        .prepare('INSERT INTO drafts (store_id, config, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(store_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
        .run(id, JSON.stringify(parsed.value), nowIso(this.now()), userId);
    });
    this.audit(userId, id, 'draft.save');
    return this.view(id);
  }

  private insertPublication(store: Store, config: StoreConfig, action: string, note: string, userId: number | null): number {
    const latest = this.latestPublication(store.id);
    const version = (latest?.version ?? 0) + 1;
    this.db
      .prepare('INSERT INTO publications (store_id, version, config, published_at, published_by, action, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(store.id, version, JSON.stringify(config), nowIso(this.now()), userId, action, note);
    return version;
  }

  publish(id: string, expectedDraftUpdatedAt: unknown, userId: number | null): StoreView {
    const store = this.mustGet(id);
    tx(this.db, () => {
      const draft = this.draftRow(store);
      if (expectedDraftUpdatedAt !== draft.updatedAt) {
        throw new ServiceError(409, 'draft_changed', 'O rascunho mudou desde que foi aberto. Recarregue antes de publicar.');
      }
      const reparsed = parseStoreConfig(draft.config);
      const errs = [...reparsed.errors, ...publishErrors(reparsed.value, this.entitled(store), this.now().getTime())];
      if (errs.length) throw new ServiceError(422, 'invalid_config', 'O rascunho não pode ser publicado ainda.', errs);
      this.insertPublication(store, reparsed.value, 'publish', '', userId);
    });
    this.audit(userId, id, 'publish');
    return this.view(id);
  }

  /**
   * Liga/desliga um módulo na loja já: nova versão a partir da PUBLICADA,
   * só com aquele módulo trocado. Edições pendentes do rascunho não vão junto;
   * o "ativo" do rascunho é sincronizado para a próxima publicação não reverter.
   */
  setModuleState(id: string, moduleId: unknown, enabled: unknown, userId: number | null): StoreView {
    const store = this.mustGet(id);
    const def = typeof moduleId === 'string' ? moduleDef(moduleId) : undefined;
    if (!def) throw new ServiceError(400, 'unknown_module', 'Módulo desconhecido.');
    if (typeof enabled !== 'boolean') throw new ServiceError(400, 'bad_request', 'Informe enabled como verdadeiro ou falso.');
    tx(this.db, () => {
      const pub = this.latestPublication(id);
      if (!pub) throw new ServiceError(409, 'not_published', 'Publique uma configuração antes de ligar ou desligar módulos na loja.');
      if (enabled && !this.entitled(store).has(def.id)) throw new ServiceError(403, 'module_not_entitled', `${def.name}: módulo não liberado para esta loja.`);
      const current = pub.config.modules[def.id]?.enabled ?? false;
      if (current === enabled) throw new ServiceError(409, 'unchanged', enabled ? `${def.name} já está ligado na loja.` : `${def.name} já está desligado na loja.`);
      const config = structuredClone(pub.config);
      config.modules[def.id]!.enabled = enabled;
      if (enabled) {
        const errs = publishErrors(config, this.entitled(store), this.now().getTime());
        if (errs.length) throw new ServiceError(422, 'invalid_config', `${def.name} não pode ser religado como está publicado.`, errs);
      }
      this.insertPublication(store, config, enabled ? 'enable' : 'disable', def.id, userId);
      const draft = this.draftRow(store);
      draft.config.modules[def.id]!.enabled = enabled;
      this.db.prepare('UPDATE drafts SET config = ?, updated_at = ?, updated_by = ? WHERE store_id = ?').run(JSON.stringify(draft.config), nowIso(this.now()), userId, id);
    });
    this.audit(userId, id, enabled ? 'module.enable' : 'module.disable', def.id);
    return this.view(id);
  }

  /** Volta para uma versão anterior: vira uma nova versão publicada igual à escolhida, e o rascunho acompanha. */
  restore(id: string, version: unknown, userId: number | null): StoreView {
    const store = this.mustGet(id);
    if (typeof version !== 'number' || !Number.isInteger(version)) throw new ServiceError(400, 'bad_request', 'Versão inválida.');
    tx(this.db, () => {
      const r = this.db.prepare('SELECT config FROM publications WHERE store_id = ? AND version = ?').get(id, version) as { config: string } | undefined;
      if (!r) throw new ServiceError(404, 'unknown_version', `Versão ${version} não encontrada.`);
      const parsed = parseStoreConfig(json(r.config, {}));
      const entitled = this.entitled(store);
      // Módulo que deixou de ser liberado não volta ligado.
      for (const [mid, m] of Object.entries(parsed.value.modules)) if (m.enabled && !entitled.has(mid)) m.enabled = false;
      const errs = publishErrors(parsed.value, entitled, this.now().getTime());
      if (errs.length) throw new ServiceError(422, 'invalid_config', `A versão ${version} não pode ser restaurada como está.`, errs);
      this.insertPublication(store, parsed.value, 'restore', `v${version}`, userId);
      this.db.prepare('UPDATE drafts SET config = ?, updated_at = ?, updated_by = ? WHERE store_id = ?').run(JSON.stringify(parsed.value), nowIso(this.now()), userId, id);
    });
    this.audit(userId, id, 'restore', `v${version}`);
    return this.view(id);
  }

  /** Projeção pública da última versão publicada (ou null). Módulos não liberados ficam de fora. */
  publicConfig(id: string): PublicConfig | null {
    const store = this.get(id);
    if (!store || store.status === 'paused') return null;
    const pub = this.latestPublication(id);
    if (!pub) return null;
    return toPublicConfig(store, pub.version, pub.publishedAt, pub.config, this.entitled(store), this.now().getTime());
  }

  /** Projeção do RASCUNHO, só para a prévia autenticada do painel. */
  draftPublicConfig(id: string): PublicConfig {
    const store = this.mustGet(id);
    const draft = this.draftRow(store);
    return toPublicConfig(store, 0, draft.updatedAt, draft.config, this.entitled(store), this.now().getTime());
  }

  /** Configuração completa (servidor) de um módulo ligado e liberado na versão publicada. */
  publishedModuleSettings(id: string, moduleId: string): Record<string, unknown> | null {
    const store = this.get(id);
    if (!store || store.status === 'paused' || !this.entitled(store).has(moduleId)) return null;
    const m = this.latestPublication(id)?.config.modules[moduleId];
    return m?.enabled ? m.settings : null;
  }

  /** Igual, a partir do rascunho (só para a prévia autenticada). */
  draftModuleSettings(id: string, moduleId: string): Record<string, unknown> | null {
    const store = this.get(id);
    if (!store || !this.entitled(store).has(moduleId)) return null;
    const m = this.draftRow(store).config.modules[moduleId];
    return m?.enabled ? m.settings : null;
  }

  newMediaId(): string {
    return randomBytes(12).toString('hex');
  }

  modulesCatalog() {
    return moduleDefs().map((d) => ({ id: d.id, code: d.code, name: d.name, summary: d.summary, pages: d.pages, integrations: d.integrations, fields: d.fields, defaults: d.defaults }));
  }
}

export type { Identity };
