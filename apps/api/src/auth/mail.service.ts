import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Mail delivery boundary. SMTP transport is a launch task (see docs/PROGRESS.md);
 * until configured, non-production environments capture mail in memory for tests and local use.
 * Mail bodies may contain one-time tokens, so they are never written to logs.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  readonly devOutbox: OutgoingMail[] = [];

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async send(mail: OutgoingMail): Promise<void> {
    if (!this.config.SMTP_URL) {
      if (this.config.NODE_ENV === 'production') {
        throw new Error('SMTP is not configured; refusing to drop transactional email in production');
      }
      this.devOutbox.push(mail);
      if (this.devOutbox.length > 200) this.devOutbox.shift();
      this.logger.log(`Mail captured (SMTP unconfigured): subject="${mail.subject}"`);
      return;
    }
    // Wired in the operational-hardening milestone with a vetted SMTP client.
    throw new Error('SMTP transport not implemented yet');
  }
}
