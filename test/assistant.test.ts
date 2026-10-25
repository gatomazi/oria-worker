import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AssistantService, matchSections, rankKnowledge, searchTerms } from '../src/platform/assistant.ts';
import { stack } from './helpers.ts';
import { fixture } from './dom-harness.ts';
import { previewToken } from '../src/platform/tokens.ts';

const KB = [
  { topic: 'entrega', question: 'Qual o prazo de entrega?', answer: 'Produção em até 7 dias úteis.', keywords: 'prazo, entrega, chega' },
  { topic: 'trocas', question: 'Como faço uma troca?', answer: 'Primeira troca sem custo.', keywords: 'troca, trocar, devolução' },
];

function setupAssistant(opts: { enabled?: boolean; maxMessages?: number } = {}) {
  // Busca da INK → resultado real de "vó"; demais páginas → início real (menu com as coleções).
  const fetchImpl = (async (url: string | URL) => {
    const html = String(url).includes('search_filter=') ? fixture('search-vo.html') : fixture('home.html');
    return new Response(html, { headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  const s = stack({ fetchImpl });
  s.stores.savePackage({ id: 'conteudo', name: 'Conteúdo', modules: ['videoCards', 'miniPlayer', 'assistant'] }, null);
  const v = s.stores.view('demo-trilha');
  const cfg = structuredClone(v.draft.config);
  cfg.modules.assistant = { enabled: opts.enabled !== false, settings: { ...cfg.modules.assistant!.settings, knowledge: KB, maxMessages: opts.maxMessages ?? 15, whatsapp: '5561999990000' } };
  s.stores.saveDraft('demo-trilha', cfg, v.draft.updatedAt, null);
  s.stores.publish('demo-trilha', s.stores.view('demo-trilha').draft.updatedAt, null);
  const a = new AssistantService({ stores: s.stores, catalog: s.catalog, db: s.db, secret: s.secret, integration: s.integration });
  return { s, a };
}

const ask = (a: AssistantService, message: string, sessionId = 'sessao-teste-01', extra: Record<string, unknown> = {}) => a.answer('demo-trilha', { sessionId, message, ...extra });

test('recuperação: a resposta certa da base, sem inventar', async () => {
  assert.equal(rankKnowledge('quanto tempo demora a entrega?', KB)[0]?.item.topic, 'entrega');
  assert.equal(rankKnowledge('quero trocar o tamanho', KB)[0]?.item.topic, 'trocas');
  assert.deepEqual(rankKnowledge('vocês aceitam bitcoin?', KB), []);
  const { s, a } = setupAssistant();
  try {
    const r = await ask(a, 'qual o prazo de entrega?');
    assert.equal(r.body.answer, 'Produção em até 7 dias úteis.');
    const none = await ask(a, 'aceitam bitcoin?');
    assert.match(String(none.body.answer), /Não tenho essa informação/);
    assert.deepEqual(none.body.contact, { label: 'Falar com a loja', url: 'https://wa.me/5561999990000' });
  } finally {
    s.close();
  }
});

test('busca por peça usa o catálogo real; pedido vai para o rastreio nativo; dado sensível é recusado', async () => {
  const { s, a } = setupAssistant();
  try {
    const p = await ask(a, 'tem camiseta de vó?');
    assert.ok((p.body.products as unknown[]).length > 0);
    assert.match(JSON.stringify(p.body.products), /\/vistaentrenos\/product\//);
    const o = await ask(a, 'onde está meu pedido?');
    assert.deepEqual(o.body.link, { label: 'Rastrear pedido', path: '/vistaentrenos/orders/trackings' });
    const c = await ask(a, 'meu cpf é 123.456.789-00');
    assert.match(String(c.body.answer), /não compartilhe CPF/);
  } finally {
    s.close();
  }
});

test('limite por visita no servidor; desligado não responde; prévia usa o rascunho', async () => {
  const { s, a } = setupAssistant({ maxMessages: 3 });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await ask(a, 'prazo?', 'sessao-limite-1')).status, 200);
    const over = await ask(a, 'prazo?', 'sessao-limite-1');
    assert.equal(over.status, 429);
    assert.equal(over.body.remaining, 0);
    assert.equal((await ask(a, 'prazo?', 'sessao-limite-2')).status, 200, 'outra visita tem a própria cota');
    assert.equal((await a.answer('demo-trilha', { sessionId: 'curta', message: 'x' })).status, 400);
  } finally {
    s.close();
  }
  const off = setupAssistant({ enabled: false });
  try {
    assert.equal((await ask(off.a, 'prazo?')).status, 404);
    // rascunho com assistente ligado, ainda não publicado: só a prévia com token vê
    const v = off.s.stores.view('demo-trilha');
    const cfg = structuredClone(v.draft.config);
    cfg.modules.assistant!.enabled = true;
    off.s.stores.saveDraft('demo-trilha', cfg, v.draft.updatedAt, null);
    assert.equal((await ask(off.a, 'prazo?')).status, 404);
    assert.equal((await ask(off.a, 'prazo?', 'sessao-previa-1', { previewToken: previewToken(off.s.secret, 'demo-trilha') })).status, 200);
  } finally {
    off.s.close();
  }
});

test('procura por estampa: termos limpos, produtos da loja e a coleção com o mesmo nome', async () => {
  assert.deepEqual(searchTerms('Vocês têm estampa de mãe?'), ['mae']);
  assert.deepEqual(searchTerms('procuro uma camiseta de pai'), ['camiseta', 'pai']);
  const sections = [{ label: 'Mães', path: '/vistaentrenos/collections/maes' }, { label: 'Pais', path: '/vistaentrenos/collections/pais' }, { label: 'Fé', path: '/vistaentrenos/collections/fe' }];
  assert.deepEqual(matchSections(['mae'], sections).map((x) => x.label), ['Mães']);
  assert.deepEqual(matchSections(['bitcoin'], sections), []);
  assert.deepEqual(matchSections(['papai'], sections).map((x) => x.label), ['Pais'], 'sinônimo comum');
  assert.deepEqual(matchSections(['cachorro'], [...sections, { label: 'Pets', path: '/p' }]).map((x) => x.label), ['Pets']);
  assert.deepEqual(searchTerms('presente pra vó'), ['vo']);
  const { s, a } = setupAssistant();
  try {
    const r = await ask(a, 'tem estampa de mãe?');
    assert.ok((r.body.products as unknown[]).length > 0, 'traz produtos do catálogo');
    assert.deepEqual(r.body.collections, [{ label: 'Mães', path: '/vistaentrenos/collections/maes' }], 'traz a coleção');
    assert.equal(r.body.link, undefined, 'produtos vieram da coleção (curada), não da busca');
    assert.equal('engine' in r.body, false, 'sem IA');
    const titles = (r.body.products as { title: string }[]).map((p) => p.title);
    assert.equal(new Set(titles).size, titles.length, 'sem nomes repetidos');
    // Tema sem coleção: busca nativa da INK.
    const dog = await ask(a, 'tem estampa de abelha?');
    assert.ok((dog.body.products as unknown[]).length > 0);
    assert.deepEqual(dog.body.collections, []);
    assert.match(String((dog.body.link as { path: string }).path), /search_filter=abelha/);
    const none = await ask(a, 'tem estampa de dinossauro?', 'sessao-teste-02');
    assert.ok((none.body.products as unknown[]).length > 0 || /Não encontrei peças com "dinossauro"/.test(String(none.body.answer)));
    // Tipo de peça não vira tema: "camiseta de pai" casa com a coleção Pais, não com "Camiseta".
    assert.deepEqual(matchSections(['pai'], [{ label: 'Camiseta', path: '/c' }, { label: 'Pais', path: '/p' }]).map((x) => x.label), ['Pais']);
  } finally {
    s.close();
  }
});
