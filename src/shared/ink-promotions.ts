// Promoções da INK lidas pela API (GET /v1/stores/promotions, escopo store.promotions.read).
// Contrato: https://developers.reserva.ink/guias/promocoes — três subtipos:
//   standard    um desconto (percentage | value) com uma condição (min_cart_value | min_cart_items)
//   progressive patamares escalonados por progress_kind (cart_value | cart_items)
//   unit_free   a peça mais barata sai grátis a partir de N itens (4 a 8)
// Aqui só se normaliza e se traduz para os módulos; quem aplica o desconto é a INK.
import type { Values } from './fields.ts';

export interface InkPromotion {
  id: number;
  type: 'standard' | 'progressive' | 'unit_free';
  code: string;
  /** true: a INK aplica sozinha no carrinho; false: o cliente digita o código. */
  automatic: boolean;
  kind: 'percentage' | 'value' | null;
  progressKind: 'cart_value' | 'cart_items' | null;
  firstPurchase: boolean;
  /** Calculado pela INK: vigente agora (não expirou, não agendada, dentro do limite de usos). */
  available: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  /** all = loja inteira; products, product_types, collections = só parte do catálogo. */
  scope: 'all' | 'products' | 'product_types' | 'collections';
  collectionIds: number[];
  showOnProduct: boolean;
  showInCart: boolean;
  tiers: { minItems: number | null; minValue: number | null; discount: number | null }[];
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const iso = (v: unknown): string | null => (typeof v === 'string' && v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

/** Uma promoção como a API devolve → formato interno. null quando falta o essencial. */
export function normalizePromotion(raw: unknown): InkPromotion | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const type = r.type === 'standard' || r.type === 'progressive' || r.type === 'unit_free' ? r.type : null;
  const code = typeof r.code === 'string' ? r.code.trim() : '';
  if (!type || !/^[A-Za-z0-9_-]{2,40}$/.test(code)) return null;
  const tiers = (Array.isArray(r.discount_tiers) ? r.discount_tiers : [])
    .map((t) => (typeof t === 'object' && t ? (t as Record<string, unknown>) : {}))
    .map((t) => ({ minItems: num(t.min_cart_items), minValue: num(t.min_cart_value), discount: num(t.discount) }))
    .slice(0, 8);
  const scope = ['products', 'product_types', 'collections'].includes(String(r.list_type)) ? (r.list_type as InkPromotion['scope']) : 'all';
  return {
    id: num(r.id) ?? 0,
    type,
    code,
    automatic: r.apply_automatically === true,
    kind: r.kind === 'percentage' || r.kind === 'value' ? r.kind : null,
    progressKind: r.progress_kind === 'cart_value' || r.progress_kind === 'cart_items' ? r.progress_kind : null,
    firstPurchase: r.first_purchase === true,
    available: r.available === true,
    startsAt: iso(r.starts_at),
    expiresAt: iso(r.expires_at),
    scope,
    collectionIds: (Array.isArray(r.collection_ids) ? r.collection_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 50),
    showOnProduct: r.show_on_product_page === true,
    showInCart: r.show_in_cart === true,
    tiers,
  };
}

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: n % 1 ? 2 : 0 });
const pct = (n: number) => `${n.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;

export function discountText(p: Pick<InkPromotion, 'kind'>, discount: number | null): string {
  if (discount === null) return '';
  return p.kind === 'value' ? `${brl(discount)} OFF` : `${pct(discount)} OFF`;
}

function conditionText(t: InkPromotion['tiers'][number]): string {
  if (t.minItems) return `a partir de ${t.minItems} ${t.minItems > 1 ? 'peças' : 'peça'}`;
  if (t.minValue) return `acima de ${brl(t.minValue)}`;
  return '';
}

/** Uma linha por patamar, em português: "10% OFF a partir de 2 peças". */
export function tierLines(p: InkPromotion): string[] {
  if (p.type === 'unit_free') {
    const n = p.tiers[0]?.minItems;
    return n ? [`Leve ${n}, pague ${n - 1}: a peça mais barata sai grátis`] : [];
  }
  return p.tiers.map((t) => [discountText(p, t.discount), conditionText(t)].filter(Boolean).join(' ')).filter(Boolean);
}

export const SCOPE_TEXT: Record<InkPromotion['scope'], string> = {
  all: 'Vale para a loja toda.',
  products: 'Só em produtos selecionados.',
  product_types: 'Só em alguns tipos de peça.',
  collections: 'Só em algumas coleções.',
};

/** Resumo para condições e para o painel. */
export function promotionSummary(p: InkPromotion): string {
  const parts = [...tierLines(p)];
  if (p.firstPurchase) parts.push('só na primeira compra');
  parts.push(SCOPE_TEXT[p.scope].replace(/\.$/, '').toLowerCase());
  return `${parts.join(' · ')}.`.replace(/^./, (c) => c.toUpperCase());
}

/** Campanha do M05 (cupom que o cliente digita). Promoções automáticas não viram cupom. */
export function promotionToCampaign(p: InkPromotion): Values | null {
  if (p.automatic) return null;
  const lines = tierLines(p);
  const title = p.type === 'progressive' ? 'Quanto mais peças, maior o desconto' : p.type === 'unit_free' ? lines[0]!.split(':')[0]! : `${lines[0] ?? p.code}${p.firstPurchase ? ' na primeira compra' : ''}`;
  return {
    title: title.slice(0, 60),
    // O alcance fica na parte visível do cupom (não só nas condições recolhidas).
    description: (p.type === 'progressive' ? `${lines.join(' · ')} · ${SCOPE_TEXT[p.scope]}` : SCOPE_TEXT[p.scope]).slice(0, 140),
    code: p.code,
    conditions: promotionSummary(p).slice(0, 240),
    startsAt: p.startsAt,
    endsAt: p.expiresAt,
    firstPurchase: p.firstPurchase,
    nearPrice: false,
    badge: '',
  };
}

/** Por que uma promoção não pode virar metas do M06 sem mudar o alcance dela. null = pode. */
export function incentiveBlocker(p: InkPromotion, collectionPath?: (id: number) => string | null): string | null {
  if (p.scope === 'all') return null;
  if (p.scope === 'collections' && p.collectionIds.length === 1 && collectionPath?.(p.collectionIds[0]!)) return null;
  if (p.scope === 'collections') return 'vale para várias coleções; o incentivo do carrinho conta uma coleção só ou a loja toda.';
  return p.scope === 'products' ? 'vale só para produtos selecionados; o incentivo do carrinho não separa produtos.' : 'vale só para alguns tipos de peça; o incentivo do carrinho não separa tipos.';
}

/**
 * Faixas do M06 (incentivo no carrinho) para promoções com patamar. null quando não há meta
 * ou quando importar mudaria o alcance (ver incentiveBlocker): nunca vira oferta para a loja toda.
 * Promoção de uma coleção só: o M06 passa a contar só os itens dela (caminho da coleção).
 */
export function promotionToIncentive(p: InkPromotion, collectionPath?: (id: number) => string | null): Values | null {
  if (incentiveBlocker(p, collectionPath)) return null;
  const only = p.scope === 'collections' ? collectionPath!(p.collectionIds[0]!)! : null;
  const eligibility = only ? { eligibility: 'colecao', eligiblePath: only } : { eligibility: 'todos' };
  if (p.type === 'unit_free') {
    const n = p.tiers[0]?.minItems;
    return n ? { campaignName: p.code, measure: 'itens', ...eligibility, tiers: [{ threshold: n, benefit: 'brinde', amount: 0, label: 'Peça mais barata grátis' }] } : null;
  }
  const byItems = p.progressKind ? p.progressKind === 'cart_items' : p.tiers.some((t) => t.minItems);
  const tiers = p.tiers
    .map((t) => ({ threshold: byItems ? t.minItems : t.minValue, discount: t.discount }))
    .filter((t): t is { threshold: number; discount: number } => !!t.threshold && t.discount !== null && t.discount > 0)
    .sort((a, b) => a.threshold - b.threshold)
    .slice(0, 4)
    .map((t) => ({
      threshold: t.threshold,
      benefit: p.kind === 'value' ? 'valor' : 'percentual',
      amount: t.discount,
      label: discountText(p, t.discount).slice(0, 40),
    }));
  return tiers.length ? { campaignName: p.code, measure: byItems ? 'itens' : 'valor', ...eligibility, tiers } : null;
}
