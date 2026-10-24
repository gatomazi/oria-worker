import type { FieldError } from '../fields.ts';
import type { ModuleDef } from '../registry.ts';
import { color, dateOrder, list, pagesField, targetsFrom, within } from './common.ts';

export const coupons: ModuleDef = {
  id: 'coupons',
  code: 'M05',
  name: 'Cupons em destaque e em abas',
  summary: 'Campanhas da loja com código para copiar, em destaque único, abas ou lista; selo de 1ª compra perto do preço. Copiar não aplica o desconto.',
  pages: ['home', 'listing', 'product', 'other'],
  integrations: [],
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
      min: 1,
      max: 8,
      fields: [
        { key: 'title', type: 'text', label: 'Título', max: 60, required: true },
        { key: 'description', type: 'text', label: 'Descrição curta', max: 140 },
        { key: 'code', type: 'code', label: 'Código do cupom', required: true },
        { key: 'conditions', type: 'text', label: 'Condições de uso', max: 240, required: true, multiline: true },
        { key: 'startsAt', type: 'datetime', label: 'Início (opcional)' },
        { key: 'endsAt', type: 'datetime', label: 'Fim (opcional)' },
        { key: 'firstPurchase', type: 'toggle', label: 'Só para a primeira compra' },
        { key: 'nearPrice', type: 'toggle', label: 'Mostrar selo perto do preço (cards e página do produto)' },
        { key: 'badge', type: 'text', label: 'Texto do selo', max: 40, showWhen: { key: 'nearPrice', in: [true] }, required: true },
      ],
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
    position: 'abaixo-cabecalho',
    pages: ['home', 'listing', 'product'],
    background: 'surface',
    accent: 'primary',
  },
  check(s) {
    const errs: FieldError[] = [];
    const cs = list(s.campaigns);
    cs.forEach((c, i) => errs.push(...dateOrder(`campaigns.${i}.`, c.startsAt, c.endsAt)));
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
    if (!cs.some((c) => within(c.startsAt, c.endsAt, now) || (typeof c.startsAt === 'string' && Date.parse(c.startsAt) > now))) {
      errs.push({ field: 'campaigns', message: 'Cupons: não há campanha vigente nem agendada.' });
    }
    return errs;
  },
  targets: (s) => {
    const t = targetsFrom(s, ['home']);
    // O selo perto do preço aparece em listagens e produto mesmo sem o bloco nessas páginas.
    if (list(s.campaigns).some((c) => c.nearPrice)) t.pages = [...new Set([...t.pages, 'listing', 'product', 'home'] as const)];
    return t;
  },
  project(s, ctx) {
    return {
      mode: s.mode,
      position: s.position,
      blockPages: s.pages,
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
