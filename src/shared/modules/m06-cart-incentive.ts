import type { FieldError } from '../fields.ts';
import type { ModuleDef } from '../registry.ts';
import { color, list } from './common.ts';

export const cartIncentive: ModuleDef = {
  id: 'cartIncentive',
  code: 'M06',
  name: 'Incentivo para mais itens no carrinho',
  summary: 'Quanto falta para o próximo benefício (frete grátis ou desconto por faixa), atualizado a cada mudança no carrinho, e confirmação após adicionar com sugestões.',
  pages: ['home', 'listing', 'product', 'other'],
  integrations: ['ink.cart'],
  fields: [
    {
      key: 'campaignName',
      type: 'text',
      label: 'Campanha na INK',
      max: 60,
      required: true,
      help: 'Nome da promoção já configurada na INK. As faixas abaixo precisam ser exatamente as dela.',
    },
    {
      key: 'measure',
      type: 'select',
      label: 'A meta é por',
      options: [
        { value: 'valor', label: 'Valor dos produtos no carrinho (R$)' },
        { value: 'itens', label: 'Quantidade de peças' },
      ],
    },
    {
      key: 'tiers',
      type: 'list',
      label: 'Faixas',
      itemLabel: 'Faixa',
      titleKey: 'label',
      min: 1,
      max: 4,
      fields: [
        { key: 'threshold', type: 'number', label: 'A partir de', min: 1, max: 100000, step: 1 },
        {
          key: 'benefit',
          type: 'select',
          label: 'Benefício',
          options: [
            { value: 'frete', label: 'Frete grátis' },
            { value: 'percentual', label: 'Desconto em %' },
            { value: 'valor', label: 'Desconto em R$' },
            { value: 'brinde', label: 'Brinde' },
          ],
        },
        { key: 'amount', type: 'number', label: 'Valor do desconto (% ou R$)', min: 0, max: 100000, step: 0.01, showWhen: { key: 'benefit', in: ['percentual', 'valor'] } },
        { key: 'label', type: 'text', label: 'Como chamar o benefício', max: 40, required: true },
      ],
    },
    {
      key: 'eligibility',
      type: 'select',
      label: 'Itens participantes',
      options: [
        { value: 'todos', label: 'Todos os produtos' },
        { value: 'colecao', label: 'Só produtos de uma coleção' },
      ],
    },
    { key: 'eligiblePath', type: 'storePath', label: 'Coleção participante', required: true, showWhen: { key: 'eligibility', in: ['colecao'] } },
    { key: 'showInCart', type: 'toggle', label: 'Mostrar no carrinho' },
    { key: 'showAfterAdd', type: 'toggle', label: 'Confirmação após adicionar, com sugestões' },
    {
      key: 'recommendations',
      type: 'select',
      label: 'Sugestões na confirmação',
      showWhen: { key: 'showAfterAdd', in: [true] },
      options: [
        { value: 'mais-vendidos', label: 'Mais vendidos da loja (INK)' },
        { value: 'colecao', label: 'Produtos de uma coleção' },
        { value: 'manual', label: 'Escolha manual' },
      ],
    },
    { key: 'recommendationPath', type: 'storePath', label: 'Coleção das sugestões', required: true, showWhen: { key: 'recommendations', in: ['colecao'] } },
    {
      key: 'manualProducts',
      type: 'list',
      label: 'Produtos sugeridos',
      itemLabel: 'Produto',
      titleKey: 'path',
      min: 1,
      max: 8,
      showWhen: { key: 'recommendations', in: ['manual'] },
      fields: [{ key: 'path', type: 'storePath', label: 'Página do produto', required: true }],
    },
    { key: 'recommendationCount', type: 'number', label: 'Quantas sugestões', min: 2, max: 8, integer: true },
    { key: 'chooseMoreLabel', type: 'text', label: 'Texto do botão para continuar comprando', max: 40, required: true },
    { key: 'chooseMorePath', type: 'storePath', label: 'Destino do botão (vazio = início da loja)' },
    { key: 'accent', type: 'colorToken', label: 'Cor da barra de progresso' },
  ],
  defaults: {
    campaignName: '',
    measure: 'valor',
    tiers: [],
    eligibility: 'todos',
    eligiblePath: '',
    showInCart: true,
    showAfterAdd: true,
    recommendations: 'mais-vendidos',
    recommendationPath: '',
    manualProducts: [],
    recommendationCount: 4,
    chooseMoreLabel: 'Escolher mais produtos',
    chooseMorePath: '',
    accent: 'primary',
  },
  check(s) {
    const errs: FieldError[] = [];
    const t = list(s.tiers).map((x) => Number(x.threshold));
    if (t.some((v, i) => i > 0 && v <= t[i - 1]!)) errs.push({ field: 'tiers', message: 'Faixas: coloque em ordem crescente, sem valores repetidos.' });
    if (s.measure === 'itens' && t.some((v) => !Number.isInteger(v))) errs.push({ field: 'tiers', message: 'Faixas por quantidade de peças precisam ser números inteiros.' });
    list(s.tiers).forEach((x, i) => {
      if (x.benefit === 'percentual' && (Number(x.amount) <= 0 || Number(x.amount) > 90)) {
        errs.push({ field: `tiers.${i}.amount`, message: 'Desconto em %: entre 0 e 90.' });
      }
    });
    if (!s.showInCart && !s.showAfterAdd) errs.push({ field: 'showInCart', message: 'Escolha pelo menos onde mostrar: carrinho ou confirmação após adicionar.' });
    return errs;
  },
  targets: () => ({ pages: ['home', 'listing', 'product', 'other'], devices: ['mobile', 'desktop'] }),
  project(s, ctx) {
    return {
      campaignName: s.campaignName,
      measure: s.measure,
      tiers: list(s.tiers).map((t) => ({ threshold: t.threshold, benefit: t.benefit, amount: t.amount, label: t.label })),
      eligibility: s.eligibility,
      eligiblePath: s.eligibility === 'colecao' ? s.eligiblePath : '',
      showInCart: s.showInCart,
      showAfterAdd: s.showAfterAdd,
      recommendations: s.recommendations,
      recommendationPath: s.recommendations === 'colecao' ? s.recommendationPath : '',
      manualProducts: s.recommendations === 'manual' ? list(s.manualProducts).map((p) => p.path) : [],
      recommendationCount: s.recommendationCount,
      chooseMoreLabel: s.chooseMoreLabel,
      chooseMorePath: s.chooseMorePath || ctx.basePath || '/',
      colors: color(ctx, s.accent),
    };
  },
};
