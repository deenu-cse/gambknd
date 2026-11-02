import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { env, isTest } from '../config/env.js';
import { logger } from '../config/logger.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Test env: delivered messages are kept here so tests can read reset/verify links. */
export const testOutbox: MailMessage[] = [];

let transporter: Transporter | undefined;

function getTransport(): Transporter {
  transporter ??= env.SMTP_URL
    ? nodemailer.createTransport(env.SMTP_URL)
    : // No SMTP configured: render the full RFC822 message and drop it into the local outbox folder.
      nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  return transporter;
}

/**
 * Sends an email. Without SMTP_URL, messages are written to MAIL_OUTBOX_DIR as .eml files
 * (open them in any mail client). Links in these emails are credentials, so they are never logged.
 */
export async function sendMail(msg: MailMessage): Promise<void> {
  if (isTest) {
    testOutbox.push(msg);
    return;
  }
  const info = (await getTransport().sendMail({ from: env.MAIL_FROM, ...msg })) as { message?: Buffer; messageId?: string };
  if (!env.SMTP_URL && info.message) {
    const dir = path.resolve(env.MAIL_OUTBOX_DIR);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${msg.subject.replace(/\W+/g, '_').slice(0, 40)}.eml`);
    await writeFile(file, info.message);
    logger.info({ file, subject: msg.subject }, 'email written to local outbox');
    return;
  }
  logger.info({ messageId: info.messageId, subject: msg.subject }, 'email sent');
}
