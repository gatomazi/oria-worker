// Ponto de entrada do serviço (painel + serviço público consultado pelo Worker das lojas).
//  - Local (padrão): painel em 127.0.0.1:4000, serviço público em :4001 e as réplicas das
//    lojas demo; o Worker roda à parte (wrangler dev).
//  - Hospedado (ORIA_MODE=hosted): um processo, uma porta (PORT), atrás de TLS. O host do
//    pedido decide: PANEL_ORIGIN → painel; PUBLIC_ORIGIN → serviço público. Ver docs/decisoes.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createAdminHandler } from './admin-server.ts';
import { AssistantService } from './assistant.ts';
import { Auth } from './auth.ts';
import { LocalBlobStore, R2BlobStore } from './blobs.ts';
import { CatalogReader } from './catalog.ts';
import { ConfigError, loadConfig, testStoreUrl, type AppConfig } from './config.ts';
import { openDb } from './db.ts';
import { IntegrationService } from './integration.ts';
import { createMailer } from './mailer.ts';
import { MediaStore } from './media.ts';
import { createPublicHandler } from './public-server.ts';
import { createReplayOrigin } from './replay-origin.ts';
import { DEMO_ORIGIN_PORTS, seed } from './seed.ts';
import { StoreService } from './stores.ts';
import { loadSecret } from './tokens.ts';
import { startSyncLoop } from './sync-loop.ts';
import { backupDb, startBackupLoop } from './backup.ts';
import '../shared/modules/index.ts';

let cfg: AppConfig;
try {
  cfg = loadConfig();
} catch (err) {
  console.error(`[oria] ${(err as Error).message}`);
  process.exit(err instanceof ConfigError ? 2 : 1);
}
const tag = cfg.mode === 'hosted' ? '[oria]' : '[local]';

function listen(server: Server, port: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => reject(new Error(`${label}: não foi possível usar a porta ${port} (${(err as Error).message})`)));
    server.listen(port, cfg.bindHost, () => resolve());
  });
}

const db = openDb(cfg.dataDir);
const secret = cfg.secretB64 ? Buffer.from(cfg.secretB64, 'base64') : loadSecret(cfg.dataDir);
const auth = new Auth(db);
const stores = new StoreService(db);
seed(stores, { demos: cfg.seedDemo });
const blobs =
  cfg.media.backend === 'r2'
    ? new R2BlobStore({ endpoint: cfg.media.endpoint, bucket: cfg.media.bucket, accessKeyId: cfg.media.accessKeyId, secretAccessKey: cfg.media.secretAccessKey })
    : new LocalBlobStore(cfg.dataDir);
const media = new MediaStore(db, blobs);
const catalog = new CatalogReader();
const integration = new IntegrationService({ db, catalog, secret });
const assistant = new AssistantService({ stores, catalog, db, secret, integration });
const mailer = createMailer(cfg);
const storeUrl = (s: { devHost: string; basePath: string }) => testStoreUrl(cfg, s);

const admin = createAdminHandler({
  auth,
  stores,
  media,
  catalog,
  secret,
  panelOrigin: cfg.panelOrigin,
  mailer,
  storeUrl,
  install: { workerPort: cfg.workerPort, publicPort: cfg.publicPort, publicOrigin: cfg.publicOrigin, panelOrigin: cfg.panelOrigin, hosted: cfg.mode === 'hosted', stores, auth, integration },
  integration,
});
const pub = createPublicHandler({ stores, media, secret, assistant });

const servers: Server[] = [];
if (cfg.mode === 'hosted') {
  const panelHost = new URL(cfg.panelOrigin).host;
  const one = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    // O proxy de TLS repassa o host original; o painel só responde no host dele.
    return (req.headers.host === panelHost ? admin : pub)(req, res);
  });
  await listen(one, cfg.port, 'serviço');
  servers.push(one);
  console.log(`${tag} painel ${cfg.panelOrigin} · serviço público ${cfg.publicOrigin} · porta ${cfg.port}`);
  console.log(`${tag} mídia: ${media.backend} · e-mail: ${mailer.delivery === 'email' ? 'enviado pelo provedor' : 'caixa de saída local (envio real pendente)'}`);
} else {
  const a = createServer(admin);
  await listen(a, cfg.adminPort, 'painel');
  const p = createServer(pub);
  await listen(p, cfg.publicPort, 'serviço público');
  servers.push(a, p);
  if (cfg.seedDemo && process.env.START_ORIGINS !== '0') {
    for (const [id, port] of Object.entries(DEMO_ORIGIN_PORTS)) {
      const origin = createReplayOrigin(id);
      await listen(origin, port, `réplica ${id}`);
      servers.push(origin);
    }
  }
  console.log(`${tag} dados em ${cfg.dataDir}/pink.db`);
  console.log(`${tag} painel           ${cfg.panelOrigin}/`);
  for (const s of stores.list()) console.log(`${tag} ${s.id.padEnd(16)} ${storeUrl(s)}`);
}

if (!auth.hasOperator()) {
  const email = (process.env.OPERATOR_EMAIL ?? 'operador@local.invalid').toLowerCase();
  const password = process.env.OPERATOR_PASSWORD;
  const user =
    auth.userByEmail(email) ?? auth.createUser({ email, name: process.env.OPERATOR_NAME ?? 'Operador', role: 'operator', storeId: null, password: password && password.length >= 10 ? password : undefined });
  if (!password) {
    const token = auth.createInvite(user.id);
    console.log(`\n${tag} PRIMEIRO ACESSO do operador (${email}): defina a senha em\n        ${cfg.panelOrigin}/#/convite/${token}\n`);
  }
}

const stopSync = startSyncLoop({ stores, integration, everyMin: cfg.syncEveryMin, log: (m) => console.log(`${tag} ${m}`) });
const stopBackup = startBackupLoop(
  async () => {
    const out = await backupDb(db, cfg.dataDir, cfg.media.backend === 'r2' ? blobs : null);
    console.log(`${tag} cópia do banco: ${out.remoteKey ?? out.file}`);
  },
  cfg.backupEveryHours,
  (m) => console.log(`${tag} ${m}`),
);

function shutdown() {
  stopSync();
  stopBackup();
  for (const s of servers) {
    s.close();
    s.closeAllConnections();
  }
  db.close();
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
