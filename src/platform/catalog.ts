// Leitura do catálogo público da loja no servidor (só GET), para o painel
// sugerir coleções, produtos e avaliações sem o lojista digitar caminhos.
// Cache curto por loja; nenhuma credencial; respeita o limite da INK.
import { JSDOM, VirtualConsole } from 'jsdom';
import { parseMostSolds, parseProductCards, parseReviews, parseStoreSections, type CardProduct, type Review, type ReviewPhoto } from '../shared/ink-parse.ts';
import { isStorePath } from '../shared/fields.ts';
import type { Store } from './stores.ts';

const TTL_MS = 10 * 60_000;
const UA = 'Mozilla/5.0 (personalizacoes-ink painel; leitura do catálogo público)';

export class CatalogReader {
  private cache = new Map<string, { at: number; value: unknown }>();
  private fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  private async page(store: Store, path: string): Promise<Document> {
    if (!isStorePath(path)) throw new Error('caminho inválido');
    const url = new URL(path, store.devOrigin);
    const res = await this.fetchImpl(url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`a loja respondeu ${res.status}`);
    const html = await res.text();
    // Sem executar scripts nem carregar recursos.
    return new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document;
  }

  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
    const value = await fn();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** Uma página da loja sem cache (leitura de integração). */
  document(store: Store, path: string): Promise<Document> {
    return this.page(store, path);
  }

  sections(store: Store): Promise<{ label: string; path: string }[]> {
    return this.cached(`${store.id}:sections`, async () => parseStoreSections(await this.page(store, store.basePath || '/'), store.basePath));
  }

  products(store: Store, path: string): Promise<CardProduct[]> {
    return this.cached(`${store.id}:products:${path}`, async () => {
      const doc = await this.page(store, path);
      return parseProductCards(doc, store.basePath);
    });
  }

  mostSold(store: Store): Promise<CardProduct[]> {
    return this.cached(`${store.id}:mostsold`, async () => parseMostSolds(await this.page(store, `${store.basePath}/cart/most_solds?empty_cart=true`), store.basePath));
  }

  reviews(store: Store): Promise<{ reviews: Review[]; photos: ReviewPhoto[] }> {
    return this.cached(`${store.id}:reviews`, async () => parseReviews(await this.page(store, `${store.basePath}/reviews?sort=rate`)));
  }

  search(store: Store, term: string): Promise<CardProduct[]> {
    const q = term.trim().slice(0, 60);
    const searchPath = store.integration.searchPath || `${store.basePath}/products`;
    return this.cached(`${store.id}:search:${q.toLowerCase()}`, async () => parseProductCards(await this.page(store, `${searchPath}?search_filter=${encodeURIComponent(q)}`), store.basePath));
  }
}
