// Assistente da loja (M10): básico e previsível, sem IA.
//  - Dúvidas de atendimento: respostas da base cadastrada pela loja e, se ligado, as que a
//    própria loja publicou na INK (FAQ, trocas, sobre, redes), lidas pela integração.
//  - Procura por estampa/tema/peça: produtos do catálogo da própria loja
//    (busca nativa da INK) e as coleções cujo nome casa com a pergunta.
//  - Pedido/rastreio: encaminha ao canal nativo da INK.
//  - Sem resposta: encaminha ao atendimento da loja.
// Nunca pede CPF ou pagamento, nunca altera pedidos, não inventa prazos.
import { formatBrl, type CardProduct } from '../shared/ink-parse.ts';
import type { CatalogReader } from './catalog.ts';
import type { Store, StoreService } from './stores.ts';
import type { Db } from './db.ts';
import type { ApiProduct, IntegrationService, SiteData } from './integration.ts';
import { verifyPreviewToken } from './tokens.ts';

export interface AssistantReply {
  status: number;
  body: Record<string, unknown>;
}

interface Knowledge {
  topic: string;
  question: string;
  answer: string;
  keywords: string;
}

const STOP = new Set(
  'a o os as de da do das dos e é em um uma uns umas para pra por com sem que qual quais quanto quantos como onde quando se no na nos nas ao aos à às eu voce você vocês me te meu minha seu sua tem ter tenho isso esse essa este esta ou mais menos muito pouco já ainda oi olá ola boa bom dia tarde noite obrigado obrigada por favor'.split(
    ' ',
  ),
);
/** Palavras de pedido de busca: saem dos termos enviados ao catálogo. */
const SEARCH_FILLERS = new Set(
  'presente presentes tem vende vendem procuro procurando quero queria gostaria busco buscando estampa estampas estampada desenho desenhos tema temas modelo modelos peca pecas roupa roupas alguma algum algo ai loja vcs voces existe existem colecao colecoes linha'.split(' '),
);
/** Tipos de peça: não definem o tema ("camiseta de pai" → tema "pai"). */
const GARMENTS = new Set('camiseta camisetas moletom moletons body bodies cropped regata regatas blusa blusas oversized babylook infantil feminina feminino masculina masculino unissex'.split(' '));
const PRODUCT_INTENT = /\b(procur|quero|queria|gostaria|busc|tem|t[eê]m|vende|camis|moletom|body|cropped|presente|estamp|desenho|tema|cole[cç]|modelo|pe[cç]a|roupa|infantil|feminin|masculin|oversized)\w*/i;
const ORDER_INTENT = /\b(meu pedido|rastre|rastrei|onde est[aá] (meu|minha)|c[oó]digo de rastreio|status do pedido)/i;
const SENSITIVE = /\b(\d{3}\.?\d{3}\.?\d{3}-?\d{2}|cpf|cart[aã]o de cr[eé]dito|cvv|senha)\b/i;

export function fold(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function normalize(s: string): string[] {
  return fold(s)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length > 5 ? w.replace(/(oes|aes|s)$/, '') : w));
}

/** Pontua cada resposta da base pela sobreposição de termos (palavras-chave pesam mais). */
export function rankKnowledge(question: string, kb: Knowledge[]): { item: Knowledge; score: number }[] {
  const q = new Set(normalize(question));
  if (!q.size) return [];
  return kb
    .map((item) => {
      const kw = new Set(normalize(item.keywords.replace(/,/g, ' ')));
      const qq = new Set(normalize(item.question));
      const aa = new Set(normalize(item.answer));
      let score = 0;
      for (const t of q) {
        if (kw.has(t)) score += 3;
        if (qq.has(t)) score += 2;
        if (aa.has(t)) score += 1;
        else if ([...kw, ...qq].some((w) => w.length > 3 && t.length > 3 && (w.startsWith(t.slice(0, 4)) || t.startsWith(w.slice(0, 4))))) score += 1;
      }
      return { item, score: score / Math.sqrt(q.size) };
    })
    .filter((r) => r.score >= 1.2)
    .sort((a, b) => b.score - a.score);
}

/** Termos da procura: tira palavras de pedido ("tem estampa de…") e mantém o tema. */
export function searchTerms(message: string): string[] {
  return fold(message)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w) && !SEARCH_FILLERS.has(w))
    .slice(0, 5);
}

/** "maes" → "mae", "pais" → "pai": casa singular e plural no nome das coleções. */
const singular = (w: string) => (w.length > 3 ? w.replace(/s$/, '') : w);
/** Jeitos comuns de chamar os temas de família/afeto usados nas lojas INK. */
const SYNONYMS: Record<string, string[]> = {
  mamae: ['mae'], mainha: ['mae'], papai: ['pai'], painho: ['pai'],
  filho: ['filhos', 'infantil'], filha: ['filhos', 'infantil'], crianca: ['infantil', 'filhos'], bebe: ['infantil'],
  cachorro: ['pets', 'pet'], cachorra: ['pets', 'pet'], gato: ['pets', 'pet'], gata: ['pets', 'pet'], cao: ['pets', 'pet'],
  namorado: ['casais', 'casal'], namorada: ['casais', 'casal'], marido: ['casais', 'casal'], esposa: ['casais', 'casal'], casal: ['casais'],
  religioso: ['fe'], religiosa: ['fe'], biblia: ['fe'], deus: ['fe'], jesus: ['fe'],
};

/** Coleções/listagens da loja cujo nome casa com a procura. */
export function matchSections(terms: string[], sections: { label: string; path: string }[]): { label: string; path: string }[] {
  if (!terms.length) return [];
  return sections
    .map((s) => {
      const words = fold(s.label).split(/[^a-z0-9]+/).filter(Boolean).map(singular);
      const hits = terms.filter((term) =>
        [term, ...(SYNONYMS[term] ?? [])].map(singular).some((t) => words.some((w) => w === t || (t.length > 3 && w.length > 3 && (w.startsWith(t) || t.startsWith(w))))),
      );
      return { s, hits: hits.length };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 3)
    .map((x) => x.s);
}

const SESSION_TTL_MS = 6 * 3600_000;
const DAILY_STORE_LIMIT = Number(process.env.PINK_ASSISTANT_DAILY_LIMIT ?? 2000);

export class AssistantService {
  private sessions = new Map<string, { count: number; at: number }>();
  private stores: StoreService;
  private catalog: CatalogReader;
  private db: Db;
  private secret: Buffer;
  private integration: IntegrationService | null;

  constructor(deps: { stores: StoreService; catalog: CatalogReader; db: Db; secret: Buffer; integration?: IntegrationService }) {
    this.stores = deps.stores;
    this.catalog = deps.catalog;
    this.db = deps.db;
    this.secret = deps.secret;
    this.integration = deps.integration ?? null;
  }

  async answer(storeId: string, raw: unknown): Promise<AssistantReply> {
    const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const store = this.stores.get(storeId);
    if (!store) return { status: 404, body: { error: 'unknown_store' } };
    const preview = typeof body.previewToken === 'string' && verifyPreviewToken(this.secret, body.previewToken) === storeId;
    const settings = preview ? this.stores.draftModuleSettings(storeId, 'assistant') : this.stores.publishedModuleSettings(storeId, 'assistant');
    if (!settings) return { status: 404, body: { error: 'assistant_off', message: 'Assistente desligado nesta loja.' } };

    const sessionId = typeof body.sessionId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.sessionId) ? body.sessionId : null;
    const message = typeof body.message === 'string' ? body.message.replace(/[<>\u0000-\u001F]/g, ' ').trim().slice(0, 400) : '';
    if (!sessionId || !message) return { status: 400, body: { error: 'bad_request', message: 'Escreva sua pergunta.' } };

    // Limite por visita (no servidor) e teto diário por loja.
    const now = Date.now();
    for (const [k, v] of this.sessions) if (now - v.at > SESSION_TTL_MS) this.sessions.delete(k);
    const key = `${storeId}:${sessionId}`;
    const sess = this.sessions.get(key) ?? { count: 0, at: now };
    const max = Number(settings.maxMessages ?? 15);
    const useSite = settings.storeData !== false && !!this.integration;
    if (useSite) this.integration!.refreshIfStale(store);
    const site = useSite ? this.integration!.siteData(store.id) : null;
    const contact = this.contact(store.integration.supportWhatsapp || site?.contacts.whatsapp || '', String(settings.whatsapp ?? ''), String(settings.contactLabel ?? 'Falar com a loja'));
    if (sess.count >= max) {
      return { status: 429, body: { error: 'limit', answer: 'Chegamos ao limite de perguntas desta visita. Para continuar, fale com a loja.', contact, remaining: 0 } };
    }
    const day = new Date(now).toISOString().slice(0, 10);
    const used = (this.db.prepare('SELECT messages FROM chat_usage WHERE store_id = ? AND day = ?').get(storeId, day) as { messages: number } | undefined)?.messages ?? 0;
    if (used >= DAILY_STORE_LIMIT) {
      return { status: 429, body: { error: 'store_limit', answer: 'O assistente está indisponível agora. Fale com a loja.', contact, remaining: 0 } };
    }
    sess.count += 1;
    sess.at = now;
    this.sessions.set(key, sess);
    this.db
      .prepare('INSERT INTO chat_usage (store_id, day, messages) VALUES (?, ?, 1) ON CONFLICT(store_id, day) DO UPDATE SET messages = messages + 1')
      .run(storeId, day);
    const remaining = max - sess.count;
    const askTeam = contact ? ' A equipe da loja pode ajudar:' : '';
    const reply = (b: Record<string, unknown>): AssistantReply => ({ status: 200, body: { products: [], collections: [], sources: [], contact, remaining, ...b } });

    if (SENSITIVE.test(message)) {
      return reply({ answer: 'Por segurança, não compartilhe CPF, senhas ou dados de cartão aqui. Para assuntos do seu pedido, fale com a loja.' });
    }
    if (ORDER_INTENT.test(message)) {
      return reply({ answer: 'Você acompanha o pedido pela página de rastreio da loja, com o número do pedido e o e-mail da compra.', link: { label: 'Rastrear pedido', path: `${store.basePath}/orders/trackings` } });
    }

    // O que a loja cadastrou no painel vem primeiro: no empate, prevalece sobre o lido da INK.
    const kb = [...((Array.isArray(settings.knowledge) ? settings.knowledge : []) as Knowledge[]), ...siteKnowledge(site)];
    const ranked = rankKnowledge(message, kb).slice(0, 3);
    const strongAnswer = ranked.length > 0 && ranked[0]!.score >= 3;

    // Procura por estampa, tema ou peça: catálogo da loja + coleções com o mesmo nome.
    if (settings.productDiscovery === true && !strongAnswer) {
      // Só procura quando a pessoa pede peça/estampa, ou cita o nome de uma coleção ("e de mães?").
      const terms = searchTerms(message);
      const sections = terms.length ? await this.catalog.sections(store).catch(() => []) : [];
      const themes = terms.filter((t) => !GARMENTS.has(t));
      if (terms.length && (PRODUCT_INTENT.test(message) || matchSections(themes, sections).length)) {
        const found = await this.discover(store, terms, themes.length ? themes : terms, sections);
        if (found.products.length || found.collections.length) {
          return reply({
            answer: found.products.length ? 'Encontrei estas peças na loja:' : 'Veja estas coleções da loja:',
            products: found.products.map(toPublicProduct),
            collections: found.collections,
            link: found.searchPath ? { label: 'Ver todos os resultados', path: found.searchPath } : undefined,
            related: ranked.slice(0, 1).map((r) => r.item.question),
          });
        }
        if (!ranked.length) {
          // Palavras como a pessoa escreveu (com acento), só as do tema.
          const said = message.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}-]/gu, '')).filter((w) => themes.includes(fold(w)));
          return reply({ answer: `Não encontrei peças${said.length ? ` com "${said.join(' ')}"` : ''} na loja.${askTeam}`, handoff: true });
        }
      }
    }

    if (ranked.length) {
      return reply({ answer: ranked[0]!.item.answer, sources: [ranked[0]!.item.question], related: ranked.slice(1).map((r) => r.item.question) });
    }
    return reply({ answer: `Não tenho essa informação aqui.${askTeam}`, handoff: true });
  }

  /**
   * Tema com coleção própria ("mãe" → coleção Mães): produtos da coleção, que é curada pela loja.
   * Sem coleção: busca nativa da INK com os termos e, se nada vier, termo a termo.
   */
  private async discover(store: Store, terms: string[], themes: string[], sections: { label: string; path: string }[]) {
    const collections = matchSections(themes, sections);
    let products: CardProduct[] = [];
    let searchPath: string | null = null;
    try {
      if (collections.length) products = await this.catalog.products(store, collections[0]!.path);
      // Com a API da INK: índice de produtos publicados (nome, tags e tipo), mais vendidos primeiro.
      const indexed = !products.length ? this.integration?.apiData(store.id)?.products : undefined;
      if (indexed?.length) {
        products = searchIndex(indexed, terms, themes);
        if (products.length) searchPath = `${store.integration.searchPath || `${store.basePath}/products`}?search_filter=${encodeURIComponent(themes[0] ?? terms[0]!)}`;
      }
      if (!products.length) {
        const searchBase = store.integration.searchPath || `${store.basePath}/products`;
        let used = terms.join(' ');
        products = await this.catalog.search(store, used);
        // A busca da INK casa trechos do nome: "abelha" não acha "Abelhinhas", "abelh" acha.
        const attempts = [...terms].sort((a, b) => b.length - a.length).flatMap((t) => (t.length >= 5 ? [t, t.slice(0, -1)] : [t]));
        for (const t of attempts) {
          if (products.length) break;
          used = t;
          products = await this.catalog.search(store, t);
        }
        if (products.length) searchPath = `${searchBase}?search_filter=${encodeURIComponent(used)}`;
      }
    } catch {
      products = [];
    }
    // A INK lista cada cor como um produto com o mesmo nome: mostra nomes diferentes.
    const seen = new Set<string>();
    const unique = products.filter((p) => !seen.has(p.title) && (seen.add(p.title), true));
    return { products: unique.slice(0, 4), collections, searchPath };
  }

  private contact(storeWhats: string, moduleWhats: string, label: string) {
    const phone = moduleWhats || storeWhats;
    return phone ? { label, url: `https://wa.me/${phone}` } : null;
  }
}

/**
 * Procura no índice da API: tema nas tags pesa mais que no nome; tipo de peça só desempata.
 * Exige que todo tema apareça (nome, tags ou tipo); empate vai para o mais vendido.
 */
export function searchIndex(products: ApiProduct[], terms: string[], themes: string[]): CardProduct[] {
  const want = themes.length ? themes : terms;
  const garments = terms.filter((t) => GARMENTS.has(t));
  const hit = (words: string[], t: string) => {
    const tt = singular(t);
    return words.some((w) => w === tt || (tt.length >= 4 && w.length >= 4 && (w.startsWith(tt) || tt.startsWith(w))));
  };
  const wordsOf = (s: string) => fold(s).split(/[^a-z0-9]+/).filter(Boolean).map(singular);
  return products
    .map((p) => {
      const name = wordsOf(p.name);
      const tags = p.tags.flatMap(wordsOf);
      const type = wordsOf(p.type);
      let score = 0;
      for (const t of want) {
        const s1 = (hit(tags, t) ? 3 : 0) + (hit(name, t) ? 2 : 0);
        if (!s1) return { p, score: 0 };
        score += s1;
      }
      for (const g of garments) if (hit(type, g) || hit(name, g)) score += 1;
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.p.sales - a.p.sales)
    .map(({ p }) => ({
      id: String(p.id),
      title: p.name,
      path: p.path,
      priceText: p.price === null ? '' : formatBrl(Math.round((p.promotionalPrice ?? p.price) * 100)),
      imageUrl: p.image,
    }));
}

/** Respostas montadas com o que a loja publicou nas páginas da INK. */
export function siteKnowledge(site: SiteData | null): Knowledge[] {
  if (!site) return [];
  const out: Knowledge[] = site.faq.map((f) => ({ topic: f.page === 'trocas' ? 'trocas' : 'loja', question: f.question, answer: f.answer, keywords: f.page === 'trocas' ? 'troca, trocar, devolução, devolver' : '' }));
  if (site.about?.text) out.push({ topic: 'loja', question: `Sobre a ${site.about.name || 'loja'}`, answer: site.about.text, keywords: 'sobre, quem, história, marca, loja' });
  const c = site.contacts;
  const social = [c.instagram && `Instagram: @${c.instagram}`, c.tiktok && `TikTok: ${c.tiktok}`, c.facebook && `Facebook: ${c.facebook}`].filter(Boolean);
  if (social.length) out.push({ topic: 'atendimento', question: 'Redes sociais da loja', answer: `${social.join(' · ')}.`, keywords: 'instagram, insta, redes, sociais, tiktok, facebook, perfil' });
  if (c.email) out.push({ topic: 'atendimento', question: 'E-mail da loja', answer: `O e-mail da loja é ${c.email}.`, keywords: 'email, e-mail, contato, falar' });
  return out;
}

function toPublicProduct(p: CardProduct) {
  return { title: p.title, path: p.path, priceText: p.priceText, imageUrl: p.imageUrl };
}
