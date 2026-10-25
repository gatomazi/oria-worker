// Monta a plataforma em processo, com banco temporário, para os testes.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { Auth } from '../src/platform/auth.ts';
import { openDb, type Db } from '../src/platform/db.ts';
import { StoreService } from '../src/platform/stores.ts';
import { MediaStore } from '../src/platform/media.ts';
import { LocalBlobStore } from '../src/platform/blobs.ts';
import { OutboxMailer } from '../src/platform/mailer.ts';
import { SetupService } from '../src/platform/setup.ts';
import { CatalogReader } from '../src/platform/catalog.ts';
import { AssistantService } from '../src/platform/assistant.ts';
import { IntegrationService } from '../src/platform/integration.ts';
import { seed } from '../src/platform/seed.ts';
import { loadSecret } from '../src/platform/tokens.ts';
import '../src/shared/modules/index.ts';

export interface Stack {
  dir: string;
  db: Db;
  auth: Auth;
  stores: StoreService;
  media: MediaStore;
  catalog: CatalogReader;
  assistant: AssistantService;
  integration: IntegrationService;
  mailer: OutboxMailer;
  setup: SetupService;
  secret: Buffer;
  close(): void;
}

export function stack(opts: { fetchImpl?: typeof fetch; apiFetch?: typeof fetch; now?: () => Date; seedDemo?: boolean } = {}): Stack {
  const dir = mkdtempSync(join(tmpdir(), 'pink-test-'));
  const db = openDb(dir);
  const secret = loadSecret(dir);
  const auth = new Auth(db);
  const stores = new StoreService(db, opts.now);
  if (opts.seedDemo !== false) seed(stores);
  const media = new MediaStore(db, new LocalBlobStore(dir));
  const catalog = new CatalogReader(opts.fetchImpl);
  const integration = new IntegrationService({ db, catalog, secret, fetchImpl: opts.apiFetch });
  const assistant = new AssistantService({ stores, catalog, db, secret, integration });
  return {
    dir,
    db,
    auth,
    stores,
    media,
    catalog,
    assistant,
    integration,
    mailer: new OutboxMailer(null),
    setup: new SetupService({ db, stores, integration }),
    secret,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

export function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
}

export const VISTA = {
  id: 'vista-entre-nos',
  name: 'Vista Entre Nós',
  ownerName: 'Gabriel',
  ownerEmail: 'gabriel@exemplo.com',
  domain: 'www.vistaentrenos.com.br',
  basePath: '/vistaentrenos',
  devHost: 'vistaentrenos.localhost',
  packages: ['vitrine'],
};

export const IDENTITY = { logoUrl: '', primary: '#50313D', accent: '#B45309', surface: '#F3E7CF', text: '#2A1A1D', font: 'inherit', style: 'suave' };

export const coupon = (over: Record<string, unknown> = {}) => ({
  title: 'Primeira compra',
  description: 'Cupom de teste.',
  code: 'TESTE10',
  conditions: 'Válido na primeira compra.',
  startsAt: null,
  endsAt: null,
  firstPurchase: true,
  nearPrice: false,
  badge: '',
  ...over,
});
