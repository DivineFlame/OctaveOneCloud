import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

interface Transport {
  sendMail(m: { from: string; to: string; subject: string; text: string }): Promise<{ messageId?: string }>;
}

/**
 * Transactional email over SMTP (SMTP_URL, e.g. smtps://user:pass@smtp.example.com:465).
 * Without SMTP (development/test only — production config validation requires it) mail is captured
 * in memory. Mail bodies can contain one-time tokens, so they are never logged.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transport: Transport | null = null;
  readonly devOutbox: OutgoingMail[] = [];

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private getTransport(): Transport {
    if (!this.transport) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodemailer = require('nodemailer') as { createTransport(url: string): Transport };
      this.transport = nodemailer.createTransport(this.config.SMTP_URL!);
    }
    return this.transport;
  }

  async send(mail: OutgoingMail): Promise<void> {
    if (!this.config.SMTP_URL) {
      if (this.config.NODE_ENV === 'production') throw new Error('SMTP is not configured');
      this.devOutbox.push(mail);
      if (this.devOutbox.length > 200) this.devOutbox.shift();
      this.logger.log(`Mail captured (SMTP unconfigured): subject="${mail.subject}"`);
      return;
    }
    const r = await this.getTransport().sendMail({ from: this.config.MAIL_FROM!, to: mail.to, subject: mail.subject, text: mail.text });
    this.logger.log(`Mail sent: subject="${mail.subject}" id=${r.messageId ?? 'n/a'}`);
  }

  /** Best effort: logs delivery failures instead of failing the caller (user can request a new link). */
  async trySend(mail: OutgoingMail): Promise<boolean> {
    try {
      await this.send(mail);
      return true;
    } catch (e) {
      this.logger.error(`Mail delivery failed: subject="${mail.subject}" error=${(e as Error).message}`);
      return false;
    }
  }
}
