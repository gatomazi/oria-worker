// Configura as duas lojas de demonstração pela API do painel (mesmo caminho
// que o lojista usa): rascunho → salvar → publicar. Conteúdo fictício e
// identificado como demonstração. Uso: npm run demo:setup (com npm run dev no ar).
import { readFileSync } from 'node:fs';

const ADMIN = process.env.ADMIN_URL ?? 'http://127.0.0.1:4000';
const EMAIL = process.env.OPERATOR_EMAIL ?? 'gabriel@local.invalid';
const PASSWORD = process.env.OPERATOR_PASSWORD;
if (!PASSWORD) {
  console.error('Defina OPERATOR_PASSWORD (senha do operador no painel local).');
  process.exit(2);
}

let cookie = '';
let csrf = '';
async function api(path, { method = 'GET', json, body, headers = {} } = {}) {
  const h = { origin: ADMIN, cookie, ...headers };
  if (json !== undefined) h['content-type'] = 'application/json';
  if (method !== 'GET') h['x-csrf-token'] = csrf;
  const res = await fetch(ADMIN + path, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : body });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.message ?? ''} ${JSON.stringify(data.errors ?? []).slice(0, 400)}`);
  return data;
}

async function configure(id, mutate) {
  const view = await api(`/api/stores/${id}`);
  const draft = structuredClone(view.draft.config);
  await mutate(draft, view);
  const saved = await api(`/api/stores/${id}/draft`, { method: 'PUT', json: { config: draft, expectedUpdatedAt: view.draft.updatedAt } });
  const pub = await api(`/api/stores/${id}/publish`, { method: 'POST', json: { expectedDraftUpdatedAt: saved.draft.updatedAt } });
  const on = Object.entries(pub.published.config.modules).filter(([, m]) => m.enabled).map(([m]) => m);
  console.log(`${id}: versão ${pub.published.version} publicada — ${on.join(', ')}`);
}

const on = (draft, id, settings) => {
  draft.modules[id] = { enabled: true, settings: { ...draft.modules[id].settings, ...settings } };
};

const login = await api('/api/login', { method: 'POST', json: { email: EMAIL, password: PASSWORD } });
csrf = login.csrf;

const BASE = '/vistaentrenos';
const sizeTable = {
  linkLabel: 'Guia de medidas',
  tables: [
    {
      name: 'Camiseta tradicional (exemplo)',
      match: 'camiseta',
      rows: [
        { size: 'P', width: 50, length: 70 },
        { size: 'M', width: 53, length: 72 },
        { size: 'G', width: 56, length: 74 },
        { size: 'GG', width: 59, length: 76 },
      ],
      note: 'Tabela de exemplo da demonstração. Use as medidas reais da sua loja.',
    },
  ],
};

await configure('demo-aurora', (d) => {
  on(d, 'header', { behavior: 'reaparece', benefits: 'manter', searchMode: 'barra', menu: [
    { label: 'Início', path: BASE, group: '' },
    { label: 'Mães', path: `${BASE}/collections/maes`, group: 'Coleções' },
    { label: 'Pais', path: `${BASE}/collections/pais`, group: 'Coleções' },
    { label: 'Casais', path: `${BASE}/collections/casais`, group: 'Coleções' },
    { label: 'Camisetas', path: `${BASE}/products?product_type=1`, group: '' },
    { label: 'Sobre', path: `${BASE}/about`, group: '' },
  ] });
  on(d, 'categoryTabs', { title: 'Escolha por ocasião', tabs: [
    { label: 'Mães', path: `${BASE}/collections/maes` },
    { label: 'Pais', path: `${BASE}/collections/pais` },
    { label: 'Casais', path: `${BASE}/collections/casais` },
  ], limit: 8, hideNative: true });
  on(d, 'gallery', { size: 'media', hideBullets: true });
  on(d, 'share', {});
  on(d, 'coupons', { mode: 'abas', pages: ['home', 'product'], campaigns: [
    { title: 'Primeira compra: 10% off', description: 'Cupom fictício da demonstração.', code: 'AURORA10', conditions: 'Exemplo fictício: válido na primeira compra acima de R$ 120.', startsAt: null, endsAt: null, firstPurchase: true, nearPrice: true, badge: '10% off na 1ª compra' },
    { title: 'Frete por nossa conta', description: 'Campanha fictícia de demonstração.', code: 'FRETEAURORA', conditions: 'Exemplo fictício: Sul e Sudeste, acima de R$ 199.', startsAt: null, endsAt: null, firstPurchase: false, nearPrice: false, badge: '' },
  ] });
  on(d, 'cartIncentive', { campaignName: 'Leve mais (demonstração)', measure: 'itens', tiers: [
    { threshold: 2, benefit: 'percentual', amount: 10, label: '10% de desconto' },
    { threshold: 3, benefit: 'percentual', amount: 15, label: '15% de desconto' },
  ], recommendations: 'mais-vendidos', recommendationCount: 4 });
  on(d, 'reviews', { selection: 'com-foto', pages: ['home'], max: 8 });
  on(d, 'sizeGuide', sizeTable);
  on(d, 'delivery', { productionMin: 3, productionMax: 7 });
});

// Vídeo sintético (barras de teste), identificado como demonstração.
const video = await api('/api/stores/demo-trilha/media', { method: 'POST', body: readFileSync('test/fixtures/media/demo-sintetico.mp4'), headers: { 'content-type': 'video/mp4', 'x-file-name': 'demo-sintetico.mp4' } });
const poster = await api('/api/stores/demo-trilha/media', { method: 'POST', body: readFileSync('test/fixtures/media/demo-capa.jpg'), headers: { 'content-type': 'image/jpeg', 'x-file-name': 'demo-capa.jpg' } });

await configure('demo-trilha', (d) => {
  d.library.videos = [
    { id: 'demovideo01', title: 'Vídeo de demonstração 1', caption: 'Vídeo sintético (barras de teste) para a demonstração.', videoUrl: video.url, posterUrl: poster.url, productPaths: [`${BASE}/product/vo-minha-maior-riqueza`] },
    { id: 'demovideo02', title: 'Vídeo de demonstração 2', caption: 'Vídeo sintético para a demonstração.', videoUrl: video.url, posterUrl: poster.url, productPaths: [`${BASE}/product/pato-da-vida-elas`] },
  ];
  on(d, 'header', { layout: 'logo-esquerda', behavior: 'fixo', benefits: 'ocultar', background: 'primary', searchMode: 'icone' });
  on(d, 'coupons', { mode: 'unico', position: 'abaixo-cabecalho', pages: ['home', 'listing'], campaigns: [
    { title: 'Drop de inverno', description: 'Cupom fictício da demonstração.', code: 'TRILHA15', conditions: 'Exemplo fictício: 15% em moletons até domingo.', startsAt: null, endsAt: null, firstPurchase: false, nearPrice: false, badge: '' },
  ] });
  on(d, 'videoCards', { title: 'Veja no corpo', videos: ['demovideo01', 'demovideo02'], onProduct: true });
  on(d, 'miniPlayer', { source: 'produto-primeiro', videos: ['demovideo01'], position: 'inferior-esquerda', delaySeconds: 2, frequency: 'sessao' });
  on(d, 'assistant', {
    name: 'Ajuda Trilha',
    greeting: 'Oi! Sou o assistente de demonstração. Pergunte sobre entrega, trocas ou peças.',
    suggestions: [{ text: 'Qual o prazo de entrega?' }, { text: 'Como faço uma troca?' }],
    knowledge: [
      { topic: 'entrega', question: 'Qual o prazo de entrega?', answer: 'Exemplo fictício: produzimos em até 7 dias úteis; o transporte é calculado pela INK com o seu CEP na página do produto.', keywords: 'prazo, entrega, chega, demora, envio' },
      { topic: 'trocas', question: 'Como faço uma troca?', answer: 'Exemplo fictício: a primeira troca é sem custo em até 7 dias após o recebimento. Solicite em "Trocar pedido" no menu.', keywords: 'troca, trocar, devolução, devolver, tamanho errado' },
      { topic: 'produtos', question: 'Qual o tecido das camisetas?', answer: 'Exemplo fictício: 100% algodão, fio 30.1 penteado.', keywords: 'tecido, algodão, malha, material' },
    ],
    whatsapp: '5561999990000',
    proactive: 'convite',
    proactiveDelay: 8,
    proactiveMessage: 'Dúvida sobre entrega ou tamanho?',
  });
});
// --vista: cadastra a loja INK de teste do dono (Vista Entre Nós) pela API do painel,
// com identidade e combinação próprias. Lida só por GET no proxy local.
if (process.argv.includes('--vista')) {
  const exists = await api('/api/stores/vista-entre-nos').catch(() => null);
  if (!exists) {
    await api('/api/stores', {
      method: 'POST',
      json: {
        store: { id: 'vista-entre-nos', name: 'Vista Entre Nós', ownerName: 'Gabriel Tomazi', ownerEmail: 'gabriel@local.invalid', domain: 'www.vistaentrenos.com.br', basePath: '/vistaentrenos', devHost: 'vistaentrenos.localhost', packages: ['vitrine', 'conversao', 'conteudo'] },
        identity: { logoUrl: '', primary: '#50313D', accent: '#9A3B5B', surface: '#F3E7CF', text: '#2A1A1D', font: 'inherit', style: 'suave' },
      },
    });
  }
  await configure('vista-entre-nos', (d) => {
    on(d, 'header', { searchMode: 'barra', instantSearch: true, searchPlaceholder: 'Busque por estampa ou tema' });
    on(d, 'categoryTabs', { title: 'Escolha por laço', tabs: [
      { label: 'Mães', path: `${BASE}/collections/maes` },
      { label: 'Pais', path: `${BASE}/collections/pais` },
      { label: 'Casais', path: `${BASE}/collections/casais` },
      { label: 'Fé', path: `${BASE}/collections/fe` },
    ], limit: 8 });
    on(d, 'gallery', { size: 'media' });
    on(d, 'share', {});
    on(d, 'coupons', { mode: 'unico', pages: ['home', 'listing', 'product'], campaigns: [
      { title: 'Cupom de teste da homologação', description: 'Texto de teste: troque pelo cupom real cadastrado na INK.', code: 'TESTE10', conditions: 'Teste local: confirme que o código existe na INK antes de divulgar.', startsAt: null, endsAt: null, firstPurchase: false, nearPrice: false, badge: '' },
    ] });
    on(d, 'delivery', { productionMin: 3, productionMax: 7 });
    // Assistente básico: perguntas por estampa trazem peças e coleções da própria Vista.
    on(d, 'assistant', {
      name: 'Ajuda Entre Nós (teste)',
      greeting: 'Oi! Procura uma estampa? Pergunte aqui.',
      suggestions: [{ text: 'Tem estampa de mãe?' }, { text: 'Como faço uma troca?' }],
      knowledge: [{ topic: 'trocas', question: 'Como faço uma troca?', answer: 'Texto de teste: confira a política de trocas da loja antes de publicar.', keywords: 'troca, trocar, devolução' }],
      productDiscovery: true,
    });
  });
}
console.log('Pronto. Lojas: http://demo-aurora.localhost:8787/vistaentrenos e http://demo-trilha.localhost:8787/vistaentrenos');
