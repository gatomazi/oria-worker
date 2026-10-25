// Integração por loja: dados pré-carregados para os módulos, sem o lojista digitar tudo.
//  - Leitura da loja (qualquer plano): páginas públicas da INK, só GET, no servidor.
//    FAQ, trocas, sobre, contatos, coleções e os cupons que a INK mostra no produto
//    (inclusive as faixas de promoção progressiva).
//  - API da INK (planos com API; https://developers.reserva.ink): token guardado cifrado,
//    nunca devolvido ao painel nem enviado à loja. Só leituras: promoções (standard,
//    progressive, unit_free), categorias e o índice de produtos publicados.
// O resultado fica num retrato com data; uma leitura que falha mantém o último retrato bom.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import {
  inkImage,
  parseAbout,
  parseContacts,
  parseFaq,
  parseProductCards,
  parseProductPromotions,
  parseReviews,
  parseStoreSections,
  parseTheme,
  progressiveTiers,
  type FaqItem,
  type NativeCoupon,
  type ProgressiveTier,
  type StoreContacts,
  type StoreTheme,
} from '../shared/ink-parse.ts';
import { isStorePath } from '../shared/fields.ts';
import { normalizePromotion, type InkPromotion } from '../shared/ink-promotions.ts';
import type { CatalogReader } from './catalog.ts';
import type { Db } from './db.ts';
import { ServiceError, type Store } from './stores.ts';

export const INK_API_BASE = process.env.INK_API_BASE_URL ?? 'https://api.reserva.ink';
/** Retrato mais velho que isso é renovado em segundo plano quando alguém usa. */
export const SYNC_STALE_MS = 12 * 3600_000;

export interface SiteCoupon extends NativeCoupon {
  /** Produto em que o cupom apareceu (a INK pode limitar cupons a produtos). */
  seenOn: string;
}

export interface SiteData {
  faq: (FaqItem & { page: 'faq' | 'trocas' })[];
  about: { name: string; text: string } | null;
  contacts: StoreContacts;
  sections: { label: string; path: string }[];
  coupons: SiteCoupon[];
  progressive: { code: string; measure: 'itens'; tiers: ProgressiveTier[] }[];
  /** Cores e logo que a loja já usa (sugestão de identidade). */
  theme: StoreTheme | null;
  /** Avaliações publicadas na página de avaliações da loja (0 = nenhuma). */
  reviews: number;
  pages: { label: string; path: string; ok: boolean; detail: string }[];
}

export interface ApiCollection {
  id: number;
  name: string;
  slug: string;
  path: string;
  description: string;
  position: number;
  products: number;
}

/** Produto publicado, compacto: o que o assistente e o painel usam. */
export interface ApiProduct {
  id: number;
  name: string;
  path: string;
  image: string;
  price: number | null;
  promotionalPrice: number | null;
  tags: string[];
  type: string;
  sizes: string[];
  colors: string[];
  sales: number;
  cluster: number | null;
}

export interface ApiData {
  promotions: InkPromotion[];
  collections: ApiCollection[];
  products: ApiProduct[];
  /** Por recurso: o que não deu para ler (ex.: escopo que o token não tem). */
  problems: { resource: string; message: string }[];
}

/** O que o painel recebe da API: promoções e categorias inteiras, produtos resumidos. */
export interface ApiSummary {
  at: string;
  promotions: InkPromotion[];
  collections: ApiCollection[];
  products: { total: number; bestSellers: Pick<ApiProduct, 'name' | 'path' | 'sales'>[]; withTags: number; clusters: number };
  problems: ApiData['problems'];
}

export interface IntegrationStatus {
  site: { data: SiteData | null; fetchedAt: string | null; error: string | null; errorAt: string | null };
  api: {
    configured: boolean;
    /** Últimos 4 caracteres, para a pessoa reconhecer qual token está guardado. */
    hint: string | null;
    setAt: string | null;
    testedAt: string | null;
    testOk: boolean | null;
    testMessage: string | null;
    base: string;
    data: ApiSummary | null;
  };
}

export class IntegrationService {
  private db: Db;
  private catalog: CatalogReader;
  private key: Buffer;
  private fetchImpl: typeof fetch;
  private running = new Map<string, Promise<IntegrationStatus>>();

  constructor(deps: { db: Db; catalog: CatalogReader; secret: Buffer; fetchImpl?: typeof fetch }) {
    this.db = deps.db;
    this.catalog = deps.catalog;
    this.key = Buffer.from(hkdfSync('sha256', deps.secret, Buffer.alloc(0), 'ink-api-token', 32));
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  status(storeId: string): IntegrationStatus {
    const s = this.db.prepare('SELECT data, fetched_at, error, error_at FROM store_sync WHERE store_id = ?').get(storeId) as Record<string, string | null> | undefined;
    const a = this.db.prepare('SELECT token_hint, set_at, tested_at, test_ok, test_message, api_data, api_at FROM ink_api WHERE store_id = ?').get(storeId) as Record<string, string | number | null> | undefined;
    const api = a?.api_data ? (JSON.parse(a.api_data as string) as ApiData) : null;
    return {
      site: { data: s?.data ? (JSON.parse(s.data) as SiteData) : null, fetchedAt: s?.fetched_at ?? null, error: s?.error ?? null, errorAt: s?.error_at ?? null },
      api: {
        configured: !!a,
        hint: (a?.token_hint as string) ?? null,
        setAt: (a?.set_at as string) ?? null,
        testedAt: (a?.tested_at as string) ?? null,
        testOk: a?.test_ok === null || a?.test_ok === undefined ? null : a.test_ok === 1,
        testMessage: (a?.test_message as string) ?? null,
        base: INK_API_BASE,
        data: api ? summarize(api, a!.api_at as string) : null,
      },
    };
  }

  /** Retrato completo da API (só no servidor). */
  apiData(storeId: string): ApiData | null {
    const row = this.db.prepare('SELECT api_data FROM ink_api WHERE store_id = ?').get(storeId) as { api_data: string | null } | undefined;
    return row?.api_data ? (JSON.parse(row.api_data) as ApiData) : null;
  }

  siteData(storeId: string): SiteData | null {
    return this.status(storeId).site.data;
  }

  /** Renova em segundo plano se o retrato não existe ou está velho. Nunca lança. */
  refreshIfStale(store: Store): void {
    const at = this.status(store.id).site.fetchedAt;
    if (at && Date.now() - Date.parse(at) < SYNC_STALE_MS) return;
    void this.syncSite(store).catch(() => undefined);
  }

  /** Lê as páginas públicas da loja e guarda o retrato. Uma leitura por loja de cada vez. */
  syncSite(store: Store): Promise<IntegrationStatus> {
    const running = this.running.get(store.id);
    if (running) return running;
    const job = this.readSite(store)
      .then(async (st) => (st.api.configured ? this.syncApi(store) : st))
      .finally(() => this.running.delete(store.id));
    this.running.set(store.id, job);
    return job;
  }

  private async readSite(store: Store): Promise<IntegrationStatus> {
    const base = store.basePath;
    const pages: SiteData['pages'] = [];
    const get = async (label: string, path: string) => {
      try {
        const doc = await this.catalog.document(store, path);
        pages.push({ label, path, ok: true, detail: '' });
        return doc;
      } catch (err) {
        pages.push({ label, path, ok: false, detail: (err as Error).message });
        return null;
      }
    };
    const home = await get('Início', base || '/');
    const faqDoc = await get('Perguntas frequentes', `${base}/faq`);
    const tradeDoc = await get('Trocas e devoluções', `${base}/exchanges_and_returns`);
    const aboutDoc = await get('Sobre', `${base}/about`);

    const faq: SiteData['faq'] = [];
    for (const [doc, page] of [[faqDoc, 'faq'], [tradeDoc, 'trocas']] as const) {
      for (const item of doc ? parseFaq(doc) : []) if (!faq.some((x) => x.question === item.question)) faq.push({ ...item, page });
    }
    const contacts: StoreContacts = {};
    for (const doc of [aboutDoc, home, faqDoc]) if (doc) for (const [k, v] of Object.entries(parseContacts(doc))) (contacts as Record<string, string>)[k] ??= v;

    // Cupons: a INK mostra no produto os cupons que valem para ele. Alguns produtos da vitrine bastam.
    const coupons: SiteCoupon[] = [];
    const products = home ? parseProductCards(home, base) : [];
    const seen = new Set<string>();
    for (const p of products.filter((x) => isStorePath(x.path) && !seen.has(x.title) && (seen.add(x.title), true)).slice(0, 3)) {
      const pdp = await get(`Produto: ${p.title}`, p.path);
      const frame = pdp?.querySelector('#product_promotions_frame');
      if (!frame) continue;
      let found = parseProductPromotions(frame);
      const src = frame.getAttribute('src');
      if (!found.length && src) {
        const path = new URL(src, 'https://loja.invalid').pathname + new URL(src, 'https://loja.invalid').search;
        const doc = isStorePath(path) ? await get(`Cupons de ${p.title}`, path) : null;
        found = doc ? parseProductPromotions(doc) : [];
      }
      for (const c of found) if (!coupons.some((x) => x.code.toUpperCase() === c.code.toUpperCase())) coupons.push({ ...c, seenOn: p.title });
    }
    const reviewsDoc = await get('Avaliações', `${base}/reviews?sort=rate`);
    const progressive = coupons.flatMap((c) => {
      const p = progressiveTiers(c);
      return p ? [{ code: c.code, ...p }] : [];
    });

    const data: SiteData = {
      faq,
      about: aboutDoc ? parseAbout(aboutDoc) : null,
      contacts,
      sections: home ? parseStoreSections(home, base) : [],
      coupons,
      progressive,
      theme: home ? parseTheme(home) : null,
      reviews: reviewsDoc ? parseReviews(reviewsDoc).reviews.length : 0,
      pages,
    };
    const now = new Date().toISOString();
    if (!pages.some((p) => p.ok)) {
      const msg = `Não foi possível ler a loja agora (${pages[0]?.detail ?? 'sem resposta'}). O último retrato foi mantido.`;
      this.db
        .prepare('INSERT INTO store_sync (store_id, error, error_at) VALUES (?, ?, ?) ON CONFLICT(store_id) DO UPDATE SET error = excluded.error, error_at = excluded.error_at')
        .run(store.id, msg, now);
    } else {
      this.db
        .prepare('INSERT INTO store_sync (store_id, data, fetched_at, error, error_at) VALUES (?, ?, ?, NULL, NULL) ON CONFLICT(store_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at, error = NULL, error_at = NULL')
        .run(store.id, JSON.stringify(data), now);
    }
    return this.status(store.id);
  }

  // ---------------------------------------------------------------- API da INK

  setToken(store: Store, raw: unknown, userId: number | null): IntegrationStatus {
    const token = typeof raw === 'string' ? raw.trim() : '';
    if (token.length < 20 || token.length > 4096 || /\s/.test(token)) throw new ServiceError(422, 'invalid_token', 'Cole o token da API da INK inteiro, sem espaços.');
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(token, 'utf8'), c.final()]);
    const value = [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
    this.db
      .prepare(
        'INSERT INTO ink_api (store_id, token_enc, token_hint, set_at, set_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(store_id) DO UPDATE SET token_enc = excluded.token_enc, token_hint = excluded.token_hint, set_at = excluded.set_at, set_by = excluded.set_by, tested_at = NULL, test_ok = NULL, test_message = NULL',
      )
      .run(store.id, value, token.slice(-4), new Date().toISOString(), userId);
    return this.status(store.id);
  }

  clearToken(store: Store): IntegrationStatus {
    this.db.prepare('DELETE FROM ink_api WHERE store_id = ?').run(store.id);
    return this.status(store.id);
  }

  private token(storeId: string): string | null {
    const row = this.db.prepare('SELECT token_enc FROM ink_api WHERE store_id = ?').get(storeId) as { token_enc: string } | undefined;
    if (!row) return null;
    try {
      const [iv, tag, enc] = row.token_enc.split('.').map((x) => Buffer.from(x, 'base64'));
      const d = createDecipheriv('aes-256-gcm', this.key, iv!);
      d.setAuthTag(tag!);
      return Buffer.concat([d.update(enc!), d.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  /** Uma leitura leve (1 produto) para conferir token, escopo e se a loja é esta. Nunca escreve na INK. */
  async testApi(store: Store): Promise<IntegrationStatus> {
    const token = this.token(store.id);
    if (!token) throw new ServiceError(409, 'no_token', 'Nenhum token guardado para esta loja.');
    const slug = store.basePath.replace(/^\//, '');
    let ok = false;
    let msg: string;
    try {
      const res = await this.fetchImpl(`${INK_API_BASE}/v1/stores/products?per_page=1&page=1`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
        redirect: 'error',
      });
      if (res.status === 401) msg = 'A INK recusou o token (401): confira se foi colado inteiro e se não expirou.';
      else if (res.status === 403) msg = 'O token não tem permissão de leitura de produtos.';
      else if (res.status === 429) msg = 'A INK pediu para esperar (limite de chamadas). Tente de novo em 1 minuto.';
      else if (!res.ok) msg = `A INK respondeu ${res.status}. Tente de novo mais tarde.`;
      else {
        const body = (await res.json()) as { products?: { store?: { slug?: string; name?: string } | null }[]; total_count?: number };
        const loja = body.products?.[0]?.store;
        if (loja?.slug && slug && loja.slug !== slug) msg = `O token é da loja "${loja.name ?? loja.slug}" (${loja.slug}), não desta (${slug}).`;
        else {
          ok = true;
          msg = `Conectado${loja?.name ? ` à loja ${loja.name}` : ''}: ${body.total_count ?? 0} produtos na API.`;
        }
      }
    } catch {
      msg = 'Não foi possível falar com a API da INK (sem resposta em 12 s).';
    }
    this.db.prepare('UPDATE ink_api SET tested_at = ?, test_ok = ?, test_message = ? WHERE store_id = ?').run(new Date().toISOString(), ok ? 1 : 0, msg, store.id);
    return ok ? this.syncApi(store) : this.status(store.id);
  }

  /**
   * Lê da API as promoções, as categorias e os produtos publicados (só GET, paginado).
   * Respeita o limite de 100 chamadas por minuto da loja: no máximo ~18 chamadas por leitura.
   * Um recurso sem permissão não impede os outros; o problema fica registrado.
   */
  async syncApi(store: Store): Promise<IntegrationStatus> {
    const token = this.token(store.id);
    if (!token) throw new ServiceError(409, 'no_token', 'Nenhum token guardado para esta loja.');
    const base = store.basePath;
    const problems: ApiData['problems'] = [];
    const pages = async <T>(resource: string, scope: string, path: string, key: string, max: number): Promise<T[] | null> => {
      const out: T[] = [];
      for (let page = 1; page <= max; page++) {
        const sep = path.includes('?') ? '&' : '?';
        let res: Response;
        try {
          res = await this.fetchImpl(`${INK_API_BASE}${path}${sep}per_page=100&page=${page}`, {
            headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
            signal: AbortSignal.timeout(15_000),
            redirect: 'error',
          });
        } catch {
          problems.push({ resource, message: 'sem resposta da API da INK.' });
          return null;
        }
        if (!res.ok) {
          problems.push({
            resource,
            message:
              res.status === 401 ? 'a INK recusou o token (401).'
              : res.status === 403 ? `o token não tem o escopo ${scope} (ou o plano não inclui a API).`
              : res.status === 429 ? 'limite de chamadas da INK; tente de novo em 1 minuto.'
              : `a INK respondeu ${res.status}.`,
          });
          return null;
        }
        const body = (await res.json()) as Record<string, unknown>;
        const items = Array.isArray(body[key]) ? (body[key] as T[]) : [];
        out.push(...items);
        if (page >= Number(body.total_pages ?? 1) || !items.length) break;
      }
      return out;
    };
    const rawPromos = await pages<unknown>('Promoções', 'store.promotions.read', '/v1/stores/promotions', 'promotions', 5);
    const rawCols = await pages<Record<string, unknown>>('Categorias', 'store.categories.read', '/v1/stores/collections?is_available=true', 'collections', 3);
    const rawProds = await pages<Record<string, unknown>>('Produtos', 'store.products.read', '/v1/stores/products?visible_in_store=true', 'products', 10);

    const prev = this.apiData(store.id);
    const data: ApiData = {
      promotions: rawPromos ? rawPromos.map(normalizePromotion).filter((p): p is InkPromotion => !!p) : (prev?.promotions ?? []),
      collections: rawCols ? rawCols.map((c) => toCollection(c, base)).filter((c): c is ApiCollection => !!c).sort((a, b) => a.position - b.position) : (prev?.collections ?? []),
      products: rawProds ? rawProds.map((p) => toProduct(p, base)).filter((p): p is ApiProduct => !!p) : (prev?.products ?? []),
      problems,
    };
    this.db.prepare('UPDATE ink_api SET api_data = ?, api_at = ? WHERE store_id = ?').run(JSON.stringify(data), new Date().toISOString(), store.id);
    return this.status(store.id);
  }
}

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const money = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

function toCollection(c: Record<string, unknown>, base: string): ApiCollection | null {
  const slug = str(c.slug, 120);
  if (!/^[a-z0-9-]+$/.test(slug) || c.is_available === false) return null;
  return {
    id: Number(c.id) || 0,
    name: str(c.name, 80),
    slug,
    path: `${base}/collections/${slug}`,
    description: str(c.description, 300),
    position: Number(c.position) || 0,
    products: Array.isArray(c.product_ids) ? c.product_ids.length : 0,
  };
}

/** Só produtos publicados e visíveis, com endereço dentro da própria loja. */
function toProduct(p: Record<string, unknown>, base: string): ApiProduct | null {
  if (p.visible_in_store === false || (p.status && p.status !== 'published')) return null;
  let path = '';
  try {
    path = new URL(String(p.store_product_url ?? '')).pathname;
  } catch {
    path = '';
  }
  if (!path && typeof p.slug === 'string') path = `${base}/product/${p.slug}`;
  if (!isStorePath(path) || (base && !path.startsWith(`${base}/`))) return null;
  const variants = (Array.isArray(p.product_variants) ? p.product_variants : []) as Record<string, unknown>[];
  const live = variants.filter((v) => v.is_available !== false);
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].slice(0, 20);
  const promo = money(p.promotional_price);
  const price = money(p.price);
  return {
    id: Number(p.id) || 0,
    name: str(p.name, 120),
    path,
    image: inkImage(str(p.main_image_url, 400)),
    price,
    promotionalPrice: promo !== null && price !== null && promo > 0 && promo < price ? promo : null,
    tags: (Array.isArray(p.tags) ? p.tags : []).map((t) => str(t, 40)).filter(Boolean).slice(0, 20),
    type: str((p.product_type as Record<string, unknown> | null)?.name, 60),
    sizes: uniq(live.map((v) => str(v.size, 10))),
    colors: uniq(live.map((v) => str(v.color, 30))),
    sales: Number(p.total_sales_count) || 0,
    cluster: Number(p.product_cluster_id) || null,
  };
}

function summarize(d: ApiData, at: string): ApiSummary {
  const clusters = new Map<number, number>();
  for (const p of d.products) if (p.cluster) clusters.set(p.cluster, (clusters.get(p.cluster) ?? 0) + 1);
  return {
    at,
    promotions: d.promotions,
    collections: d.collections,
    products: {
      total: d.products.length,
      bestSellers: [...d.products].sort((a, b) => b.sales - a.sales).slice(0, 8).map((p) => ({ name: p.name, path: p.path, sales: p.sales })),
      withTags: d.products.filter((p) => p.tags.length).length,
      clusters: [...clusters.values()].filter((n) => n > 1).length,
    },
    problems: d.problems,
  };
}
