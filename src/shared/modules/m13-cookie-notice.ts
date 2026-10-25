import type { ModuleDef } from '../registry.ts';
import { color, devicesField, pagesField, targetsFrom } from './common.ts';

export const cookieNotice: ModuleDef = {
  id: 'cookieNotice',
  code: 'M13',
  name: 'Aviso de cookies',
  summary: 'Dá ao aviso de privacidade da INK a cara da loja: cartão discreto no canto ou faixa no rodapé, com as cores e os cantos da identidade. O botão continua sendo o da INK, que guarda o aceite.',
  pages: ['home', 'listing', 'product', 'other'],
  integrations: ['ink.cookieAcceptance'],
  fields: [
    {
      key: 'layout',
      type: 'select',
      label: 'Formato',
      options: [
        { value: 'cartao', label: 'Cartão no canto (ocupa menos a tela)' },
        { value: 'faixa', label: 'Faixa no rodapé, de ponta a ponta' },
      ],
    },
    {
      key: 'side',
      type: 'select',
      label: 'Canto do cartão (no computador)',
      showWhen: { key: 'layout', in: ['cartao'] },
      options: [
        { value: 'esquerda', label: 'Inferior esquerdo' },
        { value: 'direita', label: 'Inferior direito' },
      ],
    },
    { key: 'message', type: 'text', label: 'Texto do aviso', max: 180, multiline: true, help: 'Vazio = o texto da INK. O link para a Política de Privacidade continua no fim.' },
    { key: 'buttonLabel', type: 'text', label: 'Texto do botão', max: 24, help: 'Vazio = "Aceitar cookies", como na INK.' },
    { key: 'background', type: 'colorToken', label: 'Fundo' },
    { key: 'accent', type: 'colorToken', label: 'Botão' },
    pagesField(['home', 'listing', 'product', 'other']),
    devicesField,
  ],
  defaults: {
    layout: 'cartao',
    side: 'esquerda',
    message: '',
    buttonLabel: '',
    background: 'neutral',
    accent: 'primary',
    pages: ['home', 'listing', 'product', 'other'],
    devices: ['mobile', 'desktop'],
  },
  targets: (s) => targetsFrom(s, ['home', 'listing', 'product', 'other']),
  project: (s, ctx) => ({
    layout: s.layout,
    side: s.side,
    message: s.message,
    buttonLabel: s.buttonLabel,
    colors: color(ctx, s.background),
    accent: color(ctx, s.accent),
  }),
};
