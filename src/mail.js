import nodemailer from 'nodemailer';
import { t } from './i18n.js';
import { logger as defaultLogger } from './logger.js';

/**
 * A Brevo template to send instead of the text. `params` are passed to the template.
 * When `fallbackId` is also set, a 4xx on `id` tries `fallbackId` before falling back to text/HTML.
 * @typedef {{ id: number, fallbackId?: number, params: Record<string, unknown> }} TemplateRef
 * @typedef {{
 *   from?: string,
 *   to: string | string[],
 *   subject: string,
 *   text: string,
 *   html?: string,
 *   template?: TemplateRef,
 * }} Message
 * @typedef {{ send(message: Message): Promise<void> }} Transport
 * @typedef {{
 *   info: (o: object, m: string) => void,
 *   debug: (o: object, m: string) => void,
 *   warn: (o: object, m: string) => void,
 * }} Log
 * @typedef {{
 *   sendCode(to: string, code: string, link: string, locale: import('./i18n.js').Locale): Promise<void>,
 *   sendInactiveWarning(to: string, deleteOn: Date, locale: import('./i18n.js').Locale): Promise<void>,
 *   send?(message: Message): Promise<void>,
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
 * The privacy notice link: PRIVACY_NOTICE_URL when set, else the built-in page.
 * @param {import('./config.js').Config} config
 */
function privacyUrl(config) {
  return config.brand.privacyNoticeUrl || `${config.issuer}/privacy`;
}

/**
 * Footer shared by all mails: the controller (when configured) and a link to the privacy notice.
 * @param {import('./config.js').Config} config
 * @param {import('./i18n.js').Locale} locale
 */
function mailFooter(config, locale) {
  const lines = [];
  if (config.controller.name) {
    const contact = config.controller.contact ? ` (${config.controller.contact})` : '';
    lines.push(`${t(locale, 'mail_controller', { controller: config.controller.name })}${contact}`);
  }
  lines.push(t(locale, 'mail_privacy_link', { url: privacyUrl(config) }));
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
 * Template parameters for the sign-in mail. Every value is a string.
 * @param {import('./config.js').Config} config
 * @param {string} code
 * @param {string} link
 * @param {import('./i18n.js').Locale} locale
 * @returns {Record<string, string>}
 */
export function buildCodeTemplateParams(config, code, link, locale) {
  return {
    code,
    link,
    brand_name: config.brand.name,
    privacy_url: privacyUrl(config),
    controller_name: config.controller.name,
    controller_contact: config.controller.contact,
    locale,
  };
}

/**
 * Template parameters for the inactivity warning. Every value is a string.
 * @param {import('./config.js').Config} config
 * @param {import('./i18n.js').Locale} locale
 * @param {Date} deleteOn
 * @returns {Record<string, string>}
 */
export function buildInactiveTemplateParams(config, locale, deleteOn) {
  return {
    date: deleteOn.toISOString().slice(0, 10),
    brand_name: config.brand.name,
    privacy_url: privacyUrl(config),
    controller_name: config.controller.name,
    controller_contact: config.controller.contact,
    locale,
  };
}

/**
 * The template for a mail kind and locale: the locale's own id, else the default id, else none.
 * @param {{ default?: number, fi?: number, sv?: number, en?: number }} ids
 * @param {import('./i18n.js').Locale} locale
 * @returns {number | undefined}
 */
export function templateIdFor(ids, locale) {
  return ids[locale] ?? ids.default;
}

/**
 * Build the template reference for a mail kind and locale: prefers the locale-specific id,
 * includes `ids.default` as `fallbackId` when both are configured and distinct, and returns
 * `undefined` when neither is configured.
 * @param {{ default?: number, fi?: number, sv?: number, en?: number }} ids
 * @param {import('./i18n.js').Locale} locale
 * @param {Record<string, unknown>} params
 * @returns {TemplateRef | undefined}
 */
export function buildTemplateRef(ids, locale, params) {
  const id = templateIdFor(ids, locale);
  if (id === undefined) return undefined;
  const fallbackId =
    ids[locale] !== undefined && ids.default !== undefined && ids.default !== ids[locale]
      ? ids.default
      : undefined;
  return {
    id,
    ...(fallbackId !== undefined ? { fallbackId } : {}),
    params,
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
      /** @type {Message} */
      const message = { to, ...buildCodeMail(config, code, link, locale) };
      const template = buildTemplateRef(
        config.brevoTemplates.signin,
        locale,
        buildCodeTemplateParams(config, code, link, locale),
      );
      if (template !== undefined) message.template = template;
      await transport.send(message);
    },
    async sendInactiveWarning(to, deleteOn, locale) {
      /** @type {Message} */
      const message = { to, ...buildInactiveWarningMail(config, locale, deleteOn) };
      const template = buildTemplateRef(
        config.brevoTemplates.inactive,
        locale,
        buildInactiveTemplateParams(config, locale, deleteOn),
      );
      if (template !== undefined) message.template = template;
      await transport.send(message);
    },
    async send(message) {
      await transport.send(message);
    },
  };
}

/**
 * Development transport that logs instead of sending. It ignores templates; it only notes which
 * template id would have been used.
 * @param {Log} logger
 * @returns {Transport}
 */
export function createConsoleTransport(logger) {
  return {
    async send(message) {
      logger.info(
        {
          ...(message.from !== undefined ? { from: message.from } : {}),
          to: message.to,
          subject: message.subject,
          text: message.text,
          ...(message.html !== undefined ? { html: message.html } : {}),
        },
        'mail (console provider)',
      );
      if (message.template)
        logger.debug(
          { templateId: message.template.id },
          'mail template (console provider, unused)',
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
        from: message.from ?? from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html !== undefined ? { html: message.html } : {}),
      });
    },
  };
}

/**
 * Brevo transactional email API.
 *
 * With a `template`, the mail is sent by template id and params (the template holds the subject
 * and body). If Brevo answers with a 4xx to that (a missing or inactive template, say), the same
 * mail is sent once more as plain text, and a warning is logged with the error name and status
 * only. A 5xx, a timeout or a network error is thrown as it is.
 * @param {string} apiKey
 * @param {string} from
 * @param {typeof fetch} [fetchImpl]
 * @param {Log} [log]
 * @returns {Transport}
 */
export function createBrevoTransport(apiKey, from, fetchImpl = fetch, log = defaultLogger) {
  const defaultSender = parseFrom(from);

  /**
   * @param {Record<string, unknown>} body
   * @param {{ name: string | undefined, email: string }} [sender]
   */
  async function post(body, sender = defaultSender) {
    const res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ sender, ...body }),
      signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
    });
    if (!res.ok)
      throw Object.assign(new Error(`Brevo responded ${res.status}`), { status: res.status });
  }

  return {
    async send(message) {
      const sender = message.from !== undefined ? parseFrom(message.from) : defaultSender;
      const recipients = Array.isArray(message.to) ? message.to : [message.to];
      const to = recipients.map((email) => ({ email }));
      const content = {
        subject: message.subject,
        textContent: message.text,
        ...(message.html !== undefined ? { htmlContent: message.html } : {}),
      };
      if (!message.template) {
        await post({ to, ...content }, sender);
        return;
      }
      const candidateIds = [
        message.template.id,
        ...(message.template.fallbackId !== undefined &&
        message.template.fallbackId !== message.template.id
          ? [message.template.fallbackId]
          : []),
      ];
      for (const templateId of candidateIds) {
        try {
          await post({ to, templateId, params: message.template.params }, sender);
          return;
        } catch (err) {
          const status = /** @type {{ status?: unknown }} */ (err).status;
          if (typeof status !== 'number' || status < 400 || status >= 500) throw err;
          log.warn(
            { error: /** @type {Error} */ (err).name, status },
            'Brevo template rejected; sending plain text instead',
          );
        }
      }
      await post({ to, ...content }, sender);
    },
  };
}

/**
 * @param {import('./config.js').Config} config
 * @param {Log} logger
 * @returns {Mailer}
 */
export function createMailerFromConfig(config, logger) {
  const transport =
    config.mailProvider === 'smtp'
      ? createSmtpTransport(config.smtpUrl, config.mailFrom)
      : config.mailProvider === 'brevo'
        ? createBrevoTransport(config.brevoApiKey, config.mailFrom, fetch, logger)
        : createConsoleTransport(logger);
  return createMailer(config, transport);
}
