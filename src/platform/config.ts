// Configuração por ambiente. Local: tudo em 127.0.0.1, como sempre. Hospedado: um processo
// só, atrás de TLS, atendendo o painel e o serviço público pelo host (ver docs/decisoes).
// Nenhum segredo tem valor padrão; faltando algo obrigatório no modo hospedado, o processo
// não sobe e diz exatamente o que falta.

export interface AppConfig {
  mode: 'local' | 'hosted';
  /** Interface de escuta (local: 127.0.0.1; hospedado: 0.0.0.0). */
  bindHost: string;
  /** Local: portas separadas do painel e do serviço público. */
  adminPort: number;
  publicPort: number;
  workerPort: number;
  /** Hospedado: a porta única que a plataforma injeta (PORT). */
  port: number;
  dataDir: string;
  /** Origem do painel, ex.: https://painel.oria.app. Única autorizada a escrever e a enquadrar a prévia. */
  panelOrigin: string;
  /** Origem do serviço público consultado pelo Worker das lojas (CONFIG_SERVICE_URL do Worker). */
  publicOrigin: string;
  /** Endereço de teste das lojas: esquema e porta do Worker de teste (local: http + 8787). */
  testScheme: 'http' | 'https';
  testPort: number | null;
  /** Sufixo do endereço de teste padrão de uma loja nova: <id>.<sufixo> (local: localhost). */
  testHostSuffix: string;
  seedDemo: boolean;
  /** Leitura periódica das lojas (minutos; 0 = desligada). */
  syncEveryMin: number;
  /** Cópia periódica do banco (horas; 0 = desligada). */
  backupEveryHours: number;
  media: { backend: 'local' } | { backend: 'r2'; accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string; endpoint: string };
  mail: { provider: 'outbox' } | { provider: 'resend'; apiKey: string; from: string };
  /** Segredo do serviço (assina prévias, cifra tokens da INK). Hospedado: APP_SECRET; local: arquivo em DATA_DIR. */
  secretB64: string | null;
}

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const mode = env.ORIA_MODE === 'hosted' ? 'hosted' : 'local';
  const missing: string[] = [];
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) missing.push(k);
    return v ?? '';
  };
  const num = (k: string, d: number) => (env[k] && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
  const origin = (k: string, fallback: string) => {
    const v = mode === 'hosted' ? need(k) : (env[k]?.trim() || fallback);
    if (!v) return '';
    try {
      const u = new URL(v);
      if (mode === 'hosted' && u.protocol !== 'https:') missing.push(`${k} (precisa ser https)`);
      return u.origin;
    } catch {
      missing.push(`${k} (endereço inválido)`);
      return '';
    }
  };

  const adminPort = num('ADMIN_PORT', 4000);
  const publicPort = num('PUBLIC_PORT', 4001);
  const workerPort = num('WORKER_PORT', 8787);
  const media: AppConfig['media'] =
    env.MEDIA_BACKEND === 'r2'
      ? (() => {
          const accountId = need('R2_ACCOUNT_ID');
          return {
            backend: 'r2' as const,
            accountId,
            bucket: need('R2_BUCKET'),
            accessKeyId: need('R2_ACCESS_KEY_ID'),
            secretAccessKey: need('R2_SECRET_ACCESS_KEY'),
            endpoint: env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`,
          };
        })()
      : { backend: 'local' };
  const mail: AppConfig['mail'] = env.MAIL_PROVIDER === 'resend' ? { provider: 'resend', apiKey: need('RESEND_API_KEY'), from: need('MAIL_FROM') } : { provider: 'outbox' };

  const cfg: AppConfig = {
    mode,
    bindHost: env.BIND_HOST?.trim() || (mode === 'hosted' ? '0.0.0.0' : '127.0.0.1'),
    adminPort,
    publicPort,
    workerPort,
    port: num('PORT', 8080),
    dataDir: env.DATA_DIR?.trim() || 'data',
    panelOrigin: origin('PANEL_ORIGIN', `http://127.0.0.1:${adminPort}`),
    publicOrigin: origin('PUBLIC_ORIGIN', `http://127.0.0.1:${publicPort}`),
    testScheme: env.TEST_STORE_SCHEME === 'https' || (mode === 'hosted' && env.TEST_STORE_SCHEME !== 'http') ? 'https' : 'http',
    testPort: env.TEST_STORE_PORT ? Number(env.TEST_STORE_PORT) : mode === 'hosted' ? null : workerPort,
    testHostSuffix: (env.TEST_HOST_SUFFIX?.trim() || 'localhost').replace(/^\./, '').toLowerCase(),
    seedDemo: env.SEED_DEMO ? env.SEED_DEMO === '1' : mode === 'local',
    syncEveryMin: num('SYNC_EVERY_MIN', mode === 'hosted' ? 60 : 0),
    backupEveryHours: num('BACKUP_EVERY_HOURS', mode === 'hosted' ? 24 : 0),
    media,
    mail,
    secretB64: mode === 'hosted' ? need('APP_SECRET') || null : env.APP_SECRET?.trim() || null,
  };
  if (mode === 'hosted') {
    if (cfg.testHostSuffix === 'localhost') missing.push('TEST_HOST_SUFFIX (ex.: teste.seudominio.com.br, para o endereço de teste <loja>.teste.seudominio.com.br)');
    if (cfg.panelOrigin && cfg.panelOrigin === cfg.publicOrigin) missing.push('PANEL_ORIGIN e PUBLIC_ORIGIN precisam ser hosts diferentes');
    if (cfg.secretB64 && Buffer.from(cfg.secretB64, 'base64').length < 32) missing.push('APP_SECRET (32 bytes em base64: openssl rand -base64 32)');
  }
  if (missing.length) throw new ConfigError(`Configuração incompleta: ${missing.join(', ')}.`);
  return cfg;
}

/** Endereço de teste de uma loja (prévia antes da instalação no domínio real). */
export function testStoreUrl(cfg: Pick<AppConfig, 'testScheme' | 'testPort'>, s: { devHost: string; basePath: string }): string {
  return `${cfg.testScheme}://${s.devHost}${cfg.testPort ? `:${cfg.testPort}` : ''}${s.basePath}`;
}
