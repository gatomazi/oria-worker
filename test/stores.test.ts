import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stack, VISTA, IDENTITY, coupon } from './helpers.ts';

function withCoupon(config: any, code: string, enabled = true) {
  const c = structuredClone(config);
  c.modules.coupons = { enabled, settings: { ...c.modules.coupons.settings, campaigns: [coupon({ code })] } };
  return c;
}

test('cadastro de loja: validação, identidade inicial e liberação por pacote', () => {
  const s = stack();
  try {
    assert.throws(() => s.stores.createStore({ ...VISTA, id: 'X', domain: 'nao é domínio' }, IDENTITY, null), (e: any) => e.errors.some((x: any) => x.field === 'id') && e.errors.some((x: any) => x.field === 'domain'));
    const st = s.stores.createStore(VISTA, IDENTITY, null);
    assert.equal(st.devOrigin, 'https://www.vistaentrenos.com.br');
    assert.deepEqual([...s.stores.entitled(st)].sort(), ['categoryTabs', 'cookieNotice', 'coupons', 'gallery', 'header', 'share']);
    const view = s.stores.view(st.id);
    assert.equal(view.draft.config.identity.primary, '#50313D');
    assert.equal(view.published, null);
    assert.throws(() => s.stores.createStore(VISTA, IDENTITY, null), /Revise/);
  } finally {
    s.close();
  }
});

test('rascunho não altera a loja; publicar altera só a loja certa (isolamento A/B)', () => {
  const s = stack();
  try {
    const a = s.stores.view('demo-aurora');
    s.stores.saveDraft('demo-aurora', withCoupon(a.draft.config, 'AURORA10'), a.draft.updatedAt, null);
    assert.equal(s.stores.publicConfig('demo-aurora'), null, 'rascunho não publica');
    const a2 = s.stores.view('demo-aurora');
    s.stores.publish('demo-aurora', a2.draft.updatedAt, null);
    const pubA = s.stores.publicConfig('demo-aurora')!;
    assert.equal((pubA.modules.coupons!.settings as any).campaigns[0].code, 'AURORA10');
    assert.equal(s.stores.publicConfig('demo-trilha'), null, 'B continua sem publicação');

    const b = s.stores.view('demo-trilha');
    s.stores.saveDraft('demo-trilha', withCoupon(b.draft.config, 'TRILHA15'), b.draft.updatedAt, null);
    s.stores.publish('demo-trilha', s.stores.view('demo-trilha').draft.updatedAt, null);
    assert.equal((s.stores.publicConfig('demo-aurora')!.modules.coupons!.settings as any).campaigns[0].code, 'AURORA10');
    assert.equal(s.stores.publicConfig('demo-aurora')!.version, 1);
  } finally {
    s.close();
  }
});

test('ligar/desligar um módulo publica só ele; edições pendentes não vão junto', () => {
  const s = stack();
  try {
    const v = s.stores.view('demo-aurora');
    let cfg = withCoupon(v.draft.config, 'PUBLICADO');
    cfg.modules.share = { enabled: true, settings: cfg.modules.share.settings };
    s.stores.saveDraft('demo-aurora', cfg, v.draft.updatedAt, null);
    s.stores.publish('demo-aurora', s.stores.view('demo-aurora').draft.updatedAt, null);
    // edição pendente no rascunho
    const v2 = s.stores.view('demo-aurora');
    s.stores.saveDraft('demo-aurora', withCoupon(v2.draft.config, 'PENDENTE'), v2.draft.updatedAt, null);

    const off = s.stores.setModuleState('demo-aurora', 'share', false, null);
    assert.equal(off.published!.version, 2);
    assert.equal(off.published!.config.modules.share!.enabled, false);
    assert.equal((off.published!.config.modules.coupons!.settings as any).campaigns[0].code, 'PUBLICADO', 'pendente não publicado');
    assert.equal((off.draft.config.modules.coupons!.settings as any).campaigns[0].code, 'PENDENTE', 'pendente preservado');
    assert.equal(off.draft.config.modules.share!.enabled, false, 'ativo do rascunho sincronizado');
    assert.equal(s.stores.publicConfig('demo-aurora')!.modules.share, undefined);
    assert.throws(() => s.stores.setModuleState('demo-aurora', 'share', false, null), /já está desligado/);
    assert.throws(() => s.stores.setModuleState('demo-aurora', 'videoCards', true, null), /não liberado/);
    // Módulo liberado mas incompleto (guia de medidas sem tabela) não liga direto na loja.
    assert.throws(
      () => s.stores.setModuleState('demo-aurora', 'sizeGuide', true, null),
      (e: { message: string; errors?: { field: string }[] }) => /não pode ser ligado/.test(e.message) && !!e.errors?.some((x) => x.field.startsWith('modules.sizeGuide.')),
    );
    assert.equal(s.stores.publicConfig('demo-aurora')!.modules.sizeGuide, undefined);
  } finally {
    s.close();
  }
});

test('restaurar cria nova versão igual à escolhida e atualiza o rascunho', () => {
  const s = stack();
  try {
    const v = s.stores.view('demo-aurora');
    s.stores.saveDraft('demo-aurora', withCoupon(v.draft.config, 'V1CODE'), v.draft.updatedAt, null);
    s.stores.publish('demo-aurora', s.stores.view('demo-aurora').draft.updatedAt, null);
    const v2 = s.stores.view('demo-aurora');
    s.stores.saveDraft('demo-aurora', withCoupon(v2.draft.config, 'V2CODE'), v2.draft.updatedAt, null);
    s.stores.publish('demo-aurora', s.stores.view('demo-aurora').draft.updatedAt, null);
    const r = s.stores.restore('demo-aurora', 1, null);
    assert.equal(r.published!.version, 3);
    assert.equal(r.published!.action, 'restore');
    assert.equal((s.stores.publicConfig('demo-aurora')!.modules.coupons!.settings as any).campaigns[0].code, 'V1CODE');
    assert.equal((r.draft.config.modules.coupons!.settings as any).campaigns[0].code, 'V1CODE');
    assert.deepEqual(r.history.map((h) => h.version), [3, 2, 1]);
    assert.throws(() => s.stores.restore('demo-aurora', 99, null), /não encontrada/);
  } finally {
    s.close();
  }
});

test('liberação: rascunho não liga módulo não liberado; tirar pacote tira o módulo da loja', () => {
  const s = stack();
  try {
    const v = s.stores.view('demo-trilha');
    const cfg = structuredClone(v.draft.config);
    cfg.modules.delivery!.enabled = true; // válido com os padrões, mas não liberado para a Trilha
    assert.throws(() => s.stores.saveDraft('demo-trilha', cfg, v.draft.updatedAt, null), /não está liberado/);

    s.stores.saveDraft('demo-trilha', withCoupon(v.draft.config, 'TRILHA15'), v.draft.updatedAt, null);
    s.stores.publish('demo-trilha', s.stores.view('demo-trilha').draft.updatedAt, null);
    assert.ok(s.stores.publicConfig('demo-trilha')!.modules.coupons);
    s.stores.updateStore('demo-trilha', { ...s.stores.get('demo-trilha'), packages: ['conteudo'] }, null);
    assert.equal(s.stores.publicConfig('demo-trilha')!.modules.coupons, undefined, 'sai da loja sem nova publicação');
  } finally {
    s.close();
  }
});

test('loja pausada não entrega configuração; conflito de rascunho é detectado', () => {
  const s = stack();
  try {
    const v = s.stores.view('demo-aurora');
    s.stores.saveDraft('demo-aurora', withCoupon(v.draft.config, 'AURORA10'), v.draft.updatedAt, null);
    assert.throws(() => s.stores.saveDraft('demo-aurora', v.draft.config, v.draft.updatedAt, null), /outra janela/);
    s.stores.publish('demo-aurora', s.stores.view('demo-aurora').draft.updatedAt, null);
    s.stores.updateStore('demo-aurora', { ...s.stores.get('demo-aurora'), status: 'paused' }, null);
    assert.equal(s.stores.publicConfig('demo-aurora'), null);
  } finally {
    s.close();
  }
});

test('pacotes: sem preço, módulos válidos', () => {
  const s = stack();
  try {
    assert.equal(s.stores.listPackages().length, 3);
    assert.throws(() => s.stores.savePackage({ id: 'x1', name: 'X', modules: ['inexistente'] }, null), /Revise/);
    const p = s.stores.savePackage({ id: 'completo', name: 'Completo', modules: ['header', 'assistant'] }, null);
    assert.deepEqual(p.modules, ['header', 'assistant']);
    assert.equal(JSON.stringify(p).match(/pre[cç]o|price/i), null);
  } finally {
    s.close();
  }
});
