// Homologação da API da INK com um token REAL. Só leituras; nada é gravado na INK nem no banco.
// O token vem só do ambiente e nunca é impresso:
//   INK_TOKEN=... npm run check:api -- <slug-da-loja>      (ex.: vistaentrenos)
// Confere: escopos store.promotions.read / store.categories.read / store.products.read,
// paginação (per_page e total_pages), formato documentado e a transformação de cada
// promoção (standard, progressive, unit_free: alcance, vigência, primeira compra, automática).
import { normalizePromotion, promotionToCampaign, promotionToIncentive, incentiveBlocker, tierLines, SCOPE_TEXT } from '../src/shared/ink-promotions.ts';

const BASE = process.env.INK_API_BASE_URL || 'https://api.reserva.ink';
const token = process.env.INK_TOKEN?.trim();
const slug = process.argv[2];
if (!token || !slug) {
  console.error('Uso: INK_TOKEN=<token> npm run check:api -- <slug-da-loja>   (o token não é impresso)');
  process.exit(2);
}
let fail = 0;
const ok = (m) => console.log(`ok      ${m}`);
const ko = (m) => {
  console.log(`FALHOU  ${m}`);
  fail = 1;
};
let calls = 0;
const get = async (path) => {
  calls++;
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  const body = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
  return { status: res.status, body };
};
const scopeOf = { promotions: 'store.promotions.read', collections: 'store.categories.read', products: 'store.products.read' };

// 1. Conexão e loja do token
const probe = await get('/v1/stores/products?per_page=1&page=1');
if (probe.status === 401) ko('token recusado (401)');
else if (probe.status === 403) ko(`sem acesso a produtos (403): ${probe.body?.error ?? ''} ${probe.body?.message ?? ''}`.trim());
else if (probe.status !== 200) ko(`produtos respondeu ${probe.status}`);
else {
  const s = probe.body?.products?.[0]?.store;
  if (s?.slug && s.slug !== slug) ko(`o token é da loja ${s.slug}, não de ${slug}`);
  else ok(`token desta loja (${s?.name ?? slug}); ${probe.body?.total_count ?? '?'} produtos`);
}

// 2. Cada recurso: escopo, envelope de paginação e todas as páginas (até 10)
const all = {};
for (const [key, path] of [['promotions', '/v1/stores/promotions'], ['collections', '/v1/stores/collections'], ['products', '/v1/stores/products?visible_in_store=true']]) {
  const items = [];
  let pages = 1;
  for (let page = 1; page <= Math.min(pages, 10); page++) {
    const r = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (r.status === 403) {
      ko(`${key}: sem o escopo ${scopeOf[key]} (403) — o restante segue`);
      break;
    }
    if (r.status !== 200) {
      ko(`${key}: respondeu ${r.status}`);
      break;
    }
    const b = r.body ?? {};
    if (page === 1) {
      const env = ['page', 'per_page', 'total_pages', 'total_count'].filter((k) => !(k in b));
      env.length ? ko(`${key}: envelope sem ${env.join(', ')}`) : ok(`${key}: envelope de paginação (per_page ${b.per_page}, ${b.total_pages} página(s), ${b.total_count} itens)`);
      pages = Number(b.total_pages) || 1;
    }
    items.push(...(Array.isArray(b[key]) ? b[key] : []));
  }
  all[key] = items;
}

// 3. Promoções: formato e transformação, uma a uma
for (const raw of all.promotions ?? []) {
  const p = normalizePromotion(raw);
  if (!p) {
    ko(`promoção ${raw?.id ?? '?'} fora do formato documentado (type/code)`);
    continue;
  }
  const camp = promotionToCampaign(p);
  const inc = promotionToIncentive(p, (cid) => (all.collections ?? []).find((c) => c.id === cid)?.slug ? `/${slug}/collections/${(all.collections ?? []).find((c) => c.id === cid).slug}` : null);
  const block = inc ? null : incentiveBlocker(p, () => null);
  console.log(
    `info    ${p.code} [${p.type}${p.automatic ? ', automática' : ''}${p.available ? '' : ', fora do ar'}] ${tierLines(p).join(' · ') || '(sem patamar legível)'} · ${SCOPE_TEXT[p.scope]}${p.firstPurchase ? ' · 1ª compra' : ''}${p.expiresAt ? ` · até ${p.expiresAt}` : ''}` +
      `\n          → cupom: ${camp ? 'sim' : 'não (automática)'} · metas no carrinho: ${inc ? (inc.eligibility === 'colecao' ? `sim (só ${inc.eligiblePath})` : 'sim (loja toda)') : `não${block ? ` (${block})` : ''}`}`,
  );
  if (p.scope !== 'all' && inc && inc.eligibility !== 'colecao') ko(`${p.code}: alcance restrito virou loja toda`);
  if (!tierLines(p).length) ko(`${p.code}: patamares sem desconto/condição legíveis`);
}
if ((all.promotions ?? []).length) ok(`${all.promotions.length} promoção(ões) lidas e transformadas sem ampliar o alcance`);

console.log(`\n${calls} chamada(s) à API (limite da INK: 100 por minuto por loja).`);
console.log(fail ? 'Há falhas acima.' : 'Contrato conferido com a loja real.');
process.exit(fail);
