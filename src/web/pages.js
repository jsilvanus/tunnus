import { t } from '../i18n.js';

/** @param {unknown} s */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * @typedef {{ config: import('../config.js').Config, locale: import('../i18n.js').Locale }} Ctx
 */

/**
 * @param {Ctx} ctx
 * @param {string} title
 * @param {string} body
 */
export function layout({ config, locale }, title, body) {
  const { brand } = config;
  const privacyUrl = brand.privacyNoticeUrl || `${config.issuer}/privacy`;
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(brand.name)}</title>
<style>body{font:16px system-ui,sans-serif;max-width:24rem;margin:3rem auto;padding:0 1rem}
button{background:${esc(brand.color)};color:#fff;border:0;padding:.6rem 1rem;border-radius:.3rem;font:inherit;cursor:pointer}
button.alt{background:#475569;color:#fff}
button.secondary{background:none;color:inherit;text-decoration:underline;padding-left:0}
.actions form+form{margin-top:.6rem}
input{font:inherit;padding:.5rem;width:100%;box-sizing:border-box;margin:.4rem 0 1rem}.err{color:#b00020}
.code{font-size:2rem;letter-spacing:.3rem;font-weight:600}
table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:.3rem .4rem;border-bottom:1px solid #ddd;overflow-wrap:anywhere}
footer{margin-top:3rem;font-size:.875rem}footer a{color:inherit}</style>
</head><body>${brand.logoUrl ? `<img src="${esc(brand.logoUrl)}" alt="" height="56">` : ''}
<h1>${esc(brand.name)}</h1>${body}
<footer><p><a href="${esc(privacyUrl)}">${esc(t(locale, 'footer_privacy'))}</a></p></footer>
</body></html>`;
}

/**
 * @param {string} error
 * @param {Ctx} ctx
 */
const errorLine = (error, ctx) => (error ? `<p class="err">${esc(t(ctx.locale, error))}</p>` : '');

/**
 * @param {Ctx} ctx
 * @param {string} action
 * @param {string} [error] message key
 */
export function emailPage(ctx, action, error) {
  const { locale } = ctx;
  return layout(
    ctx,
    t(locale, 'signin'),
    `<form method="post" action="${esc(action)}">
<label>${esc(t(locale, 'email'))}<input type="email" name="email" autocomplete="email" required autofocus></label>
${errorLine(error ?? '', ctx)}<button>${esc(t(locale, 'send_code'))}</button></form>`,
  );
}

/**
 * @param {Ctx} ctx
 * @param {string} action
 * @param {string} [error] message key
 * @param {{ resendAction?: string, messageKey?: string }} [opts]
 */
export function codePage(ctx, action, error, opts = {}) {
  const { locale } = ctx;
  const message = t(locale, opts.messageKey ?? (opts.resendAction ? 'code_prompt' : 'code_sent'));
  const resendForm = opts.resendAction
    ? `\n<form method="post" action="${esc(opts.resendAction)}"><button class="secondary">${esc(t(locale, 'send_email_code'))}</button></form>`
    : '';
  return layout(
    ctx,
    t(locale, 'code'),
    `<p>${esc(message)}</p>
<form method="post" action="${esc(action)}">
<label>${esc(t(locale, 'code'))}<input name="code" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" required autofocus></label>
${errorLine(error ?? '', ctx)}<button>${esc(t(locale, 'continue'))}</button></form>${resendForm}`,
  );
}

/**
 * "Continue as" page shown when a Tunnus session already exists.
 * @param {Ctx} ctx
 * @param {{ continueAction: string, otherAction: string, logoutAction?: string, name: string, email: string }} p
 */
export function continuePage(ctx, p) {
  const { locale } = ctx;
  const displayName = p.name || p.email;
  const logoutForm = p.logoutAction
    ? `\n<form method="post" action="${esc(p.logoutAction)}"><button class="secondary">${esc(t(locale, 'logout_title'))}</button></form>`
    : '';
  return layout(
    ctx,
    t(locale, 'signin'),
    `<p>${esc(p.email)}</p>
<div class="actions">
<form method="post" action="${esc(p.continueAction)}"><button>${esc(t(locale, 'continue_as', { name: displayName }))}</button></form>
<form method="post" action="${esc(p.otherAction)}"><button class="alt">${esc(t(locale, 'other_account'))}</button></form>${logoutForm}
</div>`,
  );
}

/**
 * @param {Ctx} ctx
 * @param {string} action
 * @param {string} name prefilled display name
 */
export function namePage(ctx, action, name) {
  const { locale } = ctx;
  return layout(
    ctx,
    t(locale, 'name_title'),
    `<p>${esc(t(locale, 'name_help'))}</p>
<form method="post" action="${esc(action)}">
<label>${esc(t(locale, 'name'))}<input name="name" value="${esc(name)}" maxlength="100" required autofocus></label>
<button>${esc(t(locale, 'create_account'))}</button></form>`,
  );
}

/**
 * Link landing page: sign-in completes only when the button is pressed (POST).
 * @param {Ctx} ctx
 * @param {string} action
 */
export function linkConfirmPage(ctx, action) {
  const { locale } = ctx;
  return layout(
    ctx,
    t(locale, 'link_title'),
    `<p>${esc(t(locale, 'link_help'))}</p>
<form method="post" action="${esc(action)}"><button>${esc(t(locale, 'continue'))}</button></form>`,
  );
}

/**
 * Link opened in another browser: show the code to type in the original one.
 * @param {Ctx} ctx
 * @param {string} code
 */
export function linkCodePage(ctx, code) {
  const { locale } = ctx;
  return layout(
    ctx,
    t(locale, 'link_title'),
    `<p>${esc(t(locale, 'link_other_browser'))}</p><p class="code">${esc(code)}</p>`,
  );
}

/** @param {Ctx} ctx */
export function linkInvalidPage(ctx) {
  return layout(
    ctx,
    t(ctx.locale, 'link_title'),
    `<p class="err">${esc(t(ctx.locale, 'link_invalid'))}</p>`,
  );
}

/**
 * @param {Ctx} ctx
 * @param {string} action
 * @param {string} clientName
 * @param {string[]} scopes
 */
export function consentPage(ctx, action, clientName, scopes) {
  const { locale } = ctx;
  return layout(
    ctx,
    t(locale, 'allow'),
    `<p>${esc(t(locale, 'consent', { client: clientName, scopes: scopes.join(', ') }))}</p>
<form method="post" action="${esc(action)}"><button>${esc(t(locale, 'allow'))}</button></form>
<form method="post" action="${esc(action)}/abort"><button class="secondary">${esc(t(locale, 'deny'))}</button></form>`,
  );
}

/**
 * The branded page for an unexpected error. It names no cause; the request id is in the response
 * header and the log.
 * @param {Ctx} ctx
 */
export function errorPage(ctx) {
  const title = t(ctx.locale, 'error_title');
  return layout(ctx, title, `<h2>${esc(title)}</h2><p>${esc(t(ctx.locale, 'error_body'))}</p>`);
}

/**
 * Logout confirmation. `form` is the form oidc-provider builds (it carries the xsrf field and the
 * action); the buttons submit it by id. No script: the page works under the CSP.
 * @param {Ctx} ctx
 * @param {string} form
 */
export function logoutPage(ctx, form) {
  const title = t(ctx.locale, 'logout_title');
  return layout(
    ctx,
    title,
    `<h2>${esc(t(ctx.locale, 'logout_question'))}</h2>
${form}
<p><button type="submit" form="op.logoutForm" name="logout" value="yes">${esc(t(ctx.locale, 'logout_yes'))}</button></p>
<p><button type="submit" form="op.logoutForm" class="secondary">${esc(t(ctx.locale, 'logout_no'))}</button></p>`,
  );
}

/**
 * Shown after sign-out when the client gave no post-logout redirect.
 * @param {Ctx} ctx
 */
export function logoutDonePage(ctx) {
  const title = t(ctx.locale, 'logout_done_title');
  return layout(
    ctx,
    title,
    `<h2>${esc(title)}</h2><p>${esc(t(ctx.locale, 'logout_done_body'))}</p>`,
  );
}

/**
 * @param {Ctx} ctx
 * @param {string} action
 * @param {string} [error]
 */
export function accountLoginPage(ctx, action, error) {
  const { locale } = ctx;
  return layout(
    ctx,
    t(locale, 'account_title'),
    `<h2>${esc(t(locale, 'account_title'))}</h2>
<p>${esc(t(locale, 'account_signin_help'))}</p>
<form method="post" action="${esc(action)}">
<label>${esc(t(locale, 'email'))}<input type="email" name="email" autocomplete="email" required autofocus></label>
${errorLine(error ?? '', ctx)}<button>${esc(t(locale, 'send_code'))}</button></form>`,
  );
}

/**
 * @param {Ctx} ctx
 * @param {string} action
 * @param {string} [error]
 */
export function accountCodePage(ctx, action, error) {
  const { locale } = ctx;
  return layout(
    ctx,
    t(locale, 'account_title'),
    `<h2>${esc(t(locale, 'account_title'))}</h2>
<p>${esc(t(locale, 'code_sent'))}</p>
<form method="post" action="${esc(action)}">
<label>${esc(t(locale, 'code'))}<input name="code" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" required autofocus></label>
${errorLine(error ?? '', ctx)}<button>${esc(t(locale, 'continue'))}</button></form>`,
  );
}

/**
 * @param {Ctx} ctx
 * @param {{
 *   basePath: string,
 *   email: string,
 *   displayName: string,
 *   groups: string[],
 *   totpEnabled: boolean,
 *   freshEmail: boolean,
 *   csrf: string,
 * }} p
 */
export function accountPage(ctx, p) {
  const { locale } = ctx;
  const statusText = p.totpEnabled
    ? t(locale, 'account_totp_enabled')
    : t(locale, 'account_totp_disabled');
  let totpAction;
  if (!p.freshEmail) {
    totpAction = `<p>${esc(t(locale, 'account_totp_verify_first'))}</p>
<form method="post" action="${esc(p.basePath)}/account/verify">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<button>${esc(t(locale, 'send_email_code'))}</button></form>`;
  } else if (p.totpEnabled) {
    totpAction = `<form method="post" action="${esc(p.basePath)}/account/totp/disable">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<button class="alt">${esc(t(locale, 'account_totp_disable'))}</button></form>`;
  } else {
    totpAction = `<form method="post" action="${esc(p.basePath)}/account/totp/start">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<button>${esc(t(locale, 'account_totp_setup'))}</button></form>`;
  }
  const groupsRow = p.groups.length
    ? `<tr><th>${esc(t(locale, 'account_groups'))}</th><td>${esc(p.groups.join(', '))}</td></tr>`
    : '';
  return layout(
    ctx,
    t(locale, 'account_title'),
    `<h2>${esc(t(locale, 'account_title'))}</h2>
<table>
<tr><th>${esc(t(locale, 'name'))}</th><td>${esc(p.displayName)}</td></tr>
<tr><th>${esc(t(locale, 'email'))}</th><td>${esc(p.email)}</td></tr>${groupsRow}
<tr><th>${esc(t(locale, 'account_totp_title'))}</th><td>${esc(statusText)}</td></tr>
</table>
<div class="actions" style="margin-top:1.5rem">
${totpAction}
<form method="post" action="${esc(p.basePath)}/account/logout">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<button class="secondary">${esc(t(locale, 'logout_title'))}</button></form>
</div>`,
  );
}

/**
 * @param {Ctx} ctx
 * @param {{
 *   action: string,
 *   cancelHref: string,
 *   qrUrl: string,
 *   secret: string,
 *   csrf: string,
 *   error?: string,
 * }} p
 */
export function accountTotpSetupPage(ctx, p) {
  const { locale } = ctx;
  return layout(
    ctx,
    t(locale, 'account_totp_title'),
    `<h2>${esc(t(locale, 'account_totp_title'))}</h2>
<p>${esc(t(locale, 'account_totp_scan'))}</p>
<p><img src="${esc(p.qrUrl)}" alt="QR" width="200" height="200"></p>
<p><strong>${esc(t(locale, 'account_totp_secret'))}:</strong> <code>${esc(p.secret)}</code></p>
<p>${esc(t(locale, 'account_totp_confirm'))}</p>
<form method="post" action="${esc(p.action)}">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<label>${esc(t(locale, 'code'))}<input name="code" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" required autofocus></label>
${errorLine(p.error ?? '', ctx)}<button>${esc(t(locale, 'continue'))}</button></form>
<p><a href="${esc(p.cancelHref)}">${esc(t(locale, 'account_cancel'))}</a></p>`,
  );
}
