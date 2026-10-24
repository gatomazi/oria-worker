import type { ModuleDef, Video } from '../registry.ts';
import { color, devicesField, pagesField, targetsFrom } from './common.ts';
import { videoProjection } from './m08-video-cards.ts';

export const miniPlayer: ModuleDef = {
  id: 'miniPlayer',
  code: 'M09',
  name: 'Mini player de vídeo',
  summary: 'Player compacto e flutuante com os vídeos da biblioteca; respeita o fechamento e se recolhe quando carrinho, compra ou chat estão em uso.',
  pages: ['home', 'listing', 'product'],
  integrations: ['media.library'],
  fields: [
    {
      key: 'source',
      type: 'select',
      label: 'Qual vídeo',
      options: [
        { value: 'produto-primeiro', label: 'Na página do produto, o vídeo da peça; nas outras, a lista abaixo' },
        { value: 'lista', label: 'Sempre a lista abaixo' },
      ],
    },
    { key: 'videos', type: 'videoRefs', label: 'Vídeos', max: 6 },
    {
      key: 'position',
      type: 'select',
      label: 'Posição',
      options: [
        { value: 'inferior-esquerda', label: 'Canto inferior esquerdo' },
        { value: 'inferior-direita', label: 'Canto inferior direito' },
      ],
    },
    {
      key: 'size',
      type: 'select',
      label: 'Tamanho',
      options: [
        { value: 'pequeno', label: 'Pequeno' },
        { value: 'medio', label: 'Médio' },
      ],
    },
    {
      key: 'frequency',
      type: 'select',
      label: 'Frequência',
      options: [
        { value: 'sessao', label: 'Uma vez por visita (some ao fechar)' },
        { value: 'dia', label: 'Uma vez por dia' },
        { value: 'sempre', label: 'Em toda página (até fechar)' },
      ],
    },
    { key: 'delaySeconds', type: 'number', label: 'Aparecer depois de', min: 0, max: 60, integer: true, unit: 'segundos' },
    {
      key: 'priority',
      type: 'select',
      label: 'Quando houver outro elemento flutuante (chat)',
      options: [
        { value: 'ceder', label: 'Dar a vez ao outro elemento' },
        { value: 'normal', label: 'Aparecer no lado oposto' },
      ],
    },
    pagesField(['home', 'listing', 'product']),
    devicesField,
    { key: 'accent', type: 'colorToken', label: 'Cor do botão' },
  ],
  defaults: {
    source: 'produto-primeiro',
    videos: [],
    position: 'inferior-esquerda',
    size: 'pequeno',
    frequency: 'sessao',
    delaySeconds: 4,
    priority: 'ceder',
    pages: ['home', 'product'],
    devices: ['mobile', 'desktop'],
    accent: 'primary',
  },
  publishCheck(s) {
    return s.source === 'lista' && !(s.videos as string[]).length ? [{ field: 'videos', message: 'Mini player: escolha pelo menos um vídeo.' }] : [];
  },
  targets: (s) => targetsFrom(s, ['home']),
  project(s, ctx) {
    const byId = new Map(ctx.library.videos.map((v) => [v.id, v]));
    return {
      source: s.source,
      videos: (s.videos as string[]).map((id) => byId.get(id)).filter((v): v is Video => !!v).map(videoProjection),
      productVideos: s.source === 'produto-primeiro' ? ctx.library.videos.filter((v) => v.productPaths.length).map(videoProjection) : [],
      position: s.position,
      size: s.size,
      frequency: s.frequency,
      delaySeconds: s.delaySeconds,
      priority: s.priority,
      colors: color(ctx, s.accent),
    };
  },
};
