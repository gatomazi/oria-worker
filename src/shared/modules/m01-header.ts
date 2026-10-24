import type { ModuleDef } from '../registry.ts';
import { color, devicesField, list, pagesField, targetsFrom } from './common.ts';

export const header: ModuleDef = {
  id: 'header',
  code: 'M01',
  name: 'Cabeçalho, menu e busca',
  summary: 'Disposição do logo, cores, links e grupos do menu, comportamento ao rolar e busca. Carrinho e conta continuam no lugar.',
  pages: ['home', 'listing', 'product', 'other'],
  integrations: ['ink.header'],
  fields: [
    {
      key: 'layout',
      type: 'select',
      label: 'Disposição',
      options: [
        { value: 'logo-centro', label: 'Logo no centro (padrão da INK)' },
        { value: 'logo-esquerda', label: 'Logo à esquerda, menu ao lado' },
      ],
    },
    {
      key: 'behavior',
      type: 'select',
      label: 'Ao rolar a página',
      options: [
        { value: 'normal', label: 'Rola junto com a página' },
        { value: 'fixo', label: 'Fica fixo no topo' },
        { value: 'reaparece', label: 'Some ao descer e volta ao subir' },
      ],
    },
    { key: 'background', type: 'colorToken', label: 'Cor de fundo' },
    { key: 'logoWidth', type: 'number', label: 'Largura do logo', min: 60, max: 220, integer: true, unit: 'px' },
    {
      key: 'menu',
      type: 'list',
      label: 'Links do menu',
      help: 'Deixe vazio para manter o menu atual da loja. Itens com o mesmo grupo viram um submenu.',
      itemLabel: 'Link',
      titleKey: 'label',
      min: 0,
      max: 16,
      fields: [
        { key: 'label', type: 'text', label: 'Texto', max: 30, required: true },
        { key: 'path', type: 'storePath', label: 'Destino (caminho na loja)', required: true, placeholder: '/minhaloja/collections/verao' },
        { key: 'group', type: 'text', label: 'Grupo (opcional)', max: 30 },
      ],
    },
    {
      key: 'searchMode',
      type: 'select',
      label: 'Busca',
      options: [
        { value: 'barra', label: 'Barra de busca visível' },
        { value: 'icone', label: 'Ícone que abre a busca' },
      ],
    },
    { key: 'searchPlaceholder', type: 'text', label: 'Texto dentro da busca', max: 60 },
    { key: 'instantSearch', type: 'toggle', label: 'Sugestões enquanto a pessoa digita', help: 'Mostra até 6 peças da busca da própria loja, com foto e preço. Enter continua indo para a busca da INK.' },
    {
      key: 'benefits',
      type: 'select',
      label: 'Faixa de benefícios da INK (ex.: parcelamento)',
      options: [
        { value: 'manter', label: 'Manter' },
        { value: 'ocultar', label: 'Ocultar' },
      ],
    },
    devicesField,
  ],
  defaults: {
    layout: 'logo-centro',
    behavior: 'reaparece',
    background: 'primary',
    logoWidth: 110,
    menu: [],
    searchMode: 'icone',
    searchPlaceholder: 'Buscar produtos',
    instantSearch: false,
    benefits: 'manter',
    devices: ['mobile', 'desktop'],
  },
  check(s) {
    const paths = list(s.menu).map((m) => m.path);
    return new Set(paths).size !== paths.length ? [{ field: 'menu', message: 'Links do menu: há destinos repetidos.' }] : [];
  },
  targets: (s) => targetsFrom({ ...s, pages: ['home', 'listing', 'product', 'other'] }, ['home']),
  project(s, ctx) {
    return {
      layout: s.layout,
      behavior: s.behavior,
      colors: color(ctx, s.background),
      logoUrl: ctx.theme.logoUrl,
      logoWidth: s.logoWidth,
      menu: list(s.menu).map((m) => ({ label: m.label, path: m.path, group: m.group })),
      searchMode: s.searchMode,
      searchPlaceholder: s.searchPlaceholder,
      instantSearch: s.instantSearch === true,
      benefits: s.benefits,
    };
  },
};
