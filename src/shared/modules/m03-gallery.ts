import type { ModuleDef } from '../registry.ts';
import { devicesField, targetsFrom } from './common.ts';

export const gallery: ModuleDef = {
  id: 'gallery',
  code: 'M03',
  name: 'Galeria com miniaturas',
  summary: 'Troca as bolinhas da galeria do produto por miniaturas das fotos, abaixo da imagem principal: numa linha que rola de lado (padrão) ou em várias linhas.',
  pages: ['product'],
  integrations: ['ink.gallery'],
  fields: [
    {
      key: 'size',
      type: 'select',
      label: 'Tamanho das miniaturas',
      options: [
        { value: 'pequena', label: 'Pequena' },
        { value: 'media', label: 'Média' },
        { value: 'grande', label: 'Grande' },
      ],
    },
    {
      key: 'layout',
      type: 'select',
      label: 'Disposição',
      options: [
        { value: 'linha', label: 'Uma linha, rolando de lado' },
        { value: 'grade', label: 'Todas à mostra, em várias linhas' },
      ],
    },
    {
      key: 'activeStyle',
      type: 'select',
      label: 'Destaque da foto atual',
      options: [
        { value: 'borda', label: 'Borda' },
        { value: 'opaco', label: 'Demais fotos mais claras' },
      ],
    },
    { key: 'hideBullets', type: 'toggle', label: 'Esconder as bolinhas da galeria' },
    devicesField,
  ],
  defaults: { size: 'media', layout: 'linha', activeStyle: 'borda', hideBullets: true, devices: ['mobile', 'desktop'] },
  targets: (s) => targetsFrom({ ...s, pages: ['product'] }, ['product']),
  project: (s) => ({ size: s.size, layout: s.layout, activeStyle: s.activeStyle, hideBullets: s.hideBullets }),
};
