// Configuração inicial guiada: o que a leitura da loja e a API trouxeram, o que cada
// recurso precisa para ir ao ar e o passo em que a pessoa parou. Tudo vai para o
// RASCUNHO (publicar continua sendo um passo explícito). Cada importação aplicada guarda
// um resumo do valor: se depois o lojista mexer, uma nova leitura não sobrescreve
// em silêncio ("editado por você").
import { createHash } from 'node:crypto';
import type { Db } from './db.ts';
import type { IntegrationService } from './integration.ts';
import { ServiceError, type StoreService, type StoreView } from './stores.ts';
import { defaultConfig, moduleDef, moduleDefs, parseStoreConfig, type StoreConfig } from '../shared/registry.ts';
import { withDefaults, contrastRatio, type Values } from '../shared/fields.ts';
import { DEFAULT_IDENTITY, validateIdentity, type Identity } from '../shared/identity.ts';
import { incentiveBlocker, promotionToCampaign, promotionToIncentive, tierLines, SCOPE_TEXT } from '../shared/ink-promotions.ts';

export interface ImportOffer {
  key: string;
  /** Recurso que recebe o conteúdo (null = identidade). */
  module: string | null;
  title: string;
  origin: string;
  detail: string;
  /** novo: ainda não aplicado · aplicado: igual ao importado · editado: mexido depois · existente: o rascunho já tem algo ali */
  state: 'novo' | 'aplicado' | 'editado' | 'existente';
  /** Pede confirmação explícita antes de aplicar (ex.: alcance que a página não informa). */
  confirm?: string;
}

export interface FeatureState {
  id: string;
  name: string;
  entitled: boolean;
  enabledInDraft: boolean;
  liveNow: boolean;
  ready: boolean;
  /** O que falta, em linguagem simples (vazio se pronto). */
  missing: string;
}

export interface Preset {
  id: 'navegacao' | 'ofertas' | 'conteudo';
  title: string;
  result: string;
  modules: FeatureState[];
}

export const PRESETS: { id: Preset['id']; title: string; result: string; modules: string[] }[] = [
  {
    id: 'navegacao',
    title: 'Navegação e descoberta',
    result: 'Cabeçalho com busca que sugere peças enquanto a pessoa digita, categorias em abas na home, galeria com miniaturas, compartilhar no WhatsApp e aviso de cookies com a cara da loja.',
    modules: ['header', 'categoryTabs', 'gallery', 'share', 'cookieNotice'],
  },
  {
    id: 'ofertas',
    title: 'Ofertas e carrinho',
    result: 'Cupons à vista com o código para copiar, a meta de "leve mais e ganhe" no carrinho e o prazo de entrega por CEP na página do produto.',
    modules: ['coupons', 'cartIncentive', 'delivery'],
  },
  {
    id: 'conteudo',
    title: 'Conteúdo e atendimento',
    result: 'Assistente que responde com o que a loja já publicou e acha estampas, avaliações com fotos, vídeos com os produtos e guia de medidas.',
    modules: ['assistant', 'reviews', 'videoCards', 'miniPlayer', 'sizeGuide'],
  },
];

/** O que falta, dito para o lojista (em vez da mensagem do campo). */
const FRIENDLY_MISSING: Record<string, string> = {
  coupons: 'Nenhum cupom ainda: cadastre as campanhas que já existem na INK (mesmo código) ou mostre os cupons da INK em cada produto.',
  cartIncentive: 'Falta a promoção da INK: cadastre o nome e as faixas (ou traga pela API) para mostrar quanto falta no carrinho.',
  sizeGuide: 'Falta a tabela de medidas da sua modelagem.',
  categoryTabs: 'Escolha as categorias das abas.',
  assistant: 'Faltam respostas: leia a loja (FAQ) ou cadastre as respostas da loja.',
  videoCards: 'Envie pelo menos um vídeo em Vídeos.',
  miniPlayer: 'Envie pelo menos um vídeo em Vídeos.',
};

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('base64url').slice(0, 22);
const isLight = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const l = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return l > 0.72;
};

interface Change {
  offer: Omit<ImportOffer, 'state'>;
  /** Valor importado que fica registrado (para detectar edição depois). */
  value: unknown;
  /** Valor atual no rascunho, comparável com value. */
  current(c: StoreConfig): unknown;
  apply(c: StoreConfig): void;
}

export class SetupService {
  private db: Db;
  private stores: StoreService;
  private integration: IntegrationService;
  constructor(deps: { db: Db; stores: StoreService; integration: IntegrationService }) {
    this.db = deps.db;
    this.stores = deps.stores;
    this.integration = deps.integration;
  }

  progress(id: string): { step: number; completedAt: string | null } {
    const r = this.db.prepare('SELECT step, completed_at FROM store_setup WHERE store_id = ?').get(id) as { step: number; completed_at: string | null } | undefined;
    return { step: r?.step ?? 1, completedAt: r?.completed_at ?? null };
  }

  setStep(id: string, step: unknown): { step: number; completedAt: string | null } {
    const n = Number(step);
    if (!Number.isInteger(n) || n < 1 || n > 4) throw new ServiceError(400, 'bad_request', 'Passo inválido.');
    this.db.prepare('INSERT INTO store_setup (store_id, step, updated_at) VALUES (?, ?, ?) ON CONFLICT(store_id) DO UPDATE SET step = excluded.step, updated_at = excluded.updated_at').run(id, n, new Date().toISOString());
    return this.progress(id);
  }

  complete(id: string): { step: number; completedAt: string | null } {
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO store_setup (store_id, step, completed_at, updated_at) VALUES (?, 4, ?, ?) ON CONFLICT(store_id) DO UPDATE SET completed_at = COALESCE(store_setup.completed_at, excluded.completed_at), updated_at = excluded.updated_at').run(id, now, now);
    return this.progress(id);
  }

  /** Identidade sugerida a partir do que a loja já usa. Só entra o que for confiável. */
  identitySuggestion(id: string, current: Identity): Identity | null {
    const t = this.integration.siteData(id)?.theme;
    if (!t || (!t.primary && !t.logoUrl)) return null;
    const next: Identity = { ...current };
    if (t.logoUrl) next.logoUrl = t.logoUrl;
    if (t.primary) next.primary = t.primary;
    // A cor do texto sobre a marca costuma ser o fundo claro da loja (ex.: creme sobre vinho).
    if (t.onPrimary && isLight(t.onPrimary)) next.surface = t.onPrimary;
    if (contrastRatio(next.text, next.surface) < 4.5) next.text = DEFAULT_IDENTITY.text;
    if (contrastRatio(next.primary, next.surface) < 3) next.surface = DEFAULT_IDENTITY.surface;
    return validateIdentity(next).errors.length ? null : next;
  }

  private changes(id: string, draft: StoreConfig): Change[] {
    const site = this.integration.siteData(id);
    const api = this.integration.apiData(id);
    const out: Change[] = [];
    const settings = (c: StoreConfig, mid: string) => withDefaults(moduleDef(mid)!.fields, moduleDef(mid)!.defaults, c.modules[mid]?.settings);
    const setSettings = (c: StoreConfig, mid: string, patch: Values) => {
      c.modules[mid] = { enabled: c.modules[mid]?.enabled ?? false, settings: { ...settings(c, mid), ...patch } };
    };

    // Identidade
    const suggestion = this.identitySuggestion(id, draft.identity);
    if (suggestion) {
      const pick = (i: Identity) => ({ logoUrl: i.logoUrl, primary: i.primary, surface: i.surface, text: i.text });
      out.push({
        offer: { key: 'identidade', module: null, title: 'Logo e cores da loja', origin: 'Página inicial da loja', detail: `Cor principal ${suggestion.primary}, fundo ${suggestion.surface}${suggestion.logoUrl ? ', logo do cabeçalho' : ''}.` },
        value: pick(suggestion),
        current: (c) => pick(c.identity),
        apply: (c) => (c.identity = { ...c.identity, ...pick(suggestion) }),
      });
    }

    // Categorias em abas: categorias da API (ordem do menu) ou coleções do menu da página.
    const cols = api?.collections.filter((c) => c.products > 0).map((c) => ({ label: c.name.slice(0, 30), path: c.path })) ?? [];
    const tabs = (cols.length ? cols : (site?.sections ?? []).filter((s) => /\/collections\//.test(s.path)).map((s) => ({ label: s.label.slice(0, 30), path: s.path }))).slice(0, 6);
    if (tabs.length >= 2) {
      out.push({
        offer: { key: 'categorias', module: 'categoryTabs', title: `Categorias em abas: ${tabs.length} categorias`, origin: cols.length ? 'API da INK (ordem do menu)' : 'Menu da loja', detail: tabs.map((t) => t.label).join(', ') },
        value: tabs,
        current: (c) => settings(c, 'categoryTabs').tabs,
        apply: (c) => setSettings(c, 'categoryTabs', { tabs }),
      });
    }

    // Cupons vistos nos produtos: valem por produto, então o M05 os lê em cada produto.
    if (site?.coupons.length) {
      out.push({
        offer: { key: 'cupons-produto', module: 'coupons', title: `Cupons da INK em cada produto (${site.coupons.length})`, origin: 'Página dos produtos', detail: `${site.coupons.map((c) => c.code).join(', ')}. Cada cupom aparece só nos produtos em que a INK o oferece.` },
        value: true,
        current: (c) => settings(c, 'coupons').inkCoupons,
        apply: (c) => setSettings(c, 'coupons', { inkCoupons: true }),
      });
    }

    // Promoções da API: cupom (só as que pedem código) e metas do carrinho (só sem mudar o alcance).
    const colPath = (cid: number) => api?.collections.find((c) => c.id === cid)?.path ?? null;
    for (const p of api?.promotions.filter((x) => x.available) ?? []) {
      const camp = promotionToCampaign(p);
      if (camp) {
        out.push({
          offer: { key: `cupom:${p.code.toUpperCase()}`, module: 'coupons', title: `Cupom ${p.code}`, origin: 'API da INK', detail: `${tierLines(p).join(' · ')}${p.firstPurchase ? ' · só na primeira compra' : ''}. ${SCOPE_TEXT[p.scope]}` },
          value: camp,
          current: (c) => (settings(c, 'coupons').campaigns as Values[]).find((x) => String(x.code).toUpperCase() === p.code.toUpperCase()) ?? null,
          apply: (c) => {
            const list = (settings(c, 'coupons').campaigns as Values[]).filter((x) => String(x.code).toUpperCase() !== p.code.toUpperCase());
            setSettings(c, 'coupons', { campaigns: [...list, camp].slice(0, 8) });
          },
        });
      }
      const inc = promotionToIncentive(p, colPath);
      if (inc && (p.type === 'progressive' || p.type === 'unit_free')) {
        out.push({
          offer: { key: `metas:${p.code.toUpperCase()}`, module: 'cartIncentive', title: `Metas do carrinho: ${p.code}`, origin: 'API da INK', detail: `${tierLines(p).join(' · ')}.${inc.eligibility === 'colecao' ? ' Só itens da coleção da promoção.' : ''}` },
          value: inc,
          current: (c) => {
            const s = settings(c, 'cartIncentive');
            return { campaignName: s.campaignName, measure: s.measure, eligibility: s.eligibility, ...(s.eligibility === 'colecao' ? { eligiblePath: s.eligiblePath } : {}), tiers: s.tiers };
          },
          apply: (c) => setSettings(c, 'cartIncentive', inc),
        });
      } else if (p.type === 'progressive' && incentiveBlocker(p, colPath)) {
        // Fica de fora (alcance não cabe no M06) — o painel de integração explica o motivo.
      }
    }

    // Faixas progressivas vistas só na página: alcance desconhecido, exige confirmação.
    for (const p of api ? [] : (site?.progressive ?? [])) {
      const inc = { campaignName: p.code, measure: p.measure, eligibility: 'todos', tiers: p.tiers.map((t) => ({ threshold: t.threshold, benefit: t.benefit, amount: t.amount, label: t.label })) };
      out.push({
        offer: {
          key: `metas-pagina:${p.code.toUpperCase()}`,
          module: 'cartIncentive',
          title: `Metas do carrinho: ${p.code}`,
          origin: 'Página do produto',
          detail: p.tiers.map((t) => `${t.threshold} peças: ${t.label}`).join(' · '),
          confirm: `Confirmo que a promoção ${p.code} vale para a loja toda (a página do produto não informa o alcance).`,
        },
        value: inc,
        current: (c) => {
          const s = settings(c, 'cartIncentive');
          return { campaignName: s.campaignName, measure: s.measure, eligibility: s.eligibility, tiers: s.tiers };
        },
        apply: (c) => setSettings(c, 'cartIncentive', inc),
      });
    }

    // Assistente com o FAQ, trocas, sobre e redes da loja.
    if (site?.faq.length) {
      out.push({
        offer: { key: 'assistente', module: 'assistant', title: `Assistente com o que a loja publicou (${site.faq.length} perguntas)`, origin: 'Perguntas frequentes e trocas da loja', detail: 'Responde sozinho com o FAQ, trocas, sobre e redes; as respostas que você cadastrar prevalecem.' },
        value: true,
        current: (c) => settings(c, 'assistant').storeData,
        apply: (c) => setSettings(c, 'assistant', { storeData: true }),
      });
    }
    return out;
  }

  private recorded(id: string): Map<string, string> {
    const rows = this.db.prepare('SELECT key, hash FROM store_imports WHERE store_id = ?').all(id) as { key: string; hash: string }[];
    return new Map(rows.map((r) => [r.key, r.hash]));
  }

  offers(id: string): ImportOffer[] {
    const draft = this.stores.view(id).draft.config;
    const pristine = defaultConfig(draft.identity);
    const seen = this.recorded(id);
    return this.changes(id, draft).map((ch) => {
      const now = hash(ch.current(draft));
      const was = seen.get(ch.offer.key);
      const cur = ch.current(draft);
      // Vazio ou ainda no padrão do recurso: nada que o lojista tenha escrito.
      const empty = cur === null || cur === undefined || cur === false || (Array.isArray(cur) && !cur.length) || (typeof cur === 'string' && !cur) || now === hash(ch.current(pristine));
      const state: ImportOffer['state'] = was ? (now === was ? 'aplicado' : 'editado') : now === hash(ch.value) ? 'aplicado' : empty || ch.offer.key === 'identidade' ? 'novo' : 'existente';
      return { ...ch.offer, state };
    });
  }

  /**
   * Aplica importações escolhidas no rascunho. Itens "editado" ou "existente" só são
   * substituídos se vierem em `replace`; itens com confirmação exigem a chave em `confirmed`.
   */
  applyImports(id: string, raw: { keys?: unknown; replace?: unknown; confirmed?: unknown }, userId: number | null): { view: StoreView; report: { key: string; result: 'aplicado' | 'mantido' | 'sem confirmação' | 'indisponível' }[] } {
    const keys = Array.isArray(raw.keys) ? raw.keys.filter((k): k is string => typeof k === 'string') : [];
    const replace = new Set(Array.isArray(raw.replace) ? raw.replace : []);
    const confirmed = new Set(Array.isArray(raw.confirmed) ? raw.confirmed : []);
    const view = this.stores.view(id);
    const draft = structuredClone(view.draft.config);
    const states = new Map(this.offers(id).map((o) => [o.key, o.state]));
    const changes = new Map(this.changes(id, draft).map((c) => [c.offer.key, c]));
    const report: { key: string; result: 'aplicado' | 'mantido' | 'sem confirmação' | 'indisponível' }[] = [];
    const applied: { key: string; value: unknown; origin: string }[] = [];
    for (const key of keys) {
      const ch = changes.get(key);
      if (!ch) {
        report.push({ key, result: 'indisponível' });
        continue;
      }
      const st = states.get(key);
      if ((st === 'editado' || st === 'existente') && !replace.has(key)) {
        report.push({ key, result: 'mantido' });
        continue;
      }
      if (ch.offer.confirm && !confirmed.has(key)) {
        report.push({ key, result: 'sem confirmação' });
        continue;
      }
      ch.apply(draft);
      applied.push({ key, value: ch.current(draft), origin: ch.offer.origin });
      report.push({ key, result: 'aplicado' });
    }
    const next = applied.length ? this.stores.saveDraft(id, draft, view.draft.updatedAt, userId) : view;
    const now = new Date().toISOString();
    for (const a of applied) {
      this.db
        .prepare('INSERT INTO store_imports (store_id, key, hash, origin, applied_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(store_id, key) DO UPDATE SET hash = excluded.hash, origin = excluded.origin, applied_at = excluded.applied_at')
        .run(id, a.key, hash(a.value), a.origin, now);
    }
    return { view: next, report };
  }

  /** Situação de cada recurso: liberado, ligado no rascunho/na loja, pronto ou o que falta. */
  features(id: string): FeatureState[] {
    const view = this.stores.view(id);
    const site = this.integration.siteData(id);
    return moduleDefs().map((d) => {
      const entitled = view.entitled.includes(d.id);
      const probe = structuredClone(view.draft.config);
      probe.modules[d.id] = { ...probe.modules[d.id]!, enabled: true };
      const errs = parseStoreConfig(probe).errors.filter((e) => e.field.startsWith(`modules.${d.id}`));
      let missing = errs.length ? (FRIENDLY_MISSING[d.id] ?? errs[0]!.message) : '';
      if (!missing && d.id === 'reviews' && site && site.reviews === 0) missing = 'A loja ainda não tem avaliações publicadas.';
      if (!missing && (d.id === 'videoCards' || d.id === 'miniPlayer') && !view.draft.config.library.videos.length) missing = 'Envie pelo menos um vídeo em Vídeos.';
      return {
        id: d.id,
        name: d.name,
        entitled,
        enabledInDraft: !!view.draft.config.modules[d.id]?.enabled,
        liveNow: !!view.published?.config.modules[d.id]?.enabled,
        ready: entitled && !missing,
        missing: entitled ? missing : 'Não liberado para esta loja.',
      };
    });
  }

  presets(id: string): Preset[] {
    const all = new Map(this.features(id).map((f) => [f.id, f]));
    return PRESETS.map((p) => ({ id: p.id, title: p.title, result: p.result, modules: p.modules.map((m) => all.get(m)!).filter((f) => f && f.entitled) }));
  }

  /** Liga no rascunho os recursos escolhidos que estão prontos; os pendentes ficam desligados (sem seção vazia). */
  setFeatures(id: string, raw: { enable?: unknown }, userId: number | null): { view: StoreView; skipped: { id: string; missing: string }[] } {
    const want = new Set(Array.isArray(raw.enable) ? raw.enable.filter((x): x is string => typeof x === 'string') : []);
    const feats = this.features(id);
    const view = this.stores.view(id);
    const draft = structuredClone(view.draft.config);
    const skipped: { id: string; missing: string }[] = [];
    for (const f of feats) {
      if (!f.entitled) continue;
      const on = want.has(f.id) && f.ready;
      if (want.has(f.id) && !f.ready) skipped.push({ id: f.id, missing: f.missing });
      draft.modules[f.id] = { ...draft.modules[f.id]!, enabled: on };
    }
    return { view: this.stores.saveDraft(id, draft, view.draft.updatedAt, userId), skipped };
  }
}
