import type { FieldError } from '../fields.ts';
import type { ModuleDef } from '../registry.ts';
import { color, list } from './common.ts';

export const sizeGuide: ModuleDef = {
  id: 'sizeGuide',
  code: 'M11',
  name: 'Guia de medidas',
  summary: 'Tabelas de medidas por modelagem e uma ajuda para escolher comparando com uma peça que a pessoa já tem. Sem fórmula de altura e peso.',
  pages: ['product'],
  integrations: [],
  fields: [
    { key: 'linkLabel', type: 'text', label: 'Texto do link', max: 40, required: true },
    {
      key: 'tables',
      type: 'list',
      label: 'Tabelas por modelagem',
      itemLabel: 'Tabela',
      titleKey: 'name',
      min: 1,
      max: 10,
      fields: [
        { key: 'name', type: 'text', label: 'Modelagem', max: 40, required: true },
        { key: 'match', type: 'text', label: 'Usar nos produtos cujo nome ou categoria contém', max: 120, required: true, help: 'Palavras separadas por vírgula, ex.: camiseta infantil, body' },
        {
          key: 'rows',
          type: 'list',
          label: 'Tamanhos',
          itemLabel: 'Tamanho',
          titleKey: 'size',
          min: 1,
          max: 14,
          fields: [
            { key: 'size', type: 'text', label: 'Tamanho', max: 6, required: true },
            { key: 'width', type: 'number', label: 'Largura (cm)', min: 10, max: 200, step: 0.5 },
            { key: 'length', type: 'number', label: 'Comprimento (cm)', min: 10, max: 200, step: 0.5 },
          ],
        },
        { key: 'note', type: 'text', label: 'Observação', max: 200 },
      ],
    },
    { key: 'howToMeasure', type: 'text', label: 'Como medir', max: 300, multiline: true, required: true },
    { key: 'recommender', type: 'toggle', label: 'Ajuda para escolher (comparar com uma peça que a pessoa já tem)' },
    { key: 'accent', type: 'colorToken', label: 'Cor' },
  ],
  defaults: {
    linkLabel: 'Guia de medidas',
    tables: [],
    howToMeasure: 'Estenda uma camiseta sua que veste bem numa superfície plana. Largura: de uma axila à outra. Comprimento: do ponto mais alto do ombro até a barra.',
    recommender: true,
    accent: 'primary',
  },
  check(s) {
    const errs: FieldError[] = [];
    list(s.tables).forEach((t, i) => {
      const sizes = list(t.rows).map((r) => String(r.size).toUpperCase());
      if (new Set(sizes).size !== sizes.length) errs.push({ field: `tables.${i}.rows`, message: `Tabela "${t.name}": tamanhos repetidos.` });
    });
    return errs;
  },
  targets: () => ({ pages: ['product'], devices: ['mobile', 'desktop'] }),
  project: (s, ctx) => ({
    linkLabel: s.linkLabel,
    tables: list(s.tables).map((t) => ({
      name: t.name,
      match: String(t.match)
        .split(',')
        .map((m) => m.trim().toLowerCase())
        .filter(Boolean),
      rows: list(t.rows).map((r) => ({ size: r.size, width: r.width, length: r.length })),
      note: t.note,
    })),
    howToMeasure: s.howToMeasure,
    recommender: s.recommender,
    colors: color(ctx, s.accent),
  }),
};
