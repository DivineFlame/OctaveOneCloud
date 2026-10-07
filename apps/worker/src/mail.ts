import { AppConfig } from '@ooc/shared';
import { log } from './log';

export interface Mailer {
  send(m: { to: string[]; subject: string; text: string }): Promise<boolean>;
}

interface Transport {
  sendMail(m: { from: string; to: string; subject: string; text: string }): Promise<{ messageId?: string }>;
}

/** SMTP mail for worker notifications (renewal reminders). Without SMTP (dev/test) mail is only logged by subject. */
export function createMailer(config: AppConfig): Mailer {
  let transport: Transport | null = null;
  return {
    async send(m) {
      if (!config.SMTP_URL) {
        log('info', 'mail not sent (SMTP unconfigured)', { subject: m.subject, recipients: m.to.length });
        return false;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        transport ??= (require('nodemailer') as { createTransport(url: string): Transport }).createTransport(config.SMTP_URL);
        await transport.sendMail({ from: config.MAIL_FROM!, to: m.to.join(', '), subject: m.subject, text: m.text });
        return true;
      } catch (e) {
        log('error', 'mail delivery failed', { subject: m.subject, error: (e as Error).message });
        return false;
      }
    },
  };
}
