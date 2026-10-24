// Percurso completo em Chrome real, com o ambiente inteiro (Node + Worker
// local) e dados em diretório temporário. Grava vídeo e capturas em docs/.
// A terceira loja (Vista Entre Nós, loja INK real do dono) é criada pelo
// painel e lida pelo proxy local SÓ com GET. Requer rede. Analytics bloqueado.
// Uso: npm run e2e   (com npm run dev PARADO: usa as mesmas portas)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const PANEL = 'http://127.0.0.1:4000/';
const SHOTS = 'docs/capturas';
const VIDEO_DIR = 'docs/demo';
// Senha descartável: o e2e usa banco temporário.
const OP = { email: 'gabriel@local.invalid', password: `e2e-${Math.random().toString(36).slice(2)}-${Date.now()}` };
const VISTA = 'http://vistaentrenos.localhost:8787';
const DESKTOP = { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' };
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce' };
const ANALYTICS = /googletagmanager|google-analytics|facebook|segment\.(io|com)|konduto|k-analytix|cloudflareinsights|tiktok|pinterest|doubleclick|apis\.google\.com|analytics-bloqueado/;

const results = [];
// Interruptores do painel: o input fica sob o desenho; clicar no próprio input dispara o mesmo "change".
const setSwitch = (loc, on) => loc.evaluate((el, v) => el.checked !== v && el.click(), on);
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const busy = (port) =>
  new Promise((resolve) => {
    const s = createConnection({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
for (const p of [4000, 4001, 4101, 4102, 8787]) {
  if (await busy(p)) {
    console.error(`Porta ${p} ocupada. Pare o npm run dev antes do e2e.`);
    process.exit(2);
  }
}

const dataDir = mkdtempSync(join(tmpdir(), 'pink-e2e-'));
const env = { ...process.env, DATA_DIR: dataDir, OPERATOR_EMAIL: OP.email, OPERATOR_NAME: 'Gabriel', OPERATOR_PASSWORD: OP.password };
const procs = [spawn(process.execPath, ['src/platform/main.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] }), spawn('npx', ['wrangler', 'dev', '--log-level', 'error'], { env: { ...env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })];
async function waitFor(url, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout ${url}`);
}

mkdirSync(SHOTS, { recursive: true });
mkdirSync(VIDEO_DIR, { recursive: true });
let browser;
try {
  await waitFor(PANEL);
  await waitFor('http://127.0.0.1:8787/');
  execFileSync(process.execPath, ['scripts/demo-setup.mjs'], { env, stdio: 'inherit' });

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const newCtx = async (opts) => {
    const c = await browser.newContext(opts);
    await c.route(ANALYTICS, (r) => r.abort());
    c.on('page', (p) => {
      p.on('dialog', (d) => d.accept());
      p.on('pageerror', (e) => pageErrors.push(`${p.url()}: ${e.message}`));
    });
    return c;
  };
  const pageErrors = [];
  const op = await newCtx({ ...DESKTOP, recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } } });
  const panel = await op.newPage();
  const flash = async (re) => {
    await panel.waitForFunction((src) => new RegExp(src).test(document.getElementById('flash')?.textContent ?? ''), re.source, { timeout: 20000 });
    return panel.textContent('#flash');
  };

  // ---------------------------------------------------------------- operador
  await panel.goto(PANEL);
  await panel.fill('#login-email', OP.email);
  await panel.fill('#login-pass', OP.password);
  await panel.click('button[type=submit]');
  await panel.waitForSelector('.store-list');
  check('Operador entra e vê as lojas', (await panel.locator('.store-row').count()) === 2);
  await panel.screenshot({ path: `${SHOTS}/r2-painel-lojas.png` });
  await panel.goto(PANEL + '#/pacotes');
  await panel.waitForSelector('.pkg-grid');
  await panel.screenshot({ path: `${SHOTS}/r2-painel-pacotes.png`, fullPage: true });

  // Terceira loja pelo formulário
  await panel.goto(PANEL + '#/lojas/nova');
  await panel.waitForSelector('#ns-name');
  await panel.fill('#ns-name', 'Vista Entre Nós');
  await panel.fill('#ns-id', 'vista-entre-nos');
  await panel.fill('#ns-ownerName', 'Gabriel Tomazi');
  await panel.fill('#ns-ownerEmail', 'loja@vistaentrenos.com.br');
  await panel.fill('#ns-domain', 'www.vistaentrenos.com.br');
  await panel.fill('#ns-basePath', '/vistaentrenos');
  await panel.fill('#ns-devHost', 'vistaentrenos.localhost');
  await panel.getByLabel('Cor principal', { exact: true }).fill('#50313D');
  await panel.getByLabel('Cor de destaque', { exact: true }).fill('#9A3B5B');
  await panel.getByLabel('Fundo claro', { exact: true }).fill('#F3E7CF');
  await panel.getByLabel('Texto', { exact: true }).fill('#2A1A1D');
  await panel.check('input[name=pkg][value=vitrine]');
  await panel.check('input[name=pkg][value=conversao]');
  await panel.screenshot({ path: `${SHOTS}/r2-painel-nova-loja.png`, fullPage: true });
  await panel.click('button:has-text("Cadastrar loja")');
  await panel.waitForURL(/#\/lojas\/vista-entre-nos\/operacao/, { timeout: 15000 });
  await panel.waitForSelector('.checks');
  check('Terceira loja criada pelo painel (sem editar arquivos)', true);

  await panel.fill('#u-name', 'Lojista Vista');
  await panel.fill('#u-email', 'lojista@vistaentrenos.com.br');
  await panel.click('button:has-text("Criar acesso e gerar convite")');
  await panel.waitForSelector('.invite-out input');
  const inviteUrl = await panel.inputValue('.invite-out input');
  check('Convite do lojista gerado', /#\/convite\//.test(inviteUrl));
  await panel.screenshot({ path: `${SHOTS}/r2-painel-operacao.png`, fullPage: true });

  // ---------------------------------------------------------------- lojista
  const mer = await newCtx({ ...DESKTOP, recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } } });
  const ed = await mer.newPage();
  await ed.goto(inviteUrl);
  await ed.fill('#inv-pass', 'senha-do-lojista-vista');
  await ed.click('button[type=submit]');
  await ed.waitForURL(/#\/lojas\/vista-entre-nos$/, { timeout: 15000 });
  await ed.waitForSelector('.nav-item');
  check('Lojista aceita o convite e cai direto na própria loja', true);
  const navTexts = await ed.locator('.nav-item').allTextContents();
  check('Módulos não liberados aparecem bloqueados', navTexts.some((t) => /M08.*não liberado/.test(t)) && navTexts.some((t) => /M05/.test(t) && !/não liberado/.test(t)));

  const frame = ed.frameLocator('.preview-iframe');
  const edFlash = async (re) => {
    await ed.waitForFunction((src) => new RegExp(src).test(document.getElementById('flash')?.textContent ?? ''), re.source, { timeout: 30000 });
    return ed.textContent('#flash');
  };

  // M05 pelo formulário gerado
  await ed.click('.nav-item:has-text("M05")');
  await setSwitch(ed.locator('#mod-enabled'), true);
  await ed.click('button:has-text("+ Campanha")');
  const camp = ed.locator('.field-list .item').first();
  await camp.getByLabel('Título').fill('10% na primeira compra');
  await camp.getByLabel('Código do cupom').fill('entrenos10');
  await camp.getByLabel('Condições de uso').fill('Teste local: cupom de demonstração; confirme o código real na INK antes de divulgar.');
  await setSwitch(camp.getByLabel('Mostrar selo perto do preço (cards e página do produto)'), true);
  await camp.getByLabel('Texto do selo').fill('10% na 1ª compra');
  await frame.locator('[data-pink-module="coupons"]:not([data-pink-badge])').waitFor({ state: 'attached', timeout: 30000 }).catch(async (err) => {
    const fr = ed.frames().find((f) => f !== ed.mainFrame());
    console.log('prévia:', fr?.url(), await fr?.evaluate(() => JSON.stringify(window.PersonalizacoesInk?.state())).catch((e) => e.message), await ed.textContent('.preview-note'));
    throw err;
  });
  check('Prévia ao vivo mostra o cupom antes de salvar (sobre a página real)', true);
  await ed.screenshot({ path: `${SHOTS}/r2-painel-editor-cupom.png` });
  await setSwitch(ed.locator('#mod-enabled'), false);
  await ed.waitForTimeout(800);
  check('Prévia esconde o módulo desativado no rascunho (correção da rodada 1)', (await frame.locator('[data-pink-module="coupons"]:not([data-pink-badge])').count()) === 0);
  await setSwitch(ed.locator('#mod-enabled'), true);

  // M02
  await ed.click('.nav-item:has-text("M02")');
  await setSwitch(ed.locator('#mod-enabled'), true);
  await ed.click('button:has-text("+ Aba")');
  let tab = ed.locator('.field-list .item').nth(0);
  await tab.getByLabel('Nome da aba').fill('Mães');
  await tab.getByLabel('Coleção ou listagem').fill('/vistaentrenos/collections/maes');
  await ed.click('button:has-text("+ Aba")');
  tab = ed.locator('.field-list .item').nth(1);
  await tab.getByLabel('Nome da aba').fill('Pais');
  await tab.getByLabel('Coleção ou listagem').fill('/vistaentrenos/collections/pais');
  // M03 e M12 com os padrões
  await ed.click('.nav-item:has-text("M03")');
  await setSwitch(ed.locator('#mod-enabled'), true);
  await ed.click('.nav-item:has-text("M12")');
  await setSwitch(ed.locator('#mod-enabled'), true);

  await ed.click('.head-actions button:has-text("Salvar rascunho")');
  check('Salvar rascunho', /Rascunho salvo/.test(await edFlash(/Rascunho salvo|não foi salvo/)));
  check('Rascunho salvo não muda a loja', !(await (await fetch(`${VISTA}/vistaentrenos`)).text()).includes('data-pink-loader'));
  await ed.click('.head-actions button:has-text("Publicar")');
  const published = await edFlash(/publicada|Não publicado/);
  check('Publicar', /Versão 1 publicada/.test(published), published);

  // ---------------------------------------------------------------- loja real pelo proxy
  const shop = await newCtx(DESKTOP);
  const store = await shop.newPage();
  const pinkFetches = [];
  store.on('request', (r) => r.headers()['x-pink-fetch'] && pinkFetches.push(new URL(r.url()).pathname));
  await store.goto(`${VISTA}/vistaentrenos`, { waitUntil: 'load' });
  await store.waitForSelector('[data-pink-module="categoryTabs"]', { state: 'attached', timeout: 20000 });
  await store.waitForTimeout(2500);
  const homeState = await store.evaluate(() => window.PersonalizacoesInk.state());
  check('Loja real (proxy): M05 e M02 montados na home', ['coupons', 'categoryTabs'].every((m) => homeState.mounted.includes(m)), JSON.stringify(homeState.mounted));
  const tabCards = await store.evaluate(() => document.querySelector('[data-pink-module="categoryTabs"]').shadowRoot.querySelectorAll('.card').length);
  check('M02 lê produtos reais da coleção', tabCards > 0, `${tabCards} produtos`);
  await store.screenshot({ path: `${SHOTS}/r2-vista-home-desktop.png` });
  await store.goto(`${VISTA}/vistaentrenos/product/vo-minha-maior-riqueza`, { waitUntil: 'load' });
  await store.waitForTimeout(3500);
  const pdpState = await store.evaluate(() => window.PersonalizacoesInk.state());
  check('Loja real: M03, M05 e M12 no produto', ['gallery', 'coupons', 'delivery'].every((m) => pdpState.mounted.includes(m)), JSON.stringify(pdpState.mounted));
  const badge = await store.evaluate(() => document.querySelector('form[id^="form-product-"] [data-pink-badge]')?.textContent ?? '');
  check('Loja real: selo de 1ª compra perto do preço', badge === '10% na 1ª compra', badge);
  const thumbs = await store.evaluate(() => document.querySelector('[data-pink-module="gallery"]')?.shadowRoot?.querySelectorAll('button').length ?? 0);
  check('Loja real: miniaturas das fotos do produto', thumbs > 1, `${thumbs} miniaturas`);
  // M12 com o formulário de CEP da própria INK (GET)
  const cepRoot = store.locator('[data-pink-module="delivery"]');
  if (await cepRoot.count()) {
    const hasCalc = await store.evaluate(() => !!document.querySelector('[data-pink-module="delivery"]').shadowRoot.querySelector('input'));
    if (hasCalc) {
      await store.evaluate(() => {
        const r = document.querySelector('[data-pink-module="delivery"]').shadowRoot;
        const i = r.querySelector('input');
        i.value = '01001-000';
        r.querySelector('form').requestSubmit();
      });
      await store.waitForFunction(() => /cálculo da INK|não devolveu/.test(document.querySelector('[data-pink-module="delivery"]').shadowRoot.textContent), null, { timeout: 20000 }).catch(() => null);
      const res = await store.evaluate(() => document.querySelector('[data-pink-module="delivery"]').shadowRoot.querySelector('.res')?.textContent ?? '');
      check('M12: data de entrega real da INK para o CEP 01001-000', /Entrega entre/.test(res), res.slice(0, 120));
    } else check('M12: calculadora disponível', false, 'formulário da INK não encontrado');
  }
  await store.screenshot({ path: `${SHOTS}/r2-vista-produto-desktop.png`, fullPage: true });
  check('Leituras de páginas pelos módulos (home + produto)', true, `${pinkFetches.length}: ${[...new Set(pinkFetches)].join(', ')}`);

  const mob = await newCtx(MOBILE);
  const mstore = await mob.newPage();
  await mstore.goto(`${VISTA}/vistaentrenos`, { waitUntil: 'load' });
  await mstore.waitForTimeout(3000);
  check('Celular: sem rolagem horizontal', (await mstore.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);
  await mstore.screenshot({ path: `${SHOTS}/r2-vista-home-mobile.png` });
  await mstore.goto(`${VISTA}/vistaentrenos/product/vo-minha-maior-riqueza`, { waitUntil: 'load' });
  await mstore.waitForTimeout(3000);
  await mstore.screenshot({ path: `${SHOTS}/r2-vista-produto-mobile.png`, fullPage: true });

  // ---------------------------------------------------------------- desligar e restaurar
  await ed.click('.nav-item:has-text("M05")');
  await ed.click('button:has-text("Desligar na loja agora")');
  await edFlash(/desligado na loja/);
  await store.goto(`${VISTA}/vistaentrenos`, { waitUntil: 'load' });
  await store.waitForTimeout(2500);
  check('Desligar M05 tira o cupom da loja (os outros ficam)', (await store.locator('[data-pink-module="coupons"]:not([data-pink-badge])').count()) === 0 && (await store.locator('[data-pink-module="categoryTabs"]').count()) === 1);
  await ed.click('.nav-item:has-text("Publicações")');
  await ed.waitForSelector('table');
  await ed.screenshot({ path: `${SHOTS}/r2-painel-publicacoes.png` });
  await ed.click('tr:has-text("v1") button:has-text("Restaurar")');
  await edFlash(/restaurada/);
  await store.goto(`${VISTA}/vistaentrenos`, { waitUntil: 'load' });
  await store.waitForSelector('[data-pink-module="coupons"]:not([data-pink-badge])', { state: 'attached', timeout: 15000 }).catch(() => null);
  check('Restaurar a versão 1 traz o cupom de volta', (await store.locator('[data-pink-module="coupons"]:not([data-pink-badge])').count()) === 1);

  // Identidade e Vídeos (telas) + painel no celular
  await ed.click('.nav-item:has-text("Identidade")');
  await ed.screenshot({ path: `${SHOTS}/r2-painel-identidade.png` });
  const medit = await mer.newPage();
  await medit.setViewportSize({ width: 390, height: 844 });
  await medit.goto(`${PANEL}#/lojas/vista-entre-nos`);
  await medit.waitForSelector('.side-select');
  await medit.selectOption('.side-select', 'm:coupons');
  await medit.waitForSelector('#mod-enabled', { state: 'attached' });
  check('Painel no celular: seções num seletor, formulário logo abaixo', true);
  await medit.screenshot({ path: `${SHOTS}/r2-painel-mobile.png`, fullPage: false });

  // Operador: instalação depois da publicação
  await panel.goto(PANEL + '#/lojas/vista-entre-nos/operacao');
  await panel.reload();
  await panel.waitForSelector('.check-row', { timeout: 30000 });
  const proxyCheck = await panel.locator('.check-row:has-text("Worker local")').textContent();
  check('Instalação: Worker local insere o carregador na loja', /inserido/.test(proxyCheck ?? ''), proxyCheck?.replace(/\s+/g, ' ').slice(0, 120));
  await panel.screenshot({ path: `${SHOTS}/r2-painel-instalacao.png`, fullPage: true });

  // ---------------------------------------------------------------- vídeo enviado pelo painel (M08)
  await panel.goto(PANEL + '#/lojas/demo-trilha');
  await panel.waitForSelector('.nav-item');
  await panel.click('.nav-item:has-text("Vídeos")');
  await panel.click('button:has-text("+ Vídeo")');
  const vcard = panel.locator('.video-card').last();
  await vcard.getByLabel('Título').first().fill('Vídeo enviado pelo painel');
  await vcard.locator('input[type=file][accept^="video"]').setInputFiles('test/fixtures/media/demo-sintetico.mp4');
  await panel.waitForFunction(() => [...document.querySelectorAll('.video-card')].pop()?.querySelector('input.mono')?.value.startsWith('/__pink/media/'), null, { timeout: 30000 });
  await panel.click('.nav-item:has-text("M08")');
  await panel.click('.video-opt label:has-text("Vídeo enviado pelo painel")');
  await panel.click('.head-actions button:has-text("Salvar rascunho")');
  await flash(/Rascunho salvo|não foi salvo/);
  await panel.click('.head-actions button:has-text("Publicar")');
  check('Vídeo enviado pelo painel e vinculado no M08 é publicado', /publicada/.test(await flash(/publicada|Não publicado/)));
  await panel.screenshot({ path: `${SHOTS}/r2-painel-videos.png` });

  // ---------------------------------------------------------------- lojas demo (réplica)
  const demo = await newCtx(DESKTOP);
  const d = await demo.newPage();
  await d.goto('http://demo-aurora.localhost:8787/vistaentrenos', { waitUntil: 'load', timeout: 60000 });
  await d.waitForTimeout(3000);
  await d.evaluate(() => document.querySelector('[data-pink-module="reviews"]')?.scrollIntoView());
  await d.waitForTimeout(800);
  await d.screenshot({ path: `${SHOTS}/r2-demo-aurora-avaliacoes.png` });
  await d.goto('http://demo-trilha.localhost:8787/vistaentrenos', { waitUntil: 'load' });
  await d.waitForTimeout(4000);
  const cards = await d.evaluate(() => document.querySelector('[data-pink-module="videoCards"]')?.shadowRoot?.querySelectorAll('.card').length ?? 0);
  check('Trilha mostra o vídeo novo (3 cards)', cards === 3, `${cards} cards`);
  await d.screenshot({ path: `${SHOTS}/r2-demo-trilha-videos-assistente.png` });
  const launch = await d.evaluate(() => {
    const r = document.querySelector('[data-pink-module="assistant"]').shadowRoot;
    r.querySelector('.launch').click();
    r.querySelector('.chip')?.click();
    return true;
  });
  await d.waitForTimeout(1500);
  check('M10 responde pela base da loja', launch && /Exemplo fictício/.test(await d.evaluate(() => document.querySelector('[data-pink-module="assistant"]').shadowRoot.textContent)));
  await d.evaluate(() => {
    const r = document.querySelector('[data-pink-module="assistant"]').shadowRoot;
    r.querySelector('input').value = 'tem estampa de mãe?';
    r.querySelector('form').requestSubmit();
  });
  await d.waitForTimeout(2500);
  const found = await d.evaluate(() => {
    const r = document.querySelector('[data-pink-module="assistant"]').shadowRoot;
    return { prods: r.querySelectorAll('.prod').length, colecao: [...r.querySelectorAll('a.act')].some((a) => /Coleção Mães/.test(a.textContent) && a.getAttribute('href').endsWith('/collections/maes')) };
  });
  check('M10 procura por estampa: produtos da loja e a coleção "Mães"', found.prods > 0 && found.colecao, JSON.stringify(found));
  await d.screenshot({ path: `${SHOTS}/r2-demo-trilha-assistente-aberto.png` });
  await d.goto('http://demo-trilha.localhost:8787/vistaentrenos/product/vo-minha-maior-riqueza', { waitUntil: 'load' });
  await d.waitForTimeout(3000);
  await d.waitForSelector('[data-pink-module="videoCards"]', { state: 'attached', timeout: 15000 });
  await d.evaluate(() => document.querySelector('[data-pink-module="videoCards"]').shadowRoot.querySelector('.card').click());
  await d.waitForTimeout(1500);
  check('M08: vídeo do produto abre com a peça vinculada', /Ver peça|Vó, Minha Maior Riqueza/.test(await d.evaluate(() => document.querySelector('[data-pink-module="video-player"]')?.shadowRoot?.textContent ?? '')));
  await d.screenshot({ path: `${SHOTS}/r2-demo-trilha-player.png` });

  check('Sem erros de JavaScript dos módulos', !pageErrors.some((e) => /personalizacoes|pink/i.test(e)), pageErrors.filter((e) => /pink/i.test(e)).slice(0, 3).join(' | '));
  const vOp = panel.video();
  const vMer = ed.video();
  await op.close();
  await mer.close();
  await vOp?.saveAs(join(VIDEO_DIR, 'demo-operador.webm'));
  await vMer?.saveAs(join(VIDEO_DIR, 'demo-lojista.webm'));
  await vOp?.delete();
  await vMer?.delete();
} catch (err) {
  check('Execução do roteiro', false, err.stack ?? String(err));
} finally {
  await browser?.close();
  for (const p of procs) p.kill('SIGTERM');
  rmSync(dataDir, { recursive: true, force: true });
  for (const f of readdirSync(VIDEO_DIR)) if (f.endsWith('.webm') && !f.startsWith('demo-')) rmSync(join(VIDEO_DIR, f));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificações ok. Capturas em ${SHOTS}/, vídeos em ${VIDEO_DIR}/`);
process.exit(failed.length ? 1 : 0);
