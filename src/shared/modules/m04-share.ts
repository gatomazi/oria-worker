import type { ModuleDef } from '../registry.ts';
import { color } from './common.ts';

export const share: ModuleDef = {
  id: 'share',
  code: 'M04',
  name: 'Compartilhamento de produto',
  summary: 'WhatsApp, copiar link e o compartilhar do celular, com o link limpo do produto.',
  pages: ['product'],
  integrations: [],
  fields: [
    { key: 'label', type: 'text', label: 'Título do bloco', max: 40, required: true },
    {
      key: 'channels',
      type: 'multiselect',
      label: 'Canais',
      min: 1,
      options: [
        { value: 'whatsapp', label: 'WhatsApp' },
        { value: 'copy', label: 'Copiar link' },
        { value: 'native', label: 'Compartilhar do celular (quando disponível)' },
      ],
    },
    {
      key: 'message',
      type: 'text',
      label: 'Mensagem',
      max: 120,
      required: true,
      help: 'Use {produto} para o nome da peça. O link vai no final.',
    },
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
    label: 'Compartilhar',
    channels: ['whatsapp', 'copy', 'native'],
    message: 'Olha que legal: {produto}',
    position: 'abaixo-comprar',
    accent: 'primary',
  },
  check(s) {
    const msg = typeof s.message === 'string' ? s.message : '';
    return /\{(?!produto\})[^}]*\}/.test(msg) ? [{ field: 'message', message: 'Mensagem: o único marcador aceito é {produto}.' }] : [];
  },
  targets: () => ({ pages: ['product'], devices: ['mobile', 'desktop'] }),
  project: (s, ctx) => ({ label: s.label, channels: s.channels, message: s.message, position: s.position, colors: color(ctx, s.accent) }),
};
