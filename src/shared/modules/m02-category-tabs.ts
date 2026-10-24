import type { ModuleDef } from '../registry.ts';
import { color, list } from './common.ts';

export const categoryTabs: ModuleDef = {
  id: 'categoryTabs',
  code: 'M02',
  name: 'Categorias em abas na home',
  summary: 'Uma vitrine com abas por coleção: troca os produtos e o "Ver todos" conforme a aba, no lugar de vários carrosséis repetidos.',
  pages: ['home'],
  integrations: ['ink.catalog'],
  fields: [
    { key: 'title', type: 'text', label: 'Título da seção', max: 60 },
    {
      key: 'tabs',
      type: 'list',
      label: 'Abas',
      help: 'Cada aba mostra os produtos de uma coleção ou listagem da loja.',
      itemLabel: 'Aba',
      titleKey: 'label',
      min: 1,
      max: 8,
      fields: [
        { key: 'label', type: 'text', label: 'Nome da aba', max: 30, required: true },
        { key: 'path', type: 'storePath', label: 'Coleção ou listagem', required: true, placeholder: '/minhaloja/collections/verao' },
      ],
    },
    { key: 'initialTab', type: 'number', label: 'Aba aberta ao carregar', min: 1, max: 8, integer: true },
    { key: 'limit', type: 'number', label: 'Produtos por aba', min: 2, max: 12, integer: true },
    { key: 'viewAllLabel', type: 'text', label: 'Texto do "Ver todos"', max: 30, required: true },
    {
      key: 'position',
      type: 'select',
      label: 'Posição na home',
      options: [
        { value: 'apos-banner', label: 'Logo depois do banner' },
        { value: 'antes-produtos', label: 'Antes da vitrine de produtos' },
        { value: 'antes-rodape', label: 'Antes do rodapé' },
      ],
    },
    {
      key: 'hideNative',
      type: 'toggle',
      label: 'Ocultar as vitrines repetidas da home',
      help: 'Esconde as seções nativas cujo "Ver todos" aponta para uma das abas. Elas voltam se as abas não carregarem.',
    },
    { key: 'accent', type: 'colorToken', label: 'Cor da aba ativa' },
  ],
  defaults: {
    title: 'Explore por categoria',
    tabs: [],
    initialTab: 1,
    limit: 8,
    viewAllLabel: 'Ver todos',
    position: 'apos-banner',
    hideNative: false,
    accent: 'primary',
  },
  check(s) {
    const tabs = list(s.tabs);
    const errs = [];
    if (typeof s.initialTab === 'number' && tabs.length && s.initialTab > tabs.length) {
      errs.push({ field: 'initialTab', message: `Aba aberta ao carregar: existem só ${tabs.length} abas.` });
    }
    const paths = tabs.map((t) => t.path);
    if (new Set(paths).size !== paths.length) errs.push({ field: 'tabs', message: 'Abas: há coleções repetidas.' });
    return errs;
  },
  targets: () => ({ pages: ['home'], devices: ['mobile', 'desktop'] }),
  project(s, ctx) {
    return {
      title: s.title,
      tabs: list(s.tabs).map((t) => ({ label: t.label, path: t.path })),
      initialTab: s.initialTab,
      limit: s.limit,
      viewAllLabel: s.viewAllLabel,
      position: s.position,
      hideNative: s.hideNative,
      colors: color(ctx, s.accent),
    };
  },
};
