import type { ModuleDef, Video } from '../registry.ts';
import { color, pagesField, targetsFrom } from './common.ts';

export function videoProjection(v: Video) {
  return { id: v.id, title: v.title, caption: v.caption, videoUrl: v.videoUrl, posterUrl: v.posterUrl, productPaths: v.productPaths };
}

export const videoCards: ModuleDef = {
  id: 'videoCards',
  code: 'M08',
  name: 'Cards de vídeos com produtos',
  summary: 'Vídeos curtos em cards com capa; ao abrir, o vídeo toca com acesso à peça. Na página do produto, mostra os vídeos vinculados a ela.',
  pages: ['home', 'product'],
  integrations: ['media.library'],
  fields: [
    { key: 'title', type: 'text', label: 'Título da seção', max: 60, required: true },
    { key: 'videos', type: 'videoRefs', label: 'Vídeos da seção (início)', max: 12, help: 'Cadastre os vídeos em Biblioteca de vídeos.' },
    { key: 'onProduct', type: 'toggle', label: 'Na página do produto, mostrar os vídeos vinculados à peça' },
    { key: 'ctaLabel', type: 'text', label: 'Texto do botão da peça', max: 30, required: true },
    {
      key: 'shape',
      type: 'select',
      label: 'Formato dos cards',
      options: [
        { value: 'retrato', label: 'Vertical (9:16)' },
        { value: 'quadrado', label: 'Quadrado' },
      ],
    },
    {
      key: 'position',
      type: 'select',
      label: 'Posição no início',
      options: [
        { value: 'apos-banner', label: 'Logo depois do banner' },
        { value: 'antes-rodape', label: 'Antes do rodapé' },
      ],
    },
    pagesField(['home', 'product']),
    { key: 'accent', type: 'colorToken', label: 'Cor do botão' },
  ],
  defaults: {
    title: 'Veja no corpo',
    videos: [],
    onProduct: true,
    ctaLabel: 'Ver peça',
    shape: 'retrato',
    position: 'apos-banner',
    pages: ['home', 'product'],
    accent: 'primary',
  },
  check(s, { library }) {
    const pages = s.pages as string[];
    if (pages.includes('home') && !(s.videos as string[]).length && library.videos.length) {
      return [{ field: 'videos', message: 'Escolha os vídeos da seção do início (ou tire o início das páginas).' }];
    }
    return [];
  },
  publishCheck(s) {
    return (s.pages as string[]).includes('home') && !(s.videos as string[]).length
      ? [{ field: 'videos', message: 'Vídeos: escolha pelo menos um vídeo para a seção do início.' }]
      : [];
  },
  targets: (s) => targetsFrom(s, ['home']),
  project(s, ctx) {
    const byId = new Map(ctx.library.videos.map((v) => [v.id, v]));
    const chosen = (s.videos as string[]).map((id) => byId.get(id)).filter((v): v is Video => !!v);
    return {
      title: s.title,
      videos: chosen.map(videoProjection),
      // Vídeos com produto vinculado, para a página do produto.
      productVideos: s.onProduct ? ctx.library.videos.filter((v) => v.productPaths.length).map(videoProjection) : [],
      ctaLabel: s.ctaLabel,
      shape: s.shape,
      position: s.position,
      colors: color(ctx, s.accent),
    };
  },
};
