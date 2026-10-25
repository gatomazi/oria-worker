import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/shared/modules/index.ts';
import { validateFields, type Field } from '../src/shared/fields.ts';
import { DEFAULT_IDENTITY, validateIdentity } from '../src/shared/identity.ts';
import { classifyPage, defaultConfig, hasModuleFor, moduleDefs, parsePublicConfig, parseStoreConfig, publishErrors, toPublicConfig } from '../src/shared/registry.ts';
import { coupon } from './helpers.ts';

const store = { id: 'loja-a', basePath: '/loja' };
const all = new Set(moduleDefs().map((d) => d.id));

test('registro tem os 13 módulos do catálogo, cada um com esquema, padrões e projeção', () => {
  const codes = moduleDefs().map((d) => d.code);
  assert.deepEqual(codes, ['M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09', 'M10', 'M11', 'M12', 'M13']);
  for (const d of moduleDefs()) {
    assert.ok(d.fields.length > 0, d.id);
    assert.ok(d.pages.length > 0, d.id);
    assert.equal(typeof d.project, 'function');
  }
});

test('configuração padrão (todos desligados, incompletos) é válida para salvar', () => {
  const r = parseStoreConfig(defaultConfig());
  assert.deepEqual(r.errors, []);
});

test('completude só vale para módulo ligado; segurança vale sempre', () => {
  const c = defaultConfig();
  c.modules.coupons!.enabled = true;
  const off = parseStoreConfig({ ...c, modules: { ...c.modules, coupons: { enabled: false, settings: c.modules.coupons!.settings } } });
  assert.deepEqual(off.errors, []);
  const on = parseStoreConfig(c);
  assert.ok(on.errors.some((e) => e.field === 'modules.coupons.campaigns'), 'cupom ligado sem campanha');

  const evil = defaultConfig();
  evil.modules.coupons!.settings.campaigns = [coupon({ title: '<img src=x onerror=alert(1)>' })];
  assert.ok(parseStoreConfig(evil).errors.some((e) => e.field === 'modules.coupons.campaigns.0.title'), 'HTML recusado mesmo com módulo desligado');
});

test('campos: caminho da loja, https, telefone, código e listas', () => {
  const fields: Field[] = [
    { key: 'p', type: 'storePath', label: 'P' },
    { key: 'u', type: 'httpsUrl', label: 'U' },
    { key: 'f', type: 'phone', label: 'F' },
    { key: 'c', type: 'code', label: 'C' },
  ];
  const bad = validateFields(fields, { p: 'https://evil.com/x', u: 'javascript:alert(1)', f: '123', c: 'a b' }, '');
  assert.deepEqual(bad.errors.map((e) => e.field).sort(), ['c', 'f', 'p', 'u']);
  for (const p of ['//evil.com', '/a/../b', '/a b']) assert.equal(validateFields(fields, { p }, '').errors.length, 1, p);
  const ok = validateFields(fields, { p: '/loja/collections/maes', u: 'https://cdn.exemplo.com/v.mp4', f: '55 61 99999-0000', c: 'abc10' }, '');
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.c, 'ABC10');
  assert.equal(ok.value.f, '5561999990000');
});

test('identidade: contraste mínimo', () => {
  assert.deepEqual(validateIdentity(DEFAULT_IDENTITY).errors, []);
  const r = validateIdentity({ ...DEFAULT_IDENTITY, text: '#F0F0F0', surface: '#FFFFFF' });
  assert.ok(r.errors.some((e) => e.field === 'identity.text'));
});

test('publicação: módulo não liberado e cupom vencido são barrados', () => {
  const c = defaultConfig();
  c.modules.coupons = { enabled: true, settings: { ...c.modules.coupons!.settings, campaigns: [coupon({ endsAt: '2020-01-01T00:00:00-03:00' })] } };
  assert.ok(publishErrors(c, new Set(), Date.now()).some((e) => /não liberado/.test(e.message)));
  assert.ok(publishErrors(c, all, Date.now()).some((e) => /já terminou/.test(e.message)));
});

test('projeção pública: só ligados e liberados, sem base do assistente nem notas', () => {
  const c = defaultConfig();
  c.modules.coupons = { enabled: true, settings: { ...c.modules.coupons!.settings, campaigns: [coupon()] } };
  c.modules.assistant = { enabled: true, settings: { ...c.modules.assistant!.settings, knowledge: [{ topic: 'entrega', question: 'Prazo?', answer: 'RESPOSTA-SECRETA', keywords: '' }] } };
  c.modules.share = { enabled: false, settings: c.modules.share!.settings };
  const pub = toPublicConfig(store, 3, new Date().toISOString(), parseStoreConfig(c).value, new Set(['coupons', 'assistant']));
  assert.deepEqual(Object.keys(pub.modules).sort(), ['assistant', 'coupons']);
  assert.doesNotMatch(JSON.stringify(pub), /RESPOSTA-SECRETA|knowledge/);
  const onlyCoupons = toPublicConfig(store, 3, new Date().toISOString(), parseStoreConfig(c).value, new Set(['coupons']));
  assert.deepEqual(Object.keys(onlyCoupons.modules), ['coupons'], 'não liberado não vai para a loja');
  assert.equal(parsePublicConfig(pub, 'loja-a')?.version, 3);
});

test('camada pública rejeita adulteração', () => {
  const c = defaultConfig();
  c.modules.coupons = { enabled: true, settings: { ...c.modules.coupons!.settings, campaigns: [coupon()] } };
  const pub = toPublicConfig(store, 1, new Date().toISOString(), parseStoreConfig(c).value, all);
  const tamper = (fn: (x: any) => void) => {
    const x = structuredClone(pub) as any;
    fn(x);
    return parsePublicConfig(x, 'loja-a');
  };
  assert.equal(parsePublicConfig(pub, 'outra-loja'), null);
  assert.equal(tamper((x) => (x.modules.coupons.settings.campaigns[0].title = '<b>oi</b>')), null);
  assert.equal(tamper((x) => (x.modules.desconhecido = { pages: ['home'], devices: ['mobile'], settings: {} })), null);
  assert.equal(tamper((x) => (x.modules.coupons.pages = ['checkout'])), null);
  assert.equal(tamper((x) => (x.schemaVersion = 1)), null);
});

test('páginas da INK e decisão de injeção', () => {
  assert.equal(classifyPage('/loja', '/loja'), 'home');
  assert.equal(classifyPage('/loja/', '/loja'), 'home');
  assert.equal(classifyPage('/loja/product/camiseta-x', '/loja'), 'product');
  assert.equal(classifyPage('/loja/products', '/loja'), 'listing');
  assert.equal(classifyPage('/loja/collections/maes', '/loja'), 'listing');
  assert.equal(classifyPage('/loja/about', '/loja'), 'other');
  assert.equal(classifyPage('/outra/product/x', '/loja'), 'other');
  const c = defaultConfig();
  c.modules.gallery = { enabled: true, settings: c.modules.gallery!.settings };
  const pub = toPublicConfig(store, 1, new Date().toISOString(), parseStoreConfig(c).value, all);
  assert.equal(hasModuleFor(pub, 'product'), true);
  assert.equal(hasModuleFor(pub, 'home'), false, 'galeria não injeta na home');
});
