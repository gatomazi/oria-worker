// E-mails transacionais do painel (convite e redefinição de senha).
//  - Desenvolvimento e testes: caixa de saída local (DATA_DIR/outbox/*.json), nada sai da máquina.
//  - Hospedado: Resend (API HTTP). Sem chave ou remetente homologado, o processo não sobe com
//    MAIL_PROVIDER=resend; com MAIL_PROVIDER=outbox o painel funciona e mostra o link ao operador.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from './config.ts';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  /** 'outbox' = não envia de verdade (o painel mostra o link para repassar). */
  readonly delivery: 'outbox' | 'email';
  send(mail: Mail): Promise<void>;
}

export class OutboxMailer implements Mailer {
  readonly delivery = 'outbox' as const;
  readonly sent: Mail[] = [];
  private dir: string | null;
  constructor(dataDir: string | null) {
    this.dir = dataDir ? join(dataDir, 'outbox') : null;
  }
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
    if (!this.dir) return;
    await mkdir(this.dir, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${mail.to.replace(/[^a-z0-9@.-]/gi, '_')}.json`;
    await writeFile(join(this.dir, name), JSON.stringify(mail, null, 2));
  }
}

export class ResendMailer implements Mailer {
  readonly delivery = 'email' as const;
  private apiKey: string;
  private from: string;
  private fetchImpl: typeof fetch;
  constructor(apiKey: string, from: string, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.from = from;
    this.fetchImpl = fetchImpl;
  }
  async send(mail: Mail): Promise<void> {
    const res = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`o provedor de e-mail respondeu ${res.status}`);
  }
}

export function createMailer(cfg: AppConfig): Mailer {
  return cfg.mail.provider === 'resend' ? new ResendMailer(cfg.mail.apiKey, cfg.mail.from) : new OutboxMailer(cfg.dataDir);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function layout(title: string, lines: string[], cta: { label: string; url: string }, footer: string): Pick<Mail, 'text' | 'html'> {
  const text = [title, '', ...lines, '', `${cta.label}: ${cta.url}`, '', footer, '', 'Oria'].join('\n');
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f6f5f2;font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c1b19">
<div style="max-width:520px;margin:0 auto;padding:32px 20px">
<p style="margin:0 0 20px;font-weight:700;color:#1b3a6b">Oria</p>
<div style="background:#fff;border-radius:12px;padding:28px">
<h1 style="margin:0 0 12px;font-size:20px">${esc(title)}</h1>
${lines.map((l) => `<p style="margin:0 0 12px">${esc(l)}</p>`).join('')}
<p style="margin:20px 0"><a href="${esc(cta.url)}" style="display:inline-block;background:#1b3a6b;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:6px">${esc(cta.label)}</a></p>
<p style="margin:0;color:#6f6a60;font-size:13px">${esc(footer)}</p>
</div></div></body></html>`;
  return { text, html };
}

export function inviteMail(to: string, name: string, storeName: string | null, url: string): Mail {
  return {
    to,
    subject: storeName ? `Seu acesso ao painel da ${storeName}` : 'Seu acesso ao painel Oria',
    ...layout(
      `Olá, ${name}`,
      [storeName ? `Você recebeu acesso ao painel da loja ${storeName}. Defina sua senha para entrar.` : 'Você recebeu acesso ao painel Oria. Defina sua senha para entrar.'],
      { label: 'Definir minha senha', url },
      'O link vale por 7 dias e só pode ser usado uma vez. Se você não esperava este convite, ignore este e-mail.',
    ),
  };
}

export function resetMail(to: string, name: string, url: string): Mail {
  return {
    to,
    subject: 'Redefinir sua senha do painel Oria',
    ...layout(
      `Olá, ${name}`,
      ['Recebemos um pedido para redefinir a senha do seu acesso ao painel.'],
      { label: 'Criar nova senha', url },
      'O link vale por 1 hora e só pode ser usado uma vez. Se não foi você, ignore este e-mail: sua senha continua a mesma.',
    ),
  };
}
