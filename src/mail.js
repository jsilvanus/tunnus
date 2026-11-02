import nodemailer from 'nodemailer';
import { t } from './i18n.js';

/**
 * @typedef {{ to: string, subject: string, text: string }} Message
 * @typedef {{ send(message: Message): Promise<void> }} Transport
 * @typedef {{ sendCode(to: string, code: string, link: string, locale: import('./i18n.js').Locale): Promise<void> }} Mailer
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
 * Build the sign-in mail (subject, text) for a locale, with a controller footer.
 * @param {import('./config.js').Config} config
 * @param {string} code
 * @param {string} link
 * @param {import('./i18n.js').Locale} locale
 */
export function buildCodeMail(config, code, link, locale) {
  const footer = config.controller.name
    ? `\n\n-- \n${t(locale, 'mail_controller', { controller: config.controller.name })}${config.controller.contact ? ` (${config.controller.contact})` : ''}`
    : '';
  return {
    subject: t(locale, 'mail_subject', { code }),
    text: t(locale, 'mail_body', { code, link }) + footer,
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

/**
 * @param {string} smtpUrl
 * @param {string} from
 * @returns {Transport}
 */
export function createSmtpTransport(smtpUrl, from) {
  const transporter = nodemailer.createTransport(smtpUrl);
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
