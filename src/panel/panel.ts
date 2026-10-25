// Painel: operador (lojas, liberação, acessos, instalação, pacotes) e lojista
// (identidade, módulos, vídeos, publicação, restauração, prévia ao vivo).
import '../shared/modules/index.ts';
import { DEFAULT_IDENTITY, IDENTITY_FIELDS, type Identity } from '../shared/identity.ts';
import { contrastRatio, withDefaults, type Field, type FieldError, type Values } from '../shared/fields.ts';
import type { IntegrationStatus, SiteCoupon } from '../platform/integration.ts';
import { promotionSummary, promotionToCampaign, promotionToIncentive, SCOPE_TEXT, tierLines, type InkPromotion } from '../shared/ink-promotions.ts';
import { moduleDef, moduleDefs, parseStoreConfig, toPublicConfig, type StoreConfig, type Video } from '../shared/registry.ts';
import { api, ApiError, setCsrf } from './api.ts';
import { buildForm, h, type FormHandle } from './form.ts';
import { list } from '../shared/modules/common.ts';

// ------------------------------------------------------------------ tipos

interface User {
  id: number;
  email: string;
  name: string;
  role: 'operator' | 'merchant';
  storeId: string | null;
}
interface Pkg {
  id: string;
  name: string;
  description: string;
  modules: string[];
}
interface Summary {
  id: string;
  name: string;
  status: string;
  kind: string;
  domain: string;
  packages: string[];
  entitled: string[];
  published: { version: number; publishedAt: string; enabled: string[] } | null;
  draftPending: boolean;
  storeUrl: string;
}
interface HistoryEntry {
  version: number;
  publishedAt: string;
  action: string;
  note: string;
  publishedBy: string | null;
  enabledModules: string[];
}
interface StoreView {
  store: Record<string, unknown> & { id: string; name: string; basePath: string; domain: string; status: string; kind: string; packages: string[] };
  entitled: string[];
  draft: { config: StoreConfig; updatedAt: string };
  published: { version: number; publishedAt: string; action: string; config: StoreConfig } | null;
  draftMatchesPublished: boolean;
  history: HistoryEntry[];
  storeUrl: string;
  media: { id: string; kind: string; url: string; originalName: string }[];
  role: 'operator' | 'merchant';
}

// ----------------------------------------------------------------- estado

const app = document.getElementById('app')!;
const topbar = document.getElementById('topbar-user')!;
let user: User | null = null;
let packages: Pkg[] = [];
let leaveGuard: (() => boolean) | null = null;

const fmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' });
const when = (iso: string) => fmt.format(new Date(iso));
const canonical = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

function flash(message: string, tone: 'ok' | 'error' | 'info' = 'ok'): void {
  const el = document.getElementById('flash')!;
  el.textContent = message;
  el.dataset.tone = tone;
  el.hidden = false;
  clearTimeout((el as unknown as { t?: number }).t);
  if (tone !== 'error') (el as unknown as { t?: number }).t = window.setTimeout(() => (el.hidden = true), 7000);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Erro inesperado.';
}

async function busy<T>(button: HTMLButtonElement | null, label: string, fn: () => Promise<T>): Promise<T | undefined> {
  const before = button?.textContent ?? '';
  if (button) {
    button.disabled = true;
    button.textContent = label;
    button.setAttribute('aria-busy', 'true');
  }
  try {
    return await fn();
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = before;
      button.removeAttribute('aria-busy');
    }
  }
}

function crumbs(...parts: (string | [string, string])[]): HTMLElement {
  const nav = h('nav', { class: 'crumbs', 'aria-label': 'Caminho' });
  parts.forEach((p, i) => {
    if (i) nav.append(h('span', { 'aria-hidden': 'true' }, '/'));
    nav.append(typeof p === 'string' ? h('span', { 'aria-current': 'page' }, p) : h('a', { href: p[1] }, p[0]));
  });
  return nav;
}

// ------------------------------------------------------------------ rotas

async function route(): Promise<void> {
  const hash = location.hash || '#/';
  if (leaveGuard && !leaveGuard()) return;
  leaveGuard = null;
  document.getElementById('flash')!.hidden = true;
  const invite = /^#\/convite\/([A-Za-z0-9_-]+)$/.exec(hash);
  if (invite) return viewInvite(invite[1]!);
  if (!user) {
    try {
      const s = await api<{ user: User; csrf: string }>('/api/session');
      user = s.user;
      setCsrf(s.csrf);
    } catch {
      return viewLogin();
    }
  }
  renderUser();
  if (user.role === 'merchant' && !hash.startsWith(`#/lojas/${user.storeId}`)) {
    location.hash = `#/lojas/${user.storeId}`;
    return;
  }
  const m = /^#\/lojas\/([a-z0-9-]+)(\/operacao)?$/.exec(hash);
  try {
    if (hash === '#/' || hash === '#/lojas') return await viewStores();
    if (hash === '#/lojas/nova') return viewNewStore();
    if (hash === '#/pacotes') return await viewPackages();
    if (m && m[2]) return await viewOperation(m[1]!);
    if (m) return await viewEditor(m[1]!);
    app.replaceChildren(h('p', { class: 'empty' }, 'Página não encontrada.'));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      user = null;
      return viewLogin();
    }
    app.replaceChildren(h('div', { class: 'card' }, h('h1', {}, 'Não foi possível abrir'), h('p', {}, errorText(err))));
  }
}

function renderUser(): void {
  topbar.replaceChildren();
  if (!user) return;
  const out = h('button', { type: 'button', class: 'link-btn' }, 'Sair');
  out.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST', json: {} }).catch(() => undefined);
    user = null;
    location.hash = '#/';
    void route();
  });
  const nav = user.role === 'operator' ? [h('a', { href: '#/lojas' }, 'Lojas'), h('a', { href: '#/pacotes' }, 'Pacotes')] : [];
  topbar.append(...nav, h('span', { class: 'who' }, `${user.name} · ${user.role === 'operator' ? 'operador' : 'lojista'}`), out);
}

// ---------------------------------------------------------- acesso

function viewLogin(): void {
  renderUser();
  const email = h('input', { id: 'login-email', type: 'email', autocomplete: 'username', required: true });
  const pass = h('input', { id: 'login-pass', type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Entrar');
  const err = h('p', { class: 'err', role: 'alert' });
  const form = h(
    'form',
    { class: 'card auth' },
    h('h1', {}, 'Entrar no painel'),
    h('div', { class: 'field' }, h('label', { for: 'login-email' }, 'E-mail'), email),
    h('div', { class: 'field' }, h('label', { for: 'login-pass' }, 'Senha'), pass),
    err,
    btn,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    await busy(btn, 'Entrando…', async () => {
      try {
        const s = await api<{ user: User; csrf: string }>('/api/login', { method: 'POST', json: { email: email.value, password: pass.value } });
        user = s.user;
        setCsrf(s.csrf);
        location.hash = s.user.role === 'merchant' ? `#/lojas/${s.user.storeId}` : '#/lojas';
        void route();
      } catch (e2) {
        err.textContent = errorText(e2);
      }
    });
  });
  app.replaceChildren(form);
  email.focus();
}

async function viewInvite(token: string): Promise<void> {
  renderUser();
  let info: { name: string; email: string; role: string };
  try {
    info = await api(`/api/invites/${token}`);
  } catch (err) {
    app.replaceChildren(h('div', { class: 'card auth' }, h('h1', {}, 'Convite indisponível'), h('p', {}, errorText(err))));
    return;
  }
  const pass = h('input', { id: 'inv-pass', type: 'password', autocomplete: 'new-password', minlength: '10', required: true });
  const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Definir senha e entrar');
  const err = h('p', { class: 'err', role: 'alert' });
  const form = h(
    'form',
    { class: 'card auth' },
    h('h1', {}, `Olá, ${info.name}`),
    h('p', {}, `Defina a senha de acesso para ${info.email}.`),
    h('div', { class: 'field' }, h('label', { for: 'inv-pass' }, 'Nova senha (mínimo 10 caracteres)'), pass),
    err,
    btn,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await busy(btn, 'Salvando…', async () => {
      try {
        const s = await api<{ user: User; csrf: string }>(`/api/invites/${token}`, { method: 'POST', json: { password: pass.value } });
        user = s.user;
        setCsrf(s.csrf);
        location.hash = s.user.role === 'merchant' ? `#/lojas/${s.user.storeId}` : '#/lojas';
      } catch (e2) {
        err.textContent = errorText(e2);
      }
    });
  });
  app.replaceChildren(form);
  pass.focus();
}

// ------------------------------------------------------- operador: lojas

async function viewStores(): Promise<void> {
  const { stores } = await api<{ stores: Summary[] }>('/api/stores');
  const rows = stores.map((s) => {
    const status = s.published ? `Na loja: versão ${s.published.version} · ${s.published.enabled.length} módulo(s) ligado(s)` : 'Nada publicado ainda';
    return h(
      'li',
      { class: 'store-row' },
      h('div', {}, h('a', { href: `#/lojas/${s.id}`, class: 'store-name' }, s.name), h('p', { class: 'muted' }, `${s.domain} · ${s.kind === 'demo' ? 'demonstração' : 'loja INK'} · ${s.status === 'active' ? 'ativa' : s.status === 'paused' ? 'pausada' : 'em instalação'}`)),
      h('div', { class: 'store-state' }, h('span', { class: `pill ${s.published ? 'on' : ''}` }, status), s.draftPending && s.published ? h('span', { class: 'pill warn' }, 'Rascunho com mudanças') : null),
      h('div', { class: 'store-actions' }, h('a', { class: 'btn btn-small', href: `#/lojas/${s.id}` }, 'Editar'), h('a', { class: 'btn btn-small btn-quiet', href: `#/lojas/${s.id}/operacao` }, 'Operação')),
    );
  });
  app.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Lojas'), h('a', { class: 'btn btn-primary', href: '#/lojas/nova' }, 'Nova loja')),
    stores.length ? h('ul', { class: 'store-list' }, ...rows) : h('p', { class: 'empty' }, 'Nenhuma loja cadastrada.'),
  );
}

function viewNewStore(): void {
  void loadPackages().then(() => {
    const err = h('div', { class: 'error-summary', role: 'alert', hidden: true });
    const f = (key: string, label: string, attrs: Record<string, string> = {}, help = '') => {
      const id = `ns-${key}`;
      return h('div', { class: 'field', 'data-key': key }, h('label', { for: id }, label), h('input', { id, name: key, ...attrs }), help ? h('p', { class: 'help' }, help) : null, h('p', { class: 'err' }));
    };
    const identity = buildForm(IDENTITY_FIELDS, { ...DEFAULT_IDENTITY }, { identity: DEFAULT_IDENTITY, videos: [], suggestions: [], onChange: () => undefined });
    const pkgBoxes = packages.map((p) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'pkg', value: p.id }), h('span', {}, `${p.name} — ${p.modules.map((m) => moduleDef(m)?.code).join(', ')}`)));
    const extraBoxes = moduleDefs().map((d) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'extra', value: d.id }), h('span', {}, `${d.code} ${d.name}`)));
    const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Cadastrar loja');
    const form = h(
      'form',
      { class: 'stack' },
      crumbs(['Lojas', '#/lojas'], 'Nova loja'),
      h('h1', {}, 'Nova loja'),
      err,
      h('fieldset', { class: 'card' }, h('legend', {}, '1. Loja e responsável'), f('name', 'Nome da loja', { required: 'true' }), f('id', 'Identificador', { pattern: '[a-z0-9-]{3,40}', required: 'true' }, 'Letras minúsculas, números e hífen. Não muda depois.'), f('ownerName', 'Responsável'), f('ownerEmail', 'E-mail do responsável', { type: 'email' })),
      h(
        'fieldset',
        { class: 'card' },
        h('legend', {}, '2. Endereço na INK'),
        f('domain', 'Domínio da loja', { placeholder: 'www.minhaloja.com.br', required: 'true' }),
        f('basePath', 'Caminho da loja na INK', { placeholder: '/minhaloja' }, 'O trecho depois do domínio, como aparece na INK.'),
        f('devHost', 'Endereço local de teste', { placeholder: 'minhaloja.localhost' }, 'Opcional. Por padrão: <identificador>.localhost'),
        f('supportWhatsapp', 'WhatsApp de atendimento (opcional)', { type: 'tel', placeholder: '55 61 99999-0000' }),
      ),
      h('fieldset', { class: 'card' }, h('legend', {}, '3. Identidade inicial'), h('p', { class: 'help' }, 'O lojista pode ajustar depois. Os módulos usam estas cores e o logo.'), identity.el),
      h('fieldset', { class: 'card' }, h('legend', {}, '4. Módulos liberados'), h('p', { class: 'lbl' }, 'Pacotes'), ...pkgBoxes, h('p', { class: 'lbl' }, 'Módulos avulsos'), h('div', { class: 'grid-checks' }, ...extraBoxes)),
      h('div', { class: 'actionbar' }, btn, h('p', { class: 'help' }, 'Depois do cadastro: criar o acesso do lojista e conferir a instalação.')),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const val = (k: string) => (form.querySelector<HTMLInputElement>(`[name="${k}"]`)?.value ?? '').trim();
      const body = {
        store: {
          id: val('id'),
          name: val('name'),
          ownerName: val('ownerName'),
          ownerEmail: val('ownerEmail'),
          domain: val('domain'),
          basePath: val('basePath'),
          devHost: val('devHost'),
          integration: { supportWhatsapp: val('supportWhatsapp') },
          packages: [...form.querySelectorAll<HTMLInputElement>('input[name="pkg"]:checked')].map((i) => i.value),
          extraModules: [...form.querySelectorAll<HTMLInputElement>('input[name="extra"]:checked')].map((i) => i.value),
        },
        identity: identity.read(),
      };
      await busy(btn, 'Cadastrando…', async () => {
        try {
          const res = await api<{ store: { id: string } }>('/api/stores', { method: 'POST', json: body });
          location.hash = `#/lojas/${res.store.id}/operacao`;
          setTimeout(() => flash('Loja cadastrada. Agora crie o acesso do lojista e confira a instalação.'), 50);
        } catch (e2) {
          showSummary(err, e2);
          if (e2 instanceof ApiError) {
            form.querySelectorAll('.field').forEach((fl) => {
              const key = (fl as HTMLElement).dataset.key ?? '';
              const msg = e2.errors.filter((x) => x.field === key || x.field === `integration.${key}`).map((x) => x.message).join(' ');
              const pe = fl.querySelector(':scope > .err');
              if (pe) pe.textContent = msg;
              fl.classList.toggle('has-error', !!msg);
            });
            identity.showErrors(e2.errors, 'identity');
          }
        }
      });
    });
    app.replaceChildren(form);
  });
}

function showSummary(box: HTMLElement, err: unknown): void {
  box.replaceChildren();
  if (err instanceof ApiError && err.errors.length) {
    box.append(h('p', {}, err.message), h('ul', {}, ...err.errors.slice(0, 12).map((e) => h('li', {}, e.message))));
  } else box.append(h('p', {}, errorText(err)));
  box.hidden = false;
  box.focus?.();
  box.scrollIntoView({ block: 'nearest' });
}

async function loadPackages(): Promise<void> {
  packages = (await api<{ packages: Pkg[] }>('/api/packages')).packages;
}

// --------------------------------------------------- operador: operação

async function viewOperation(id: string): Promise<void> {
  const [view, users, install] = await Promise.all([
    api<StoreView>(`/api/stores/${id}`),
    api<{ users: (User & { hasPassword: boolean })[] }>(`/api/stores/${id}/users`),
    api<{ status: { id: string; label: string; state: string; detail: string }[]; artifacts: { name: string; description: string }[] }>(`/api/stores/${id}/install`),
  ]);
  await loadPackages();
  const s = view.store as unknown as Record<string, unknown> & { integration: Record<string, unknown>; extraModules: string[]; packages: string[]; basePath: string; name: string };
  const err = h('div', { class: 'error-summary', role: 'alert', hidden: true });

  // Dados e integração
  const input = (key: string, label: string, value: unknown, attrs: Record<string, string> = {}, help = '') => {
    const iid = `op-${key}`;
    const el = h('input', { id: iid, name: key, ...attrs });
    el.value = String(value ?? '');
    return h('div', { class: 'field' }, h('label', { for: iid }, label), el, help ? h('p', { class: 'help' }, help) : null);
  };
  const check = (key: string, label: string, value: unknown, help = '') =>
    h('label', { class: 'check' }, (() => {
      const c = h('input', { type: 'checkbox', name: key });
      c.checked = value === true;
      return c;
    })(), h('span', {}, label, help ? h('small', { class: 'help block' }, help) : null));
  const statusSel = h('select', { id: 'op-status', name: 'status' }, ...[['setup', 'Em instalação'], ['active', 'Ativa'], ['paused', 'Pausada (módulos fora do ar)']].map(([v, l]) => {
    const o = h('option', { value: v! }, l!);
    o.selected = s.status === v;
    return o;
  }));
  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Salvar dados');
  const dataForm = h(
    'form',
    { class: 'card stack' },
    h('h2', {}, 'Dados e integração'),
    input('name', 'Nome da loja', s.name),
    h('div', { class: 'field' }, h('label', { for: 'op-status' }, 'Situação'), statusSel),
    h('div', { class: 'two' }, input('ownerName', 'Responsável', s.ownerName), input('ownerEmail', 'E-mail do responsável', s.ownerEmail, { type: 'email' })),
    h('div', { class: 'two' }, input('domain', 'Domínio', s.domain), input('basePath', 'Caminho na INK', s.basePath)),
    input('devHost', 'Endereço local de teste', s.devHost, {}, 'Usado só pelo Worker local (proxy).'),
    h('div', { class: 'two' }, input('searchPath', 'Caminho da busca', s.integration.searchPath, { placeholder: `${s.basePath}/products` }), input('supportWhatsapp', 'WhatsApp de atendimento', s.integration.supportWhatsapp, { type: 'tel' })),
    check('turbo', 'A loja navega com Turbo Drive (sem recarregar a página)', s.integration.turbo),
    check('proxyCart', 'Proxy local: permitir adicionar/alterar itens do carrinho', s.integration.proxyCart, 'Só para homologação. Envia POST de carrinho para a loja real com a sessão. Checkout, login e pedidos continuam bloqueados.'),
    h('div', { class: 'field' }, h('label', { for: 'op-notes' }, 'Observações internas'), (() => {
      const t = h('textarea', { id: 'op-notes', name: 'notes', rows: '2' });
      t.value = String(s.notes ?? '');
      return t;
    })()),
    saveBtn,
  );

  // Liberação
  const pkgChecks = packages.map((p) => {
    const c = h('input', { type: 'checkbox', name: 'pkg', value: p.id });
    c.checked = (s.packages as string[]).includes(p.id);
    return h('label', { class: 'check' }, c, h('span', {}, h('strong', {}, p.name), ` — ${p.modules.map((m) => `${moduleDef(m)?.code} ${moduleDef(m)?.name}`).join('; ')}`));
  });
  const extraChecks = moduleDefs().map((d) => {
    const c = h('input', { type: 'checkbox', name: 'extra', value: d.id });
    c.checked = s.extraModules.includes(d.id);
    return h('label', { class: 'check' }, c, h('span', {}, `${d.code} ${d.name}`));
  });
  const entBtn = h('button', { type: 'button', class: 'btn' }, 'Salvar liberação');
  const ent = h('section', { class: 'card stack' }, h('h2', {}, 'Módulos liberados'), h('p', { class: 'help' }, `Liberados agora: ${view.entitled.map((m) => moduleDef(m)?.code).join(', ') || 'nenhum'}. Um módulo que deixa de ser liberado sai da loja na próxima leitura da configuração.`), h('p', { class: 'lbl' }, 'Pacotes'), ...pkgChecks, h('p', { class: 'lbl' }, 'Avulsos'), h('div', { class: 'grid-checks' }, ...extraChecks), entBtn);

  const collectStore = () => {
    const v = (k: string) => (dataForm.querySelector<HTMLInputElement>(`[name="${k}"]`)?.value ?? '').trim();
    const c = (k: string) => !!dataForm.querySelector<HTMLInputElement>(`[name="${k}"]`)?.checked;
    return {
      name: v('name'),
      status: statusSel.value,
      ownerName: v('ownerName'),
      ownerEmail: v('ownerEmail'),
      domain: v('domain'),
      basePath: v('basePath'),
      devHost: v('devHost'),
      notes: (dataForm.querySelector<HTMLTextAreaElement>('[name="notes"]')?.value ?? '').trim(),
      integration: { searchPath: v('searchPath'), supportWhatsapp: v('supportWhatsapp'), turbo: c('turbo'), proxyCart: c('proxyCart') },
      packages: [...ent.querySelectorAll<HTMLInputElement>('input[name="pkg"]:checked')].map((i) => i.value),
      extraModules: [...ent.querySelectorAll<HTMLInputElement>('input[name="extra"]:checked')].map((i) => i.value),
    };
  };
  const saveStore = async (btn: HTMLButtonElement) =>
    busy(btn, 'Salvando…', async () => {
      try {
        await api(`/api/stores/${id}`, { method: 'PUT', json: collectStore() });
        flash('Dados da loja salvos.');
        void route();
      } catch (e2) {
        showSummary(err, e2);
      }
    });
  dataForm.addEventListener('submit', (e) => {
    e.preventDefault();
    void saveStore(saveBtn);
  });
  entBtn.addEventListener('click', () => void saveStore(entBtn));

  // Acessos
  const inviteOut = h('div', { class: 'invite-out', 'aria-live': 'polite' });
  const showInvite = (url: string) => {
    const field = h('input', { type: 'text', readonly: true, class: 'mono', 'aria-label': 'Link de convite' });
    field.value = url;
    const copy = h('button', { type: 'button', class: 'btn btn-small' }, 'Copiar link');
    copy.addEventListener('click', async () => {
      field.select();
      await navigator.clipboard?.writeText(url).catch(() => undefined);
      copy.textContent = 'Copiado';
    });
    inviteOut.replaceChildren(h('p', {}, 'Envie este link ao lojista (vale 7 dias, uso único):'), h('div', { class: 'row' }, field, copy));
  };
  const userRows = users.users.map((u) => {
    const resend = h('button', { type: 'button', class: 'btn btn-small btn-quiet' }, 'Novo convite');
    const revoke = h('button', { type: 'button', class: 'btn btn-small btn-danger' }, 'Revogar');
    resend.addEventListener('click', async () => {
      const r = await api<{ inviteUrl: string }>(`/api/stores/${id}/users/${u.id}/invite`, { method: 'POST', json: {} });
      showInvite(r.inviteUrl);
    });
    revoke.addEventListener('click', async () => {
      await api(`/api/stores/${id}/users/${u.id}`, { method: 'DELETE', json: {} });
      flash(`Acesso de ${u.email} revogado.`);
      void route();
    });
    return h('li', { class: 'user-row' }, h('span', {}, `${u.name} · ${u.email}`), h('span', { class: `pill ${u.hasPassword ? 'on' : 'warn'}` }, u.hasPassword ? 'Acesso ativo' : 'Convite pendente'), resend, revoke);
  });
  const uName = h('input', { id: 'u-name', autocomplete: 'off' });
  const uEmail = h('input', { id: 'u-email', type: 'email', autocomplete: 'off' });
  const uBtn = h('button', { type: 'submit', class: 'btn' }, 'Criar acesso e gerar convite');
  const uForm = h('form', { class: 'two-actions' }, h('div', { class: 'field' }, h('label', { for: 'u-name' }, 'Nome'), uName), h('div', { class: 'field' }, h('label', { for: 'u-email' }, 'E-mail'), uEmail), uBtn);
  uForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await busy(uBtn, 'Criando…', async () => {
      try {
        const r = await api<{ inviteUrl: string }>(`/api/stores/${id}/users`, { method: 'POST', json: { name: uName.value, email: uEmail.value } });
        showInvite(r.inviteUrl);
        flash('Acesso criado. Envie o link ao lojista.');
      } catch (e2) {
        flash(errorText(e2), 'error');
      }
    });
  });
  const access = h('section', { class: 'card stack' }, h('h2', {}, 'Acesso do lojista'), h('p', { class: 'help' }, 'O lojista entra só na própria loja: edita, vê a prévia e publica. Integração, liberação e acessos ficam aqui.'), users.users.length ? h('ul', { class: 'user-list' }, ...userRows) : h('p', { class: 'empty' }, 'Nenhum acesso criado.'), uForm, inviteOut);

  // Instalação
  const stateLabel: Record<string, string> = { ok: 'ok', warn: 'atenção', pending: 'pendente', error: 'erro' };
  const checks = install.status.map((c) => h('li', { class: `check-row ${c.state}` }, h('span', { class: `pill ${c.state === 'ok' ? 'on' : c.state === 'error' ? 'err' : 'warn'}` }, stateLabel[c.state] ?? c.state), h('div', {}, h('strong', {}, c.label), h('p', { class: 'muted' }, c.detail))));
  const artifacts = install.artifacts.map((a) => h('li', {}, h('a', { href: `/api/stores/${id}/install/${a.name}`, download: a.name }, a.name), h('span', { class: 'muted' }, ` — ${a.description}`)));
  const recheck = h('button', { type: 'button', class: 'btn btn-small' }, 'Verificar de novo');
  recheck.addEventListener('click', () => void route());
  const installBox = h('section', { class: 'card stack' }, h('div', { class: 'row-between' }, h('h2', {}, 'Instalação'), recheck), h('ul', { class: 'checks' }, ...checks), h('p', { class: 'lbl' }, 'Artefatos gerados para esta loja'), h('ul', { class: 'artifacts' }, ...artifacts));

  app.replaceChildren(
    crumbs(['Lojas', '#/lojas'], [view.store.name, `#/lojas/${id}`], 'Operação'),
    h('div', { class: 'page-head' }, h('h1', {}, `Operação · ${view.store.name}`), h('a', { class: 'btn', href: `#/lojas/${id}` }, 'Abrir editor')),
    err,
    h('div', { class: 'op-grid' }, h('div', { class: 'stack' }, installBox, access), h('div', { class: 'stack' }, dataForm, ent)),
  );
}

// ------------------------------------------------------- operador: pacotes

async function viewPackages(): Promise<void> {
  await loadPackages();
  const card = (p: Pkg | null) => {
    const idIn = h('input', { name: 'id', placeholder: 'ex.: completo' });
    idIn.value = p?.id ?? '';
    if (p) idIn.readOnly = true;
    const name = h('input', { name: 'name' });
    name.value = p?.name ?? '';
    const desc = h('input', { name: 'description' });
    desc.value = p?.description ?? '';
    const checks = moduleDefs().map((d) => {
      const c = h('input', { type: 'checkbox', value: d.id });
      c.checked = !!p?.modules.includes(d.id);
      return h('label', { class: 'check' }, c, h('span', {}, `${d.code} ${d.name}`));
    });
    const btn = h('button', { type: 'submit', class: 'btn' }, p ? 'Salvar pacote' : 'Criar pacote');
    const form = h('form', { class: 'card stack' }, h('h2', {}, p ? p.name : 'Novo pacote'), h('div', { class: 'two' }, h('div', { class: 'field' }, h('label', {}, 'Identificador', idIn)), h('div', { class: 'field' }, h('label', {}, 'Nome', name))), h('div', { class: 'field' }, h('label', {}, 'Descrição', desc)), h('div', { class: 'grid-checks' }, ...checks), btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await busy(btn, 'Salvando…', async () => {
        try {
          await api('/api/packages', { method: 'POST', json: { id: idIn.value, name: name.value, description: desc.value, modules: [...form.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked')].map((c) => c.value) } });
          flash('Pacote salvo. Lojas com este pacote recebem a nova liberação.');
          void route();
        } catch (e2) {
          flash(errorText(e2), 'error');
        }
      });
    });
    return form;
  };
  app.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Pacotes')),
    h('p', { class: 'help' }, 'Agrupamentos de módulos para liberar às lojas. Sem preço: nomes e valores comerciais ainda não foram definidos.'),
    h('div', { class: 'pkg-grid' }, ...packages.map(card), card(null)),
  );
}

// ----------------------------------------------------------------- editor

type Section = { kind: 'module'; id: string } | { kind: 'identity' } | { kind: 'videos' } | { kind: 'history' } | { kind: 'integration' };

async function viewEditor(id: string): Promise<void> {
  let view = await api<StoreView>(`/api/stores/${id}`);
  let draft: StoreConfig = structuredClone(view.draft.config);
  let section: Section = { kind: 'identity' };
  let form: FormHandle | null = null;
  let suggestions: { label: string; path: string }[] = [];
  let lastErrors: FieldError[] = [];
  const entitled = () => new Set(view.entitled);

  const firstEntitled = moduleDefs().find((d) => view.entitled.includes(d.id));
  if (firstEntitled) section = { kind: 'module', id: firstEntitled.id };

  // Sugestões de caminhos (coleções e produtos reais da loja).
  void api<{ sections: { label: string; path: string }[] }>(`/api/stores/${id}/catalog/sections`)
    .then(async (r) => {
      suggestions = r.sections;
      const prods = await api<{ products: { title: string; path: string }[] }>(`/api/stores/${id}/catalog/products?path=${encodeURIComponent(view.store.basePath || '/')}`).catch(() => ({ products: [] }));
      suggestions = [...r.sections, ...prods.products.slice(0, 24).map((p) => ({ label: p.title, path: p.path }))];
      previewPages.product = prods.products[0]?.path ?? previewPages.product!;
      previewPages.listing = r.sections[0]?.path ?? previewPages.listing!;
    })
    .catch(() => undefined);

  const isDirty = () => canonical(draft) !== canonical(view.draft.config);
  leaveGuard = () => !isDirty() || confirm('Há alterações não salvas no rascunho. Sair mesmo assim?');
  window.onbeforeunload = (e) => (isDirty() ? e.preventDefault() : undefined);

  // ---- estrutura
  const statusLive = h('p', { class: 'status-live' });
  const statusDraft = h('p', { class: 'status-draft' });
  const saveBtn = h('button', { type: 'button', class: 'btn' }, 'Salvar rascunho');
  const pubBtn = h('button', { type: 'button', class: 'btn btn-primary' }, 'Publicar');
  const pubHint = h('p', { class: 'help hint' });
  const errBox = h('div', { class: 'error-summary', role: 'alert', tabindex: '-1', hidden: true });
  const nav = h('nav', { class: 'side', 'aria-label': 'Seções da loja' });
  const main = h('div', { class: 'editor-main' });
  const frame = h('iframe', { title: 'Prévia na loja', class: 'preview-iframe' });
  const previewNote = h('p', { class: 'help preview-note', 'aria-live': 'polite' });
  const previewPages: Record<string, string> = { home: view.store.basePath || '/', listing: `${view.store.basePath}/products`, product: `${view.store.basePath}/products` };
  const pageSel = h('select', { 'aria-label': 'Página da prévia' }, h('option', { value: 'home' }, 'Início'), h('option', { value: 'listing' }, 'Listagem'), h('option', { value: 'product' }, 'Produto'));
  const devBtns = ['Computador', 'Celular'].map((label, i) => h('button', { type: 'button', 'aria-pressed': i === 0 ? 'true' : 'false', 'data-w': i === 0 ? 'full' : '390' }, label));
  const frameBox = h('div', { class: 'preview-frame', 'data-w': 'full' }, frame);
  let previewReady = false;
  let previewOrigin = '';

  const header = h(
    'div',
    { class: 'editor-head' },
    h('div', {}, crumbs(...(user?.role === 'operator' ? [['Lojas', '#/lojas'] as [string, string]] : []), view.store.name), h('h1', {}, view.store.name), statusLive, statusDraft),
    h('div', { class: 'head-actions' }, user?.role === 'operator' ? h('a', { class: 'btn btn-quiet', href: `#/lojas/${id}/operacao` }, 'Operação') : null, h('a', { class: 'btn btn-quiet', href: view.storeUrl, target: '_blank', rel: 'noopener' }, 'Abrir loja ↗'), saveBtn, pubBtn),
  );
  const previewPane = h(
    'aside',
    { class: 'preview' },
    h('div', { class: 'preview-head' }, h('h2', {}, 'Prévia na loja'), pageSel, h('div', { class: 'seg', role: 'group', 'aria-label': 'Largura' }, ...devBtns)),
    previewNote,
    frameBox,
  );
  app.replaceChildren(header, pubHint, errBox, h('div', { class: 'editor' }, nav, main, previewPane));

  // ---- prévia
  const loadPreview = async () => {
    previewReady = false;
    try {
      const t = await api<{ token: string; storeUrl: string }>(`/api/stores/${id}/preview-token`, { method: 'POST', json: {} });
      const base = new URL(t.storeUrl);
      previewOrigin = base.origin;
      const path = previewPages[pageSel.value] ?? base.pathname;
      const u = new URL(path, base.origin);
      u.searchParams.set('__pink_preview', t.token);
      frame.src = u.href;
    } catch (err) {
      previewNote.textContent = `Prévia indisponível: ${errorText(err)}`;
    }
  };
  window.onmessage = (e: MessageEvent) => {
    if (e.origin !== previewOrigin || (e.data as { type?: string })?.type !== 'pink-preview-ready') return;
    previewReady = true;
    pushPreview();
  };
  pageSel.addEventListener('change', () => void loadPreview());
  devBtns.forEach((b) =>
    b.addEventListener('click', () => {
      devBtns.forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
      frameBox.dataset.w = b.dataset.w!;
    }),
  );

  function pushPreview(): void {
    if (!previewReady || !frame.contentWindow) return;
    const parsed = parseStoreConfig(draft);
    const cfg = toPublicConfig({ id, basePath: view.store.basePath }, 0, new Date().toISOString(), parsed.value, entitled());
    frame.contentWindow.postMessage({ type: 'pink-preview-config', config: cfg }, previewOrigin);
    const on = Object.keys(cfg.modules).length;
    previewNote.textContent = on
      ? `Prévia do rascunho atual (${on} módulo(s) ativo(s) no rascunho), sobre a página real da loja. Nada aqui está publicado.`
      : 'Nenhum módulo ativo no rascunho: a loja aparece como está.';
  }

  // ---- estado
  function renderStatus(): void {
    const p = view.published;
    const enabledLive = p ? Object.entries(p.config.modules).filter(([, m]) => m.enabled).length : 0;
    statusLive.textContent = p ? `Na loja agora: versão ${p.version}, publicada em ${when(p.publishedAt)} · ${enabledLive} módulo(s) ligado(s)` : 'Na loja agora: nada publicado';
    const dirty = isDirty();
    statusDraft.textContent = dirty
      ? 'Rascunho: alterações não salvas'
      : !p
        ? `Rascunho: salvo em ${when(view.draft.updatedAt)}, ainda não publicado`
        : view.draftMatchesPublished
          ? `Rascunho: igual à versão ${p.version}`
          : `Rascunho: alterações salvas em ${when(view.draft.updatedAt)}, ainda não publicadas`;
    statusDraft.dataset.tone = dirty ? 'warn' : view.draftMatchesPublished ? 'muted' : 'info';
    saveBtn.disabled = !dirty;
    const nothingNew = !!p && view.draftMatchesPublished;
    pubBtn.disabled = dirty || nothingNew;
    pubHint.textContent = dirty ? 'Salve o rascunho para poder publicar.' : nothingNew ? 'Nada novo para publicar.' : 'Publicar coloca o rascunho salvo na loja.';
    renderNav();
  }

  function liveState(mid: string): 'on' | 'off' | 'none' {
    const p = view.published;
    if (!p) return 'none';
    return p.config.modules[mid]?.enabled ? 'on' : 'off';
  }

  function renderNav(): void {
    const item = (label: string, sec: Section, extra: (Node | string)[] = [], disabled = false) => {
      const active =
        sec.kind === section.kind && (sec.kind !== 'module' || (section.kind === 'module' && sec.id === section.id));
      const b = h('button', { type: 'button', class: `nav-item${active ? ' active' : ''}`, 'aria-current': active ? 'true' : undefined, disabled }, h('span', { class: 'nav-label' }, label), ...extra);
      b.addEventListener('click', () => {
        if (form) readForm();
        section = sec;
        renderSection();
        renderNav();
      });
      return b;
    };
    const mods = moduleDefs().map((d) => {
      const ent = view.entitled.includes(d.id);
      const draftOn = draft.modules[d.id]?.enabled;
      const live = liveState(d.id);
      const chips: Node[] = [];
      if (!ent) chips.push(h('span', { class: 'chip muted' }, 'não liberado'));
      else {
        chips.push(h('span', { class: `chip ${live === 'on' ? 'on' : ''}` }, live === 'on' ? 'na loja' : 'fora da loja'));
        if (draftOn !== (view.published?.config.modules[d.id]?.enabled ?? false)) chips.push(h('span', { class: 'chip warn', title: 'O rascunho muda este módulo; vale ao publicar' }, draftOn ? 'liga ao publicar' : 'desliga ao publicar'));
      }
      return item(`${d.code} ${d.name}`, { kind: 'module', id: d.id }, chips, !ent);
    });
    // Celular: as seções viram um seletor compacto, para o formulário aparecer logo.
    const sel = h('select', { class: 'side-select', 'aria-label': 'Seção' });
    const opt = (label: string, value: string, selected: boolean, disabled = false) => {
      const o = h('option', { value, disabled }, label);
      o.selected = selected;
      return o;
    };
    const cur = section.kind === 'module' ? `m:${section.id}` : section.kind;
    sel.append(
      opt('Identidade', 'identity', cur === 'identity'),
      opt(`Vídeos (${draft.library.videos.length})`, 'videos', cur === 'videos'),
      opt('Publicações', 'history', cur === 'history'),
      opt('Integração com a INK', 'integration', cur === 'integration'),
      ...moduleDefs().map((d) => {
        const live = liveState(d.id);
        return opt(`${d.code} ${d.name}${view.entitled.includes(d.id) ? (live === 'on' ? ' · na loja' : '') : ' · não liberado'}`, `m:${d.id}`, cur === `m:${d.id}`, !view.entitled.includes(d.id));
      }),
    );
    sel.addEventListener('change', () => {
      if (form) readForm();
      const v = sel.value;
      section = v.startsWith('m:') ? { kind: 'module', id: v.slice(2) } : ({ kind: v } as Section);
      renderSection();
      renderNav();
    });
    nav.replaceChildren(
      sel,
      h('p', { class: 'nav-group' }, 'Loja'),
      item('Identidade', { kind: 'identity' }),
      item('Vídeos', { kind: 'videos' }, [h('span', { class: 'chip' }, String(draft.library.videos.length))]),
      item('Publicações', { kind: 'history' }),
      item('Integração', { kind: 'integration' }),
      h('p', { class: 'nav-group' }, 'Módulos'),
      ...mods,
    );
  }

  function readForm(): void {
    if (!form) return;
    if (section.kind === 'identity') draft.identity = form.read() as unknown as Identity;
    else if (section.kind === 'module') draft.modules[section.id] = { ...draft.modules[section.id]!, settings: form.read() };
  }

  function onChange(): void {
    readForm();
    renderStatus();
    if (lastErrors.length) validateNow(false);
    pushPreview();
  }

  function validateNow(focus: boolean): FieldError[] {
    const parsed = parseStoreConfig(draft);
    lastErrors = parsed.errors;
    form?.showErrors(lastErrors, section.kind === 'module' ? `modules.${section.id}` : section.kind === 'identity' ? 'identity' : '');
    if (lastErrors.length) {
      errBox.replaceChildren(h('p', {}, 'Revise antes de salvar:'), h('ul', {}, ...lastErrors.slice(0, 10).map((e) => h('li', {}, e.message))));
      errBox.hidden = false;
      if (focus) errBox.focus();
    } else errBox.hidden = true;
    return lastErrors;
  }

  // ---- seções
  function renderSection(): void {
    form = null;
    main.replaceChildren();
    if (section.kind === 'identity') {
      form = buildForm(IDENTITY_FIELDS, draft.identity as unknown as Values, { identity: draft.identity, videos: [], suggestions: [], onChange: () => {
        onChange();
        contrast();
      } });
      const contrastEl = h('p', { class: 'contrast', 'aria-live': 'polite' });
      const contrast = () => {
        const id2 = form!.read() as unknown as Identity;
        const t = contrastRatio(id2.text, id2.surface);
        const p = contrastRatio(id2.primary, id2.surface);
        contrastEl.textContent = `Contraste texto/fundo ${t.toFixed(1)}:1 (${t >= 4.5 ? 'ok' : 'baixo'}) · principal/fundo ${p.toFixed(1)}:1 (${p >= 3 ? 'ok' : 'baixo'})`;
        contrastEl.dataset.tone = t >= 4.5 && p >= 3 ? 'ok' : 'error';
      };
      contrast();
      main.append(h('section', { class: 'card stack' }, h('h2', {}, 'Identidade'), h('p', { class: 'help' }, 'Definida uma vez e usada por todos os módulos (cores por token, logo e tipografia).'), form.el, contrastEl));
    } else if (section.kind === 'module') {
      const def = moduleDef(section.id)!;
      const state = draft.modules[def.id]!;
      const toggle = h('input', { type: 'checkbox', role: 'switch', id: 'mod-enabled' });
      toggle.checked = state.enabled;
      toggle.addEventListener('change', () => {
        draft.modules[def.id] = { ...draft.modules[def.id]!, enabled: toggle.checked };
        onChange();
      });
      const live = liveState(def.id);
      const now = h('button', { type: 'button', class: `btn btn-small ${live === 'on' ? 'btn-danger' : ''}`, disabled: live === 'none' }, live === 'on' ? 'Desligar na loja agora' : 'Ligar na loja agora');
      now.addEventListener('click', () =>
        void busy(now, live === 'on' ? 'Desligando…' : 'Ligando…', async () => {
          try {
            const pendingSettings = isDirty();
            view = await api<StoreView>(`/api/stores/${id}/modules/${def.id}/state`, { method: 'POST', json: { enabled: live !== 'on' } });
            draft.modules[def.id]!.enabled = live !== 'on';
            if (!pendingSettings) draft = structuredClone(view.draft.config);
            flash(`${def.name}: ${live === 'on' ? 'desligado' : 'ligado'} na loja (versão ${view.published?.version}). O resto do rascunho não foi publicado.`);
            renderStatus();
            renderSection();
          } catch (err) {
            flash(errorText(err), 'error');
          }
        }),
      );
      form = buildForm(def.fields, state.settings, { identity: draft.identity, videos: draft.library.videos, suggestions, onChange });
      main.append(
        h(
          'section',
          { class: 'card stack' },
          h('div', { class: 'mod-head' }, h('div', {}, h('p', { class: 'code' }, def.code), h('h2', {}, def.name), h('p', { class: 'help' }, def.summary)), h('label', { class: 'switch big', for: 'mod-enabled' }, toggle, h('span', { class: 'switch-track', 'aria-hidden': 'true' }), h('span', {}, 'Ativo no rascunho'))),
          h('div', { class: 'now-row' }, h('span', { class: `pill ${live === 'on' ? 'on' : ''}` }, live === 'on' ? 'Ligado na loja' : live === 'off' ? 'Desligado na loja' : 'Nada publicado'), now, h('span', { class: 'help' }, live === 'none' ? 'Publique uma vez para poder ligar/desligar na hora.' : 'Liga ou desliga só este módulo na versão publicada, sem publicar o resto do rascunho.')),
          user?.role === 'operator' && def.integrations.length ? h('p', { class: 'help' }, `Depende de: ${def.integrations.join(', ')}.`) : null,
          form.el,
        ),
      );
      if (def.id === 'reviews') void reviewsHelp(main);
    } else if (section.kind === 'videos') {
      renderVideos();
    } else if (section.kind === 'integration') {
      void renderIntegration();
    } else {
      renderHistory();
    }
    if (lastErrors.length) form?.showErrors(lastErrors, section.kind === 'module' ? `modules.${section.id}` : 'identity');
  }

  async function reviewsHelp(container: HTMLElement): Promise<void> {
    const box = h('section', { class: 'card stack' }, h('h3', {}, 'Avaliações publicadas na loja (fonte: INK)'), h('p', { class: 'help' }, 'Carregando…'));
    container.append(box);
    try {
      const r = await api<{ reviews: { id: string; author: string; date: string; rating: number; text: string }[]; photos: { reviewImageId: string; imageUrl: string }[] }>(`/api/stores/${id}/catalog/reviews`);
      if (!r.reviews.length && !r.photos.length) {
        box.replaceChildren(h('h3', {}, 'Avaliações publicadas na loja (fonte: INK)'), h('p', { class: 'help' }, 'A loja ainda não tem avaliações publicadas na INK. O módulo não mostra nada até existirem avaliações.'));
        return;
      }
      box.replaceChildren(
        h('h3', {}, 'Avaliações publicadas na loja (fonte: INK)'),
        h('p', { class: 'help' }, `${r.reviews.length} depoimento(s) nesta página e ${r.photos.length} foto(s). Para a seleção editorial, use a referência "avaliacao-<número>" ou "foto-<número>".`),
        h('ul', { class: 'review-list' }, ...r.reviews.slice(0, 10).map((rv) => h('li', {}, h('code', {}, `avaliacao-${rv.id}`), ` ${rv.author} · ${rv.date} · ${'★'.repeat(rv.rating)} — ${rv.text.slice(0, 120)}`))),
      );
    } catch (err) {
      box.replaceChildren(h('h3', {}, 'Avaliações da loja'), h('p', { class: 'help' }, `Não foi possível ler as avaliações agora: ${errorText(err)}`));
    }
  }

  function renderVideos(): void {
    const list = h('div', { class: 'stack' });
    const media = view.media;
    const fieldsFor = (v: Video, idx: number) => {
      const title = h('input', { 'aria-label': 'Título', maxlength: '80' });
      title.value = v.title;
      const caption = h('input', { 'aria-label': 'Legenda', maxlength: '140' });
      caption.value = v.caption;
      const videoUrl = h('input', { 'aria-label': 'Endereço do vídeo', class: 'mono', placeholder: 'https://… .mp4 ou envie o arquivo' });
      videoUrl.value = v.videoUrl;
      const posterUrl = h('input', { 'aria-label': 'Endereço da capa', class: 'mono', placeholder: 'https://… .jpg/.webp ou envie a imagem' });
      posterUrl.value = v.posterUrl;
      const products = h('textarea', { 'aria-label': 'Produtos vinculados', rows: '2', placeholder: `${view.store.basePath}/product/nome-do-produto (um por linha)` });
      products.value = v.productPaths.join('\n');
      const upload = (accept: string, target: HTMLInputElement, label: string) => {
        const inp = h('input', { type: 'file', accept, class: 'sr', id: `up-${idx}-${label}` });
        const btn = h('label', { class: 'btn btn-small', for: `up-${idx}-${label}` }, `Enviar ${label}`);
        inp.addEventListener('change', async () => {
          const file = inp.files?.[0];
          if (!file) return;
          btn.textContent = 'Enviando…';
          try {
            const r = await api<{ url: string }>(`/api/stores/${id}/media`, { method: 'POST', body: file, headers: { 'content-type': file.type, 'x-file-name': encodeURIComponent(file.name) } });
            target.value = r.url;
            sync();
            flash(`${label === 'vídeo' ? 'Vídeo' : 'Capa'} enviado(a).`);
          } catch (err) {
            flash(errorText(err), 'error');
          } finally {
            btn.textContent = `Enviar ${label}`;
          }
        });
        return h('span', {}, inp, btn);
      };
      const sync = () => {
        draft.library.videos[idx] = {
          ...draft.library.videos[idx]!,
          title: title.value,
          caption: caption.value,
          videoUrl: videoUrl.value.trim(),
          posterUrl: posterUrl.value.trim(),
          productPaths: products.value.split('\n').map((x) => x.trim()).filter(Boolean),
        };
        onChange();
      };
      for (const el of [title, caption, videoUrl, posterUrl, products]) el.addEventListener('input', sync);
      const del = h('button', { type: 'button', class: 'btn btn-small btn-danger' }, 'Remover');
      del.addEventListener('click', () => {
        const removed = draft.library.videos.splice(idx, 1)[0];
        for (const m of Object.values(draft.modules)) if (Array.isArray(m.settings.videos)) m.settings.videos = (m.settings.videos as string[]).filter((x) => x !== removed?.id);
        onChange();
        renderVideos();
      });
      const err = h('p', { class: 'err' });
      const myErrors = lastErrors.filter((e) => e.field.startsWith(`library.videos.${idx}.`));
      err.textContent = myErrors.map((e) => e.message).join(' ');
      return h(
        'div',
        { class: 'card stack video-card' },
        h('div', { class: 'row-between' }, h('h3', {}, v.title || `Vídeo ${idx + 1}`), del),
        h('div', { class: 'two' }, h('div', { class: 'field' }, h('label', {}, 'Título', title)), h('div', { class: 'field' }, h('label', {}, 'Legenda (opcional)', caption))),
        h('div', { class: 'field' }, h('label', {}, 'Vídeo (MP4/WebM, curto)', videoUrl), upload('video/mp4,video/webm', videoUrl, 'vídeo')),
        h('div', { class: 'field' }, h('label', {}, 'Capa', posterUrl), upload('image/jpeg,image/png,image/webp', posterUrl, 'capa')),
        h('div', { class: 'field' }, h('label', {}, 'Produtos vinculados', products), h('p', { class: 'help' }, 'Caminho da página do produto na loja. Usado pelos cards, pela página do produto e pelo mini player.')),
        err,
      );
    };
    draft.library.videos.forEach((v, i) => list.append(fieldsFor(v, i)));
    const add = h('button', { type: 'button', class: 'btn' }, '+ Vídeo');
    add.addEventListener('click', () => {
      draft.library.videos.push({ id: Math.random().toString(36).slice(2, 12).padEnd(10, '0'), title: '', caption: '', videoUrl: '', posterUrl: '', productPaths: [] });
      onChange();
      renderVideos();
    });
    main.replaceChildren(
      h('section', { class: 'card stack' }, h('h2', {}, 'Biblioteca de vídeos'), h('p', { class: 'help' }, `Usada pelos cards de vídeo (M08) e pelo mini player (M09). ${media.length} arquivo(s) enviado(s) para esta loja.`)),
      list,
      add,
    );
  }

  // ---- integração: o que já existe na INK pré-carrega os módulos
  async function renderIntegration(): Promise<void> {
    const box = h('div', { class: 'stack' }, h('p', { class: 'help' }, 'Carregando…'));
    main.append(box);
    let st: IntegrationStatus;
    try {
      st = await api<IntegrationStatus>(`/api/stores/${id}/integration`);
    } catch (err) {
      box.replaceChildren(h('p', { class: 'error-text' }, errorText(err)));
      return;
    }
    if (section.kind !== 'integration') return;
    const rerender = (next: IntegrationStatus) => {
      st = next;
      paint();
    };

    /** Muda as configurações de um módulo no rascunho (o lojista revisa, salva e publica). */
    const editModule = (mid: string, fn: (settings: Values) => string) => {
      const def = moduleDef(mid)!;
      const cur = withDefaults(def.fields, def.defaults, draft.modules[mid]?.settings);
      const msg = fn(cur);
      draft.modules[mid] = { ...draft.modules[mid]!, settings: cur };
      renderStatus();
      pushPreview();
      flash(`${msg} Está no rascunho: revise em ${def.code}, salve e publique.`);
    };
    const couponToCampaign = (c: SiteCoupon): Values => {
      const progressive = c.rules.some((r) => /progressiva/i.test(r));
      return {
        title: (progressive ? 'Promoção progressiva' : c.off ? `${c.off}${c.firstPurchase ? ' na primeira compra' : ''}` : `Cupom ${c.code}`).slice(0, 60),
        description: c.savings.slice(0, 140),
        code: c.code,
        conditions: (c.rules.join(' · ') || 'As condições são conferidas no carrinho da loja.').slice(0, 240),
        startsAt: null,
        endsAt: null,
        firstPurchase: c.firstPurchase,
        nearPrice: false,
        badge: '',
      };
    };
    const can = (mid: string) => view.entitled.includes(mid);

    const paint = () => {
      const data = st.site.data;
      const syncBtn = h('button', { type: 'button', class: 'btn btn-primary' }, data ? 'Buscar de novo' : 'Buscar dados da loja');
      syncBtn.addEventListener('click', () =>
        void busy(syncBtn, 'Lendo a loja…', async () => {
          try {
            rerender(await api<IntegrationStatus>(`/api/stores/${id}/integration/sync`, { method: 'POST', json: {} }));
            flash(st.site.error ? st.site.error : 'Dados da loja atualizados.', st.site.error ? 'error' : 'ok');
          } catch (err) {
            flash(errorText(err), 'error');
          }
        }),
      );

      const blocks: Node[] = [];
      if (data) {
        // Cupons
        const camps = list(draft.modules.coupons?.settings.campaigns);
        const missing = data.coupons.filter((c) => !camps.some((x) => String(x.code).toUpperCase() === c.code.toUpperCase()));
        const addCoupons = h('button', { type: 'button', class: 'btn btn-small', disabled: !missing.length || !can('coupons') }, missing.length ? `Adicionar ${missing.length > 1 ? `os ${missing.length}` : 'ao'} M05 Cupons` : 'Já estão no M05');
        addCoupons.addEventListener('click', () =>
          editModule('coupons', (set) => {
            const room = 6 - list(set.campaigns).length;
            const add = missing.slice(0, Math.max(0, room));
            set.campaigns = [...list(set.campaigns), ...add.map(couponToCampaign)];
            paint();
            return add.length < missing.length ? `${add.length} cupom(ns) adicionado(s); o M05 aceita até 6.` : `${add.length} cupom(ns) adicionado(s) ao M05.`;
          }),
        );
        blocks.push(
          h(
            'section',
            { class: 'card stack' },
            h('div', { class: 'row-between' }, h('h3', {}, `Cupons que a INK mostra nos produtos (${data.coupons.length})`), data.coupons.length ? addCoupons : null),
            data.coupons.length
              ? h('ul', { class: 'int-list' }, ...data.coupons.map((c) => h('li', {}, h('code', {}, c.code), ' ', h('span', {}, [c.savings, ...c.rules].filter(Boolean).join(' · ')), h('span', { class: 'help' }, ` — visto em "${c.seenOn}"`))))
              : h('p', { class: 'empty' }, 'Nenhum cupom apareceu nos produtos lidos.'),
            h('p', { class: 'help' }, 'Entram como campanhas do M05 com o mesmo código e as regras escritas pela INK. A INK continua validando no carrinho. Para ler os cupons de cada produto na hora, ligue "Mostrar também os cupons cadastrados na INK" no M05.'),
          ),
        );
        // Promoção progressiva
        if (data.progressive.length) {
          blocks.push(
            h(
              'section',
              { class: 'card stack' },
              h('h3', {}, 'Promoção progressiva'),
              ...data.progressive.map((p) => {
                const use = h('button', { type: 'button', class: 'btn btn-small', disabled: !can('cartIncentive') }, 'Usar no M06 Incentivo do carrinho');
                use.addEventListener('click', () => {
                  const cur = list(draft.modules.cartIncentive?.settings.tiers);
                  if (cur.length && !confirm(`Substituir as ${cur.length} faixa(s) atuais do M06 pelas da promoção ${p.code}?`)) return;
                  editModule('cartIncentive', (set) => {
                    set.campaignName = p.code;
                    set.measure = p.measure;
                    set.tiers = p.tiers.map((t) => ({ threshold: t.threshold, benefit: t.benefit, amount: t.amount, label: t.label }));
                    return `Faixas da promoção ${p.code} levadas ao M06.`;
                  });
                });
                return h('div', { class: 'row-between' }, h('p', {}, h('code', {}, p.code), ' ', p.tiers.map((t) => `${t.threshold} peças: ${t.label}`).join(' · ')), use);
              }),
              h('p', { class: 'help' }, 'As faixas vêm do texto que a INK mostra no produto. O desconto continua sendo aplicado pela INK.'),
            ),
          );
        }
        // Assistente
        const c = data.contacts;
        const contactLine = [c.instagram && `Instagram @${c.instagram}`, c.tiktok && `TikTok ${c.tiktok}`, c.facebook && `Facebook ${c.facebook}`, c.whatsapp && `WhatsApp ${c.whatsapp}`, c.email && c.email].filter(Boolean).join(' · ');
        blocks.push(
          h(
            'section',
            { class: 'card stack' },
            h('h3', {}, `Respostas para o assistente (${data.faq.length + (data.about?.text ? 1 : 0)})`),
            data.faq.length
              ? h('details', {}, h('summary', {}, 'Ver as perguntas lidas'), h('ul', { class: 'int-list' }, ...data.faq.map((f) => h('li', {}, h('strong', {}, f.question), h('br'), h('span', { class: 'help' }, f.answer)))))
              : h('p', { class: 'empty' }, 'A loja não tem perguntas frequentes publicadas na INK.'),
            h('p', {}, h('strong', {}, 'Sobre: '), data.about?.text ? data.about.text.slice(0, 220) : 'página Sobre sem texto.'),
            h('p', {}, h('strong', {}, 'Contatos: '), contactLine || 'nenhum encontrado nas páginas.'),
            h('p', { class: 'help' }, 'O M10 Assistente usa isto sozinho quando "Responder também com o que a loja já publicou na INK" está ligado. O que você cadastrar na base de respostas do M10 prevalece.'),
          ),
        );
        blocks.push(
          h(
            'details',
            { class: 'card' },
            h('summary', {}, `Páginas lidas (${data.pages.filter((p) => p.ok).length} de ${data.pages.length})`),
            h('ul', { class: 'int-list' }, ...data.pages.map((p) => h('li', {}, h('span', { class: `pill ${p.ok ? 'on' : 'err'}` }, p.ok ? 'ok' : 'falhou'), ' ', p.label, p.detail ? ` — ${p.detail}` : ''))),
          ),
        );
      }

      // API da INK
      const tokenIn = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: st.api.configured ? 'Colar um token novo para trocar' : 'Cole aqui o token da API da INK', 'aria-label': 'Token da API da INK' });
      const saveTok = h('button', { type: 'button', class: 'btn btn-small' }, 'Guardar token');
      const testTok = h('button', { type: 'button', class: 'btn btn-small', disabled: !st.api.configured }, 'Testar conexão');
      const delTok = h('button', { type: 'button', class: 'btn btn-small btn-danger', disabled: !st.api.configured }, 'Remover token');
      saveTok.addEventListener('click', () =>
        void busy(saveTok, 'Guardando…', async () => {
          try {
            rerender(await api<IntegrationStatus>(`/api/stores/${id}/integration/ink-token`, { method: 'PUT', json: { token: tokenIn.value } }));
            flash('Token guardado. Teste a conexão.');
          } catch (err) {
            flash(errorText(err), 'error');
          }
        }),
      );
      testTok.addEventListener('click', () =>
        void busy(testTok, 'Testando…', async () => {
          try {
            rerender(await api<IntegrationStatus>(`/api/stores/${id}/integration/ink-test`, { method: 'POST', json: {} }));
            flash(st.api.testMessage ?? '', st.api.testOk ? 'ok' : 'error');
          } catch (err) {
            flash(errorText(err), 'error');
          }
        }),
      );
      delTok.addEventListener('click', () => {
        if (!confirm('Remover o token da API da INK desta loja?')) return;
        void busy(delTok, 'Removendo…', async () => {
          try {
            rerender(await api<IntegrationStatus>(`/api/stores/${id}/integration/ink-token`, { method: 'DELETE' }));
            flash('Token removido.');
          } catch (err) {
            flash(errorText(err), 'error');
          }
        });
      });
      const a = st.api;
      // Dados lidos pela API: promoções, categorias e produtos.
      const apiBlocks: Node[] = [];
      if (a.data) {
        const d = a.data;
        const colPath = (cid: number) => d.collections.find((c) => c.id === cid)?.path ?? null;
        const TYPE: Record<InkPromotion['type'], string> = { standard: 'Desconto', progressive: 'Progressiva', unit_free: 'Leve N, pague N-1' };
        const promoRow = (pr: InkPromotion) => {
          const camps = list(draft.modules.coupons?.settings.campaigns);
          const inM05 = camps.some((x) => String(x.code).toUpperCase() === pr.code.toUpperCase());
          const asCampaign = promotionToCampaign(pr);
          const asIncentive = promotionToIncentive(pr, colPath);
          const toM05 = h('button', { type: 'button', class: 'btn btn-small', disabled: !asCampaign || inM05 || !can('coupons') }, inM05 ? 'Já no M05' : 'Cupom no M05');
          toM05.title = asCampaign ? '' : 'Promoção automática: a INK aplica sozinha, não há código para o cliente copiar.';
          toM05.addEventListener('click', () =>
            editModule('coupons', (set) => {
              if (list(set.campaigns).length >= 6) return 'O M05 já tem 6 campanhas: remova uma antes.';
              set.campaigns = [...list(set.campaigns), asCampaign!];
              paint();
              return `Cupom ${pr.code} adicionado ao M05.`;
            }),
          );
          const toM06 = h('button', { type: 'button', class: 'btn btn-small', disabled: !asIncentive || !can('cartIncentive') }, 'Metas no M06');
          toM06.addEventListener('click', () => {
            const cur = list(draft.modules.cartIncentive?.settings.tiers);
            if (cur.length && !confirm(`Substituir as ${cur.length} faixa(s) atuais do M06 pelas da promoção ${pr.code}?`)) return;
            editModule('cartIncentive', (set) => {
              Object.assign(set, asIncentive);
              const many = pr.scope !== 'all' && set.eligibility !== 'colecao';
              return `Metas da promoção ${pr.code} levadas ao M06.${many ? ' Atenção: a promoção não vale para a loja toda; confira os itens participantes no M06.' : ''}`;
            });
          });
          const status = !pr.available ? (pr.startsAt && Date.parse(pr.startsAt) > Date.now() ? 'agendada' : 'fora do ar') : pr.automatic ? 'automática' : 'com código';
          return h(
            'li',
            { class: 'int-promo' },
            h('div', {}, h('code', {}, pr.code), ' ', h('span', { class: `pill ${pr.available ? 'on' : 'warn'}` }, status), ' ', h('span', { class: 'chip' }, TYPE[pr.type]), h('br'), h('span', {}, tierLines(pr).join(' · ') || promotionSummary(pr)), h('br'), h('span', { class: 'help' }, [pr.firstPurchase ? 'Só na primeira compra.' : '', SCOPE_TEXT[pr.scope], pr.expiresAt ? `Até ${when(pr.expiresAt)}.` : ''].filter(Boolean).join(' '))),
            h('div', { class: 'row' }, toM05, toM06),
          );
        };
        const live = d.promotions.filter((x) => x.available);
        const later = d.promotions.filter((x) => !x.available);
        apiBlocks.push(
          h('h3', {}, `Promoções na INK (${live.length} no ar${later.length ? `, ${later.length} fora do ar ou agendadas` : ''})`),
          d.promotions.length ? h('ul', { class: 'int-list plain' }, ...[...live, ...later].map(promoRow)) : h('p', { class: 'empty' }, 'Nenhuma promoção cadastrada na INK.'),
        );
        const cols = d.collections.filter((c) => c.products > 0);
        const toM02 = h('button', { type: 'button', class: 'btn btn-small', disabled: !cols.length || !can('categoryTabs') }, 'Usar as 6 primeiras no M02');
        toM02.addEventListener('click', () => {
          const cur = list(draft.modules.categoryTabs?.settings.tabs);
          if (cur.length && !confirm(`Substituir as ${cur.length} aba(s) atuais do M02 pelas categorias da INK, na ordem do menu?`)) return;
          editModule('categoryTabs', (set) => {
            set.tabs = cols.slice(0, 6).map((c) => ({ label: c.name.slice(0, 30), path: c.path }));
            return 'Abas do M02 preenchidas com as categorias da INK, na ordem do menu.';
          });
        });
        apiBlocks.push(
          h('div', { class: 'row-between' }, h('h3', {}, `Categorias (${d.collections.length})`), toM02),
          h('p', { class: 'help' }, cols.map((c) => `${c.name} (${c.products})`).join(' · ') || 'Nenhuma categoria com produtos.'),
          h('h3', {}, `Produtos publicados (${d.products.total})`),
          h(
            'p',
            { class: 'help' },
            `O M10 Assistente procura por estampa no nome, nas tags (${d.products.withTags} produtos com tags) e no tipo da peça, mais vendidos primeiro. ${d.products.clusters} estampas têm mais de uma versão agrupada na INK (base para um "Também disponível em").`,
          ),
          ...(d.products.bestSellers.length ? [h('p', {}, h('strong', {}, 'Mais vendidos: '), d.products.bestSellers.map((x) => `${x.name} (${x.sales})`).join(' · '))] : []),
          ...d.problems.map((pb) => h('p', { class: 'error-text' }, `${pb.resource}: ${pb.message}`)),
          h('p', { class: 'help' }, `Lido em ${when(d.at)}. Renovado junto com a leitura da loja.`),
        );
      }
      const apiCard = h(
        'section',
        { class: 'card stack' },
        h('h2', {}, 'API da INK'),
        h('p', { class: 'help' }, 'Para lojas com plano que dá acesso à API da INK. O token fica cifrado no servidor: não aparece de novo aqui e nunca vai para a loja.'),
        h(
          'div',
          { class: 'now-row' },
          h('span', { class: `pill ${a.testOk ? 'on' : a.testOk === false ? 'err' : ''}` }, !a.configured ? 'Sem token' : a.testOk ? 'Conectado' : a.testOk === false ? 'Falhou' : 'Não testado'),
          h('span', { class: 'help' }, a.configured ? `Token terminado em …${a.hint}, guardado em ${when(a.setAt!)}.${a.testedAt ? ` ${a.testMessage} (${when(a.testedAt)})` : ''}` : 'Sem token: os dados vêm só da leitura da loja.'),
        ),
        h('div', { class: 'row' }, tokenIn, saveTok, testTok, delTok),
        a.configured ? null : h('p', { class: 'help' }, 'Com o token, o painel lê promoções (desconto, progressiva e leve N pague N-1), categorias e produtos publicados. Escopos de leitura necessários: store.promotions.read, store.categories.read e store.products.read. Gere no painel da INK, em Credenciais da API.'),
        ...apiBlocks,
      );

      box.replaceChildren(
        h(
          'section',
          { class: 'card stack' },
          h('div', { class: 'row-between' }, h('h2', {}, 'Dados lidos da loja'), syncBtn),
          h('p', { class: 'help' }, 'O painel lê as páginas públicas da sua loja na INK (início, perguntas frequentes, trocas, sobre e alguns produtos) e pré-carrega os módulos. Nada é alterado na INK, e funciona em qualquer plano.'),
          h(
            'div',
            { class: 'now-row' },
            h('span', { class: `pill ${st.site.error ? 'warn' : data ? 'on' : ''}` }, st.site.error ? 'Última leitura falhou' : data ? 'Lido' : 'Ainda não lido'),
            h('span', { class: 'help' }, [st.site.fetchedAt ? `Última leitura: ${when(st.site.fetchedAt)}. Renovada sozinha a cada 12 horas.` : 'Clique em buscar para ler a loja.', st.site.error ?? ''].filter(Boolean).join(' ')),
          ),
        ),
        ...blocks,
        apiCard,
      );
    };
    paint();
  }

  function renderHistory(): void {
    const label = (h2: HistoryEntry) =>
      h2.action === 'publish' ? 'Publicação do rascunho' : h2.action === 'restore' ? `Restauração (${h2.note})` : h2.action === 'enable' ? `Ligou ${moduleDef(h2.note)?.name ?? h2.note}` : `Desligou ${moduleDef(h2.note)?.name ?? h2.note}`;
    const rows = view.history.map((e2) => {
      const btn = h('button', { type: 'button', class: 'btn btn-small', disabled: e2.version === view.published?.version }, e2.version === view.published?.version ? 'Na loja' : 'Restaurar');
      btn.addEventListener('click', () =>
        void busy(btn, 'Restaurando…', async () => {
          if (isDirty() && !confirm('Restaurar substitui o rascunho atual, inclusive alterações não salvas. Continuar?')) return;
          try {
            view = await api<StoreView>(`/api/stores/${id}/restore`, { method: 'POST', json: { version: e2.version } });
            draft = structuredClone(view.draft.config);
            flash(`Versão ${e2.version} restaurada: virou a versão ${view.published?.version} na loja, e o rascunho acompanha.`);
            renderStatus();
            renderSection();
            pushPreview();
          } catch (err) {
            flash(errorText(err), 'error');
          }
        }),
      );
      return h('tr', {}, h('td', {}, `v${e2.version}`), h('td', {}, when(e2.publishedAt)), h('td', {}, label(e2)), h('td', {}, e2.publishedBy ?? '—'), h('td', {}, e2.enabledModules.map((m) => moduleDef(m)?.code).join(', ') || 'nenhum'), h('td', {}, btn));
    });
    main.append(
      h(
        'section',
        { class: 'card stack' },
        h('h2', {}, 'Publicações'),
        h('p', { class: 'help' }, 'Restaurar cria uma versão nova igual à escolhida e atualiza o rascunho. Nada é apagado.'),
        rows.length
          ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ...['Versão', 'Quando', 'O que mudou', 'Quem', 'Módulos ligados', ''].map((t) => h('th', {}, t)))), h('tbody', {}, ...rows)))
          : h('p', { class: 'empty' }, 'Nenhuma publicação ainda.'),
      ),
    );
  }

  // ---- ações
  saveBtn.addEventListener('click', () =>
    void busy(saveBtn, 'Salvando…', async () => {
      readForm();
      if (validateNow(true).length) {
        flash('O rascunho não foi salvo: revise os campos destacados.', 'error');
        return;
      }
      try {
        view = await api<StoreView>(`/api/stores/${id}/draft`, { method: 'PUT', json: { config: draft, expectedUpdatedAt: view.draft.updatedAt } });
        draft = structuredClone(view.draft.config);
        errBox.hidden = true;
        lastErrors = [];
        flash('Rascunho salvo. A loja não mudou: publique quando estiver pronto.');
        renderStatus();
        renderSection();
      } catch (err) {
        if (err instanceof ApiError && err.errors.length) {
          lastErrors = err.errors;
          form?.showErrors(lastErrors, section.kind === 'module' ? `modules.${section.id}` : 'identity');
        }
        flash(`O rascunho não foi salvo: ${errorText(err)}`, 'error');
      }
    }),
  );
  pubBtn.addEventListener('click', () =>
    void busy(pubBtn, 'Publicando…', async () => {
      try {
        view = await api<StoreView>(`/api/stores/${id}/publish`, { method: 'POST', json: { expectedDraftUpdatedAt: view.draft.updatedAt } });
        draft = structuredClone(view.draft.config);
        const on = Object.entries(view.published!.config.modules).filter(([, m]) => m.enabled).map(([mid]) => moduleDef(mid)?.code);
        flash(`Versão ${view.published!.version} publicada: ${on.length ? on.join(', ') : 'nenhum módulo'} na loja. Recarregue a loja para ver.`);
        renderStatus();
        renderSection();
      } catch (err) {
        if (err instanceof ApiError && err.errors.length) {
          errBox.replaceChildren(h('p', {}, err.message), h('ul', {}, ...err.errors.slice(0, 10).map((e) => h('li', {}, e.message))));
          errBox.hidden = false;
        }
        flash(`Não publicado: ${errorText(err)}`, 'error');
      }
    }),
  );

  renderStatus();
  renderSection();
  void loadPreview();
}

// ------------------------------------------------------------------ início

window.addEventListener('hashchange', () => void route());
void route();

export type { Field };
