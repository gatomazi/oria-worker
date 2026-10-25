import type { FieldError } from '../fields.ts';
import type { ModuleDef } from '../registry.ts';
import { color, dateOrder, list, pagesField, targetsFrom, within } from './common.ts';

export const coupons: ModuleDef = {
  id: 'coupons',
  code: 'M05',
  name: 'Cupons em destaque e em abas',
  summary: 'Campanhas da loja com código para copiar, em destaque único, abas ou lista; selo de 1ª compra perto do preço. Copiar não aplica o desconto.',
  pages: ['home', 'listing', 'product', 'other'],
  integrations: ['ink.productPromotions (opcional)'],
  fields: [
    {
      key: 'mode',
      type: 'select',
      label: 'Formato',
      options: [
        { value: 'unico', label: 'Um cupom em destaque (o primeiro vigente)' },
        { value: 'abas', label: 'Abas, uma por campanha' },
        { value: 'lista', label: 'Lista com todas as campanhas' },
      ],
    },
    {
      key: 'campaigns',
      type: 'list',
      label: 'Campanhas',
      help: 'Cadastre só campanhas que já existem na INK, com o mesmo código e as mesmas regras.',
      itemLabel: 'Campanha',
      titleKey: 'title',
      min: 0,
      max: 8,
      fields: [
        { key: 'title', type: 'text', label: 'Título', max: 60, required: true },
        { key: 'description', type: 'text', label: 'Descrição curta', max: 140 },
        { key: 'code', type: 'code', label: 'Código do cupom', required: true },
        { key: 'conditions', type: 'text', label: 'Condições de uso', max: 240, required: true, multiline: true },
        { key: 'startsAt', type: 'datetime', label: 'Início (opcional)' },
        { key: 'endsAt', type: 'datetime', label: 'Fim (opcional)' },
        { key: 'firstPurchase', type: 'toggle', label: 'Só para a primeira compra' },
        { key: 'nearPrice', type: 'toggle', label: 'Mostrar selo perto do preço nos cards de produto' },
        { key: 'badge', type: 'text', label: 'Texto do selo', max: 40, showWhen: { key: 'nearPrice', in: [true] }, required: true },
      ],
    },
    {
      key: 'styleMobile',
      type: 'select',
      label: 'Bloco no celular',
      help: 'Compacto: uma linha por cupom (título curto, código e Copiar); descrição, condições e validade abrem em "Condições". Ocupa bem menos espaço antes do banner.',
      options: [
        { value: 'bloco', label: 'Bloco completo' },
        { value: 'compacto', label: 'Compacto' },
      ],
    },
    {
      key: 'styleDesktop',
      type: 'select',
      label: 'Bloco no computador',
      options: [
        { value: 'bloco', label: 'Bloco completo' },
        { value: 'compacto', label: 'Compacto' },
      ],
    },
    {
      key: 'productStyle',
      type: 'select',
      label: 'Na página do produto',
      help: 'Abas: um quadro compacto logo abaixo do preço, uma aba por código, com todas as campanhas vigentes (o selo de 1ª compra já aparece nelas). Bloco: o mesmo das outras páginas, com o selo junto ao preço.',
      options: [
        { value: 'junto-preco', label: 'Abas junto ao preço (uma por código)' },
        { value: 'bloco', label: 'Mesmo bloco das outras páginas' },
      ],
    },
    { key: 'productTitle', type: 'text', label: 'Título das abas no produto', max: 40, showWhen: { key: 'productStyle', in: ['junto-preco'] } },
    {
      key: 'cardBadge',
      type: 'select',
      label: 'Onde fica o selo nos cards de produto',
      help: 'Vale para campanhas com "Mostrar selo perto do preço" ligado.',
      options: [
        { value: 'foto-esquerda', label: 'No topo da foto, à esquerda' },
        { value: 'foto-direita', label: 'No topo da foto, à direita' },
        { value: 'abaixo-preco', label: 'Abaixo do preço' },
      ],
    },
    {
      key: 'inkCoupons',
      type: 'toggle',
      label: 'Mostrar também os cupons cadastrados na INK (página do produto)',
      help: 'Lê os cupons que a INK já oferece para aquele produto, com o mesmo código e as mesmas regras. Cupom de primeira compra vira selo perto do preço.',
    },
    {
      key: 'position',
      type: 'select',
      label: 'Posição do bloco',
      options: [
        { value: 'abaixo-cabecalho', label: 'Logo abaixo do cabeçalho' },
        { value: 'antes-rodape', label: 'Antes do rodapé' },
      ],
    },
    pagesField(['home', 'listing', 'product', 'other'], 'Páginas com o bloco'),
    { key: 'background', type: 'colorToken', label: 'Fundo' },
    { key: 'accent', type: 'colorToken', label: 'Botão e código' },
  ],
  defaults: {
    mode: 'unico',
    campaigns: [],
    // Lojas existentes mantêm o bloco; lojas novas recebem o compacto no celular (ver NEW_STORE_SETTINGS).
    styleMobile: 'bloco',
    styleDesktop: 'bloco',
    productStyle: 'junto-preco',
    productTitle: 'Cupons para este produto',
    cardBadge: 'foto-esquerda',
    inkCoupons: false,
    position: 'abaixo-cabecalho',
    pages: ['home', 'listing', 'product'],
    background: 'surface',
    accent: 'primary',
  },
  check(s) {
    const errs: FieldError[] = [];
    const cs = list(s.campaigns);
    cs.forEach((c, i) => errs.push(...dateOrder(`campaigns.${i}.`, c.startsAt, c.endsAt)));
    if (!cs.length && s.inkCoupons !== true) errs.push({ field: 'campaigns', message: 'Cupons: cadastre ao menos uma campanha ou ligue os cupons da INK.' });
    const codes = cs.map((c) => c.code);
    if (new Set(codes).size !== codes.length) errs.push({ field: 'campaigns', message: 'Campanhas: há códigos repetidos.' });
    return errs;
  },
  publishCheck(s, now) {
    const cs = list(s.campaigns);
    const errs: FieldError[] = [];
    cs.forEach((c, i) => {
      if (typeof c.endsAt === 'string' && Date.parse(c.endsAt) <= now) {
        errs.push({ field: `campaigns.${i}.endsAt`, message: `Campanha "${c.title}": a vigência já terminou. Ajuste ou remova antes de publicar.` });
      }
    });
    if (s.inkCoupons !== true && !cs.some((c) => within(c.startsAt, c.endsAt, now) || (typeof c.startsAt === 'string' && Date.parse(c.startsAt) > now))) {
      errs.push({ field: 'campaigns', message: 'Cupons: não há campanha vigente nem agendada.' });
    }
    return errs;
  },
  targets: (s) => {
    const t = targetsFrom(s, ['home']);
    // O selo perto do preço aparece em listagens e produto mesmo sem o bloco nessas páginas.
    if (s.inkCoupons === true) t.pages = [...new Set([...t.pages, 'product'] as const)];
    if (list(s.campaigns).some((c) => c.nearPrice)) t.pages = [...new Set([...t.pages, 'listing', 'product', 'home'] as const)];
    return t;
  },
  project(s, ctx) {
    return {
      mode: s.mode,
      position: s.position,
      blockPages: s.pages,
      inkCoupons: s.inkCoupons === true,
      styleMobile: s.styleMobile,
      styleDesktop: s.styleDesktop,
      productStyle: s.productStyle,
      productTitle: s.productTitle,
      cardBadge: s.cardBadge,
      colors: color(ctx, s.background),
      accent: color(ctx, s.accent),
      campaigns: list(s.campaigns)
        .filter((c) => !(typeof c.endsAt === 'string' && Date.parse(c.endsAt) <= ctx.now))
        .map((c) => ({
          title: c.title,
          description: c.description,
          code: c.code,
          conditions: c.conditions,
          startsAt: c.startsAt,
          endsAt: c.endsAt,
          firstPurchase: c.firstPurchase,
          nearPrice: c.nearPrice,
          badge: c.nearPrice ? c.badge : '',
        })),
    };
  },
};
