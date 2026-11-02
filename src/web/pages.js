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
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(brand.name)}</title>
<style>body{font:16px system-ui,sans-serif;max-width:24rem;margin:3rem auto;padding:0 1rem}
button{background:${esc(brand.color)};color:#fff;border:0;padding:.6rem 1rem;border-radius:.3rem;font:inherit;cursor:pointer}
button.secondary{background:none;color:inherit;text-decoration:underline;padding-left:0}
input{font:inherit;padding:.5rem;width:100%;box-sizing:border-box;margin:.4rem 0 1rem}.err{color:#b00020}
.code{font-size:2rem;letter-spacing:.3rem;font-weight:600}</style>
</head><body>${brand.logoUrl ? `<img src="${esc(brand.logoUrl)}" alt="" height="40">` : ''}
<h1>${esc(brand.name)}</h1>${body}
${brand.privacyNoticeUrl ? `<p><a href="${esc(brand.privacyNoticeUrl)}">${esc(t(locale, 'privacy'))}</a></p>` : ''}
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
 */
export function codePage(ctx, action, error) {
  const { locale } = ctx;
  return layout(
    ctx,
    t(locale, 'code'),
    `<p>${esc(t(locale, 'code_sent'))}</p>
<form method="post" action="${esc(action)}">
<label>${esc(t(locale, 'code'))}<input name="code" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" required autofocus></label>
${errorLine(error ?? '', ctx)}<button>${esc(t(locale, 'continue'))}</button></form>`,
  );
}

/**
 * "Continue as" page shown when a Tunnus session already exists.
 * @param {Ctx} ctx
 * @param {{ continueAction: string, otherAction: string, name: string, email: string }} p
 */
export function continuePage(ctx, p) {
  const { locale } = ctx;
  return layout(
    ctx,
    t(locale, 'signin'),
    `<form method="post" action="${esc(p.continueAction)}">
<p>${esc(p.email)}</p><button>${esc(t(locale, 'continue_as', { name: p.name }))}</button></form>
<form method="post" action="${esc(p.otherAction)}"><button class="secondary">${esc(t(locale, 'other_account'))}</button></form>`,
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
