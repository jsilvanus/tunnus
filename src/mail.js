import nodemailer from 'nodemailer';
import { t } from './i18n.js';

/**
 * @typedef {{ to: string, subject: string, text: string }} Message
 * @typedef {{ send(message: Message): Promise<void> }} Transport
 * @typedef {{
 *   sendCode(to: string, code: string, link: string, locale: import('./i18n.js').Locale): Promise<void>,
 *   sendInactiveWarning(to: string, deleteOn: Date, locale: import('./i18n.js').Locale): Promise<void>,
 * }} Mailer
 */

/**
 * Split `Name <addr@host>` into parts.
 * @param {string} from
 */
export function parseFrom(from) {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(from);
  return m ? { name: m[1] || undefined, email: m[2] } : { name: undefined, email: from.trim() };
}

/**
 * Footer shared by all mails: the controller (when configured) and a link to the privacy notice.
 * @param {import('./config.js').Config} config
 * @param {import('./i18n.js').Locale} locale
 */
function mailFooter(config, locale) {
  const privacyUrl = config.brand.privacyNoticeUrl || `${config.issuer}/privacy`;
  const lines = [];
  if (config.controller.name) {
    const contact = config.controller.contact ? ` (${config.controller.contact})` : '';
    lines.push(`${t(locale, 'mail_controller', { controller: config.controller.name })}${contact}`);
  }
  lines.push(t(locale, 'mail_privacy_link', { url: privacyUrl }));
  return `\n\n-- \n${lines.join('\n')}`;
}

/**
 * Build the sign-in mail (subject, text) for a locale, with the mail footer.
 * @param {import('./config.js').Config} config
 * @param {string} code
 * @param {string} link
 * @param {import('./i18n.js').Locale} locale
 */
export function buildCodeMail(config, code, link, locale) {
  return {
    subject: t(locale, 'mail_subject', { code }),
    text: t(locale, 'mail_body', { code, link }) + mailFooter(config, locale),
  };
}

/**
 * Build the inactivity warning (subject, text). The deletion date is written as YYYY-MM-DD in UTC.
 * @param {import('./config.js').Config} config
 * @param {import('./i18n.js').Locale} locale
 * @param {Date} deleteOn
 */
export function buildInactiveWarningMail(config, locale, deleteOn) {
  const brand = config.brand.name;
  const date = deleteOn.toISOString().slice(0, 10);
  return {
    subject: t(locale, 'mail_inactive_subject', { brand }),
    text: t(locale, 'mail_inactive_body', { brand, date }) + mailFooter(config, locale),
  };
}

/**
 * @param {import('./config.js').Config} config
 * @param {Transport} transport
 * @returns {Mailer}
 */
export function createMailer(config, transport) {
  return {
    async sendCode(to, code, link, locale) {
      await transport.send({ to, ...buildCodeMail(config, code, link, locale) });
    },
    async sendInactiveWarning(to, deleteOn, locale) {
      await transport.send({ to, ...buildInactiveWarningMail(config, locale, deleteOn) });
    },
  };
}

/**
 * Development transport that logs instead of sending.
 * @param {{ info: (o: object, m: string) => void }} logger
 * @returns {Transport}
 */
export function createConsoleTransport(logger) {
  return {
    async send(message) {
      logger.info(
        { to: message.to, subject: message.subject, text: message.text },
        'mail (console provider)',
      );
    },
  };
}

/** Timeout for one call to the mail provider, in milliseconds. */
export const MAIL_TIMEOUT_MS = 10_000;

/**
 * Nodemailer options for the SMTP transport: the URL plus connect, greeting and socket timeouts,
 * so a hung server cannot hold a request open.
 * @param {string} smtpUrl
 */
export function smtpTransportOptions(smtpUrl) {
  return {
    url: smtpUrl,
    connectionTimeout: MAIL_TIMEOUT_MS,
    greetingTimeout: MAIL_TIMEOUT_MS,
    socketTimeout: MAIL_TIMEOUT_MS,
  };
}

/**
 * @param {string} smtpUrl
 * @param {string} from
 * @returns {Transport}
 */
export function createSmtpTransport(smtpUrl, from) {
  const transporter = nodemailer.createTransport(smtpTransportOptions(smtpUrl));
  return {
    async send(message) {
      await transporter.sendMail({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    },
  };
}

/**
 * Brevo transactional email API.
 * @param {string} apiKey
 * @param {string} from
 * @param {typeof fetch} [fetchImpl]
 * @returns {Transport}
 */
export function createBrevoTransport(apiKey, from, fetchImpl = fetch) {
  const sender = parseFrom(from);
  return {
    async send(message) {
      const res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          sender,
          to: [{ email: message.to }],
          subject: message.subject,
          textContent: message.text,
        }),
        signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Brevo responded ${res.status}`);
    },
  };
}

/**
 * @param {import('./config.js').Config} config
 * @param {{ info: (o: object, m: string) => void }} logger
 * @returns {Mailer}
 */
export function createMailerFromConfig(config, logger) {
  const transport =
    config.mailProvider === 'smtp'
      ? createSmtpTransport(config.smtpUrl, config.mailFrom)
      : config.mailProvider === 'brevo'
        ? createBrevoTransport(config.brevoApiKey, config.mailFrom)
        : createConsoleTransport(logger);
  return createMailer(config, transport);
}
