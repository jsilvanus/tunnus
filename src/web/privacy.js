import express from 'express';
import { LOCALES, pickLocale, t } from '../i18n.js';
import { esc, layout } from './pages.js';

/**
 * Privacy notice page, rendered from configuration: controller, data protection
 * officer, stored data, retention settings and processors. All configured text is
 * HTML-escaped.
 * @param {{ config: import('../config.js').Config, locale: import('../i18n.js').Locale }} ctx
 */
export function privacyPage(ctx) {
  const { config, locale } = ctx;
  const { controller, privacy, retention, brand } = config;
  const tr = (/** @type {string} */ key, /** @type {Record<string, string>} */ vars = {}) =>
    esc(t(locale, key, vars));

  const controllerLines = [
    controller.name ? `<p>${esc(controller.name)}</p>` : '',
    controller.contact ? `<p>${tr('privacy_contact', { contact: controller.contact })}</p>` : '',
  ].join('');

  const dpo = privacy.dpoContact
    ? `<h2>${tr('privacy_dpo')}</h2><p>${tr('privacy_contact', { contact: privacy.dpoContact })}</p>`
    : '';

  const retentionItems = [];
  if (retention.inactiveUserDeleteDays > 0) {
    retentionItems.push(
      `<li>${tr('privacy_inactive', {
        days: String(retention.inactiveUserDeleteDays),
        warnDays: String(retention.inactiveUserWarnDays),
      })}</li>`,
      `<li>${tr('privacy_admins')}</li>`,
    );
  }
  if (retention.auditRetentionDays > 0) {
    retentionItems.push(
      `<li>${tr('privacy_audit', { days: String(retention.auditRetentionDays) })}</li>`,
    );
  }
  if (retention.auditIpRetentionDays > 0) {
    retentionItems.push(
      `<li>${tr('privacy_audit_ip', { days: String(retention.auditIpRetentionDays) })}</li>`,
    );
  }

  const processors = privacy.processors.length
    ? `<table><thead><tr><th>${tr('privacy_processor_name')}</th><th>${tr('privacy_processor_purpose')}</th><th>${tr('privacy_processor_location')}</th></tr></thead><tbody>${privacy.processors
        .map(
          (p) =>
            `<tr><td>${esc(p.name)}</td><td>${esc(p.purpose)}</td><td>${esc(p.location)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : `<p>${tr('privacy_processors_none')}</p>`;

  const body = `<h2>${tr('privacy_title')}</h2>
<h3>${tr('privacy_controller')}</h3>${controllerLines}
${dpo}
<h3>${tr('privacy_stored')}</h3><p>${tr('privacy_stored_body')}</p>
<h3>${tr('privacy_why')}</h3><p>${tr('privacy_why_body', { brand: brand.name })}</p>
<h3>${tr('privacy_retention')}</h3><ul>${retentionItems.join('')}</ul>
<h3>${tr('privacy_processors')}</h3>${processors}
<h3>${tr('privacy_rights')}</h3><p>${tr('privacy_rights_body')}</p>${controller.contact ? `<p>${tr('privacy_contact', { contact: controller.contact })}</p>` : ''}`;

  return layout(ctx, t(locale, 'privacy_title'), body);
}

/**
 * Router for `GET /privacy`. Redirects to PRIVACY_NOTICE_URL when it is set.
 * The locale comes from `?lang=`, else Accept-Language, else DEFAULT_LOCALE.
 * Mount it under the issuer path (for example `app.use(basePath, router)`).
 * @param {{ config: import('../config.js').Config }} deps
 */
export function createPrivacyRouter({ config }) {
  const router = express.Router();

  router.get('/privacy', (req, res) => {
    if (config.brand.privacyNoticeUrl) {
      res.redirect(302, config.brand.privacyNoticeUrl);
      return;
    }
    const lang = typeof req.query.lang === 'string' ? req.query.lang : '';
    const locale = /** @type {readonly string[]} */ (LOCALES).includes(lang)
      ? /** @type {import('../i18n.js').Locale} */ (lang)
      : pickLocale(req, config.defaultLocale);
    res.set('Cache-Control', 'no-store');
    res.type('html').send(privacyPage({ config, locale }));
  });

  return router;
}
