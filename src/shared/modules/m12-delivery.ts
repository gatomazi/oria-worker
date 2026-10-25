import type { ModuleDef } from '../registry.ts';
import { color } from './common.ts';

const LEGACY_NOTE = 'A data de entrega é calculada pela INK para o CEP informado.';

export const delivery: ModuleDef = {
  id: 'delivery',
  code: 'M12',
  name: 'Prazo de entrega na página do produto',
  summary: 'Mostra a data de entrega que a INK calcula para o CEP e, separada, a informação de produção configurada pela loja.',
  pages: ['product'],
  integrations: ['ink.deliveryEstimates'],
  fields: [
    { key: 'productionMin', type: 'number', label: 'Produção: mínimo', min: 0, max: 30, integer: true, unit: 'dias úteis' },
    { key: 'productionMax', type: 'number', label: 'Produção: máximo', min: 0, max: 60, integer: true, unit: 'dias úteis' },
    { key: 'productionLabel', type: 'text', label: 'Texto da produção', max: 80, required: true, help: 'Use {min} e {max}.' },
    { key: 'calculator', type: 'toggle', label: 'Calcular a data de entrega pelo CEP (fonte: INK)' },
    { key: 'note', type: 'text', label: 'Observação', max: 160 },
    {
      key: 'position',
      type: 'select',
      label: 'Posição',
      options: [
        { value: 'abaixo-comprar', label: 'Abaixo do botão de comprar' },
        { value: 'abaixo-preco', label: 'Abaixo do preço' },
      ],
    },
    { key: 'accent', type: 'colorToken', label: 'Cor' },
  ],
  defaults: {
    productionMin: 3,
    productionMax: 7,
    productionLabel: 'Produção sob demanda: {min} a {max} dias úteis',
    calculator: true,
    note: 'Prazo estimado para o CEP informado.',
    position: 'abaixo-comprar',
    accent: 'primary',
  },
  check(s) {
    return Number(s.productionMax) < Number(s.productionMin)
      ? [{ field: 'productionMax', message: 'Produção: o máximo precisa ser maior ou igual ao mínimo.' }]
      : [];
  },
  targets: () => ({ pages: ['product'], devices: ['mobile', 'desktop'] }),
  project: (s, ctx) => ({
    productionMin: s.productionMin,
    productionMax: s.productionMax,
    productionLabel: s.productionLabel,
    calculator: s.calculator,
    // O texto padrão antigo citava a plataforma; o cliente da loja vê só o cálculo.
    note: s.note === LEGACY_NOTE ? 'Prazo estimado para o CEP informado.' : s.note,
    position: s.position,
    colors: color(ctx, s.accent),
  }),
};
