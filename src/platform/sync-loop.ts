// Leitura periódica das lojas (FAQ, cupons, API da INK). Uma loja por vez, só as que estão
// com retrato velho; falhas ficam registradas na integração e o último retrato bom é mantido.
import { SYNC_STALE_MS, type IntegrationService } from './integration.ts';
import type { StoreService } from './stores.ts';

export function startSyncLoop(deps: { stores: StoreService; integration: IntegrationService; everyMin: number; log: (m: string) => void; staleMs?: number }): () => void {
  if (!deps.everyMin) return () => undefined;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const store of deps.stores.list()) {
        if (store.status === 'paused' || store.kind === 'demo') continue;
        const at = deps.integration.status(store.id).site.fetchedAt;
        if (at && Date.now() - Date.parse(at) < (deps.staleMs ?? SYNC_STALE_MS)) continue;
        const st = await deps.integration.syncSite(store).catch((err: Error) => {
          deps.log(`leitura de ${store.id} falhou: ${err.message}`);
          return null;
        });
        if (st?.site.error) deps.log(`leitura de ${store.id}: ${st.site.error}`);
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.everyMin * 60_000);
  timer.unref();
  setTimeout(() => void tick(), 30_000).unref();
  return () => clearInterval(timer);
}
