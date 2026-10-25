// Ambiente local: painel/API, serviço público e as origens das lojas demo
// (réplica INK). O Worker roda à parte (wrangler dev).
import type { Server } from 'node:http';
import { createAdminServer } from './admin-server.ts';
import { AssistantService } from './assistant.ts';
import { Auth } from './auth.ts';
import { CatalogReader } from './catalog.ts';
import { openDb } from './db.ts';
import { IntegrationService } from './integration.ts';
import { MediaStore } from './media.ts';
import { createPublicServer } from './public-server.ts';
import { createReplayOrigin } from './replay-origin.ts';
import { DEMO_ORIGIN_PORTS, seed } from './seed.ts';
import { StoreService } from './stores.ts';
import { loadSecret } from './tokens.ts';
import '../shared/modules/index.ts';

const HOST = '127.0.0.1';
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 4000);
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT ?? 4001);
const WORKER_PORT = Number(process.env.WORKER_PORT ?? 8787);
const DATA_DIR = process.env.DATA_DIR ?? 'data';

function listen(server: Server, port: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => reject(new Error(`${label}: não foi possível usar a porta ${port} (${(err as Error).message})`)));
    server.listen(port, HOST, () => resolve());
  });
}

const db = openDb(DATA_DIR);
const secret = loadSecret(DATA_DIR);
const auth = new Auth(db);
const stores = new StoreService(db);
seed(stores);
const media = new MediaStore(db, DATA_DIR);
const catalog = new CatalogReader();
const integration = new IntegrationService({ db, catalog, secret });
const assistant = new AssistantService({ stores, catalog, db, secret, integration });
const storeUrl = (s: { devHost: string; basePath: string }) => `http://${s.devHost}:${WORKER_PORT}${s.basePath}`;

const servers: Server[] = [];
const admin = createAdminServer({
  auth,
  stores,
  media,
  catalog,
  secret,
  port: ADMIN_PORT,
  storeUrl,
  install: { workerPort: WORKER_PORT, publicPort: PUBLIC_PORT, stores, auth },
  integration,
});
await listen(admin, ADMIN_PORT, 'painel');
servers.push(admin);
const pub = createPublicServer({ stores, media, secret, assistant });
await listen(pub, PUBLIC_PORT, 'serviço público');
servers.push(pub);
if (process.env.START_ORIGINS !== '0') {
  for (const [id, port] of Object.entries(DEMO_ORIGIN_PORTS)) {
    const origin = createReplayOrigin(id);
    await listen(origin, port, `réplica ${id}`);
    servers.push(origin);
  }
}

console.log(`[local] dados em ${DATA_DIR}/pink.db`);
console.log(`[local] painel           http://${HOST}:${ADMIN_PORT}/`);
for (const s of stores.list()) console.log(`[local] ${s.id.padEnd(16)} ${storeUrl(s)}`);
if (!auth.hasOperator()) {
  const email = (process.env.OPERATOR_EMAIL ?? 'operador@local.invalid').toLowerCase();
  const password = process.env.OPERATOR_PASSWORD;
  const user =
    auth.userByEmail(email) ?? auth.createUser({ email, name: process.env.OPERATOR_NAME ?? 'Operador', role: 'operator', storeId: null, password: password && password.length >= 10 ? password : undefined });
  if (!password) {
    const token = auth.createInvite(user.id);
    console.log(`\n[local] PRIMEIRO ACESSO do operador (${email}): defina a senha em\n        http://${HOST}:${ADMIN_PORT}/#/convite/${token}\n`);
  }
}

function shutdown() {
  for (const s of servers) {
    s.close();
    s.closeAllConnections();
  }
  db.close();
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
