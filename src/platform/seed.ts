// Dados iniciais: pacotes de exemplo (sem preço) e duas lojas demo sobre a
// réplica INK. Só cria o que ainda não existe; reiniciar não apaga nada.
import type { StoreService } from './stores.ts';

export const DEMO_ORIGIN_PORTS = { 'demo-aurora': 4101, 'demo-trilha': 4102 } as const;

export function seed(stores: StoreService, opts: { demos?: boolean } = {}): void {
  if (!stores.listPackages().length) {
    // Agrupamentos administráveis. Nomes e preços comerciais ainda não foram definidos.
    stores.savePackage({ id: 'vitrine', name: 'Vitrine', description: 'Navegação e apresentação da loja.', modules: ['header', 'categoryTabs', 'gallery', 'share', 'coupons', 'cookieNotice'] }, null);
    stores.savePackage({ id: 'conversao', name: 'Conversão', description: 'Carrinho, avaliações e informações de compra.', modules: ['cartIncentive', 'reviews', 'sizeGuide', 'delivery'] }, null);
    stores.savePackage({ id: 'conteudo', name: 'Conteúdo e atendimento', description: 'Vídeos com produtos e assistente.', modules: ['videoCards', 'miniPlayer', 'assistant'] }, null);
  }
  if (opts.demos === false) return;
  if (!stores.get('demo-aurora')) {
    stores.createStore(
      {
        id: 'demo-aurora',
        name: 'Ateliê Aurora (demonstração)',
        kind: 'demo',
        ownerName: 'Loja fictícia',
        ownerEmail: 'demo-aurora@exemplo.invalid',
        domain: 'demo-aurora.exemplo.invalid',
        basePath: '/vistaentrenos',
        devHost: 'demo-aurora.localhost',
        devOrigin: `http://127.0.0.1:${DEMO_ORIGIN_PORTS['demo-aurora']}`,
        packages: ['vitrine', 'conversao'],
        notes: 'Demonstração sobre a réplica gravada da INK (offline). Conteúdo e identidade fictícios.',
      },
      { logoUrl: '', primary: '#7A2E3A', accent: '#C2410C', surface: '#FBF3EC', text: '#2A1A1D', font: 'serif', style: 'suave' },
      null,
    );
  }
  if (!stores.get('demo-trilha')) {
    stores.createStore(
      {
        id: 'demo-trilha',
        name: 'Trilha Norte (demonstração)',
        kind: 'demo',
        ownerName: 'Loja fictícia',
        ownerEmail: 'demo-trilha@exemplo.invalid',
        domain: 'demo-trilha.exemplo.invalid',
        basePath: '/vistaentrenos',
        devHost: 'demo-trilha.localhost',
        devOrigin: `http://127.0.0.1:${DEMO_ORIGIN_PORTS['demo-trilha']}`,
        packages: ['vitrine', 'conteudo'],
        notes: 'Demonstração sobre a réplica gravada da INK (offline). Conteúdo e identidade fictícios.',
      },
      { logoUrl: '', primary: '#1F4D3A', accent: '#B7791F', surface: '#F2F5F1', text: '#16241C', font: 'sans', style: 'reto' },
      null,
    );
  }
}
