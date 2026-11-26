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
  const footerLinks = [`<a href="${esc(privacyUrl)}">${esc(t(locale, 'footer_privacy'))}</a>`];
  if (brand.termsUrl) {
    footerLinks.push(`<a href="${esc(brand.termsUrl)}">${esc(t(locale, 'footer_terms'))}</a>`);
  }
  if (brand.supportUrl) {
    footerLinks.push(`<a href="${esc(brand.supportUrl)}">${esc(t(locale, 'footer_support'))}</a>`);
  }
  const faviconHtml = brand.faviconUrl
    ? `\n<link rel="icon" href="${esc(brand.faviconUrl)}">`
    : brand.logoUrl
      ? `\n<link rel="icon" href="${esc(brand.logoUrl)}">`
      : '';
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="${esc(brand.color)}">${faviconHtml}
<title>${esc(title)} · ${esc(brand.name)}</title>
<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}
button{background:${esc(brand.color)};color:#fff;border:0;padding:.6rem 1rem;border-radius:.3rem;font:inherit;cursor:pointer}
button.alt{background:#475569;color:#fff}
button.secondary{background:none;color:inherit;text-decoration:underline;padding-left:0}
.actions form+form{margin-top:.6rem}
input{font:inherit;padding:.5rem;width:100%;box-sizing:border-box;margin:.4rem 0 1rem}.err{color:#b00020}
.code{font-size:2rem;letter-spacing:.3rem;font-weight:600}
table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:.3rem .4rem;border-bottom:1px solid #ddd;overflow-wrap:anywhere}
.tagline{color:#475569;margin:-0.5rem 0 1.5rem;font-size:1rem}
footer{margin-top:3rem;font-size:.875rem}footer a{color:inherit}
footer .links a+a{margin-left:.75rem}
.copyright{color:#64748b;margin:0 0 .5rem}</style>
</head><body>${brand.logoUrl ? `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.name)}" height="56">` : ''}
<h1>${esc(brand.name)}</h1>${brand.tagline ? `<p class="tagline">${esc(brand.tagline)}</p>` : ''}${body}
<footer>
${brand.copyright ? `<p class="copyright">${esc(brand.copyright)}</p>\n` : ''}<p class="links">${footerLinks.join(' · ')}</p>
</footer>
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
 * @param {{ resendAction?: string, messageKey?: string }} [opts]
 */
export function accountCodePage(ctx, action, error, opts = {}) {
  const { locale } = ctx;
  const message = t(locale, opts.messageKey ?? (opts.resendAction ? 'code_prompt' : 'code_sent'));
  const resendForm = opts.resendAction
    ? `\n<form method="post" action="${esc(opts.resendAction)}"><button class="secondary">${esc(t(locale, 'send_email_code'))}</button></form>`
    : '';
  return layout(
    ctx,
    t(locale, 'account_title'),
    `<h2>${esc(t(locale, 'account_title'))}</h2>
<p>${esc(message)}</p>
<form method="post" action="${esc(action)}">
<label>${esc(t(locale, 'code'))}<input name="code" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" required autofocus></label>
${errorLine(error ?? '', ctx)}<button>${esc(t(locale, 'continue'))}</button></form>${resendForm}`,
  );
}

/**
 * @param {Ctx} ctx
 * @param {{
 *   basePath: string,
 *   email: string,
 *   displayName: string,
 *   title?: string | null,
 *   phoneNumber?: string | null,
 *   status?: string,
 *   isActive?: boolean,
 *   activatesAt?: string | Date | null,
 *   disablesAt?: string | Date | null,
 *   groups: string[],
 *   totpEnabled: boolean,
 *   freshEmail: boolean,
 *   csrf: string,
 *   apps?: Array<{
 *     clientId: string,
 *     clientName: string,
 *     scopes: string[],
 *     resources?: string[],
 *     isMcp?: boolean,
 *   }>,
 *   appNotice?: string,
 *   mcp?: {
 *     fixedTimeRunning: boolean,
 *     remainingMinutes: number,
 *     listLocked: boolean,
 *     commitList: any[],
 *     notice?: string,
 *     error?: string,
 *   } | null,
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
  let groupsHtml = '';
  if (p.groups.length > 0) {
    const sorted = [...p.groups].sort((a, b) => a.localeCompare(b, locale));
    if (sorted.length <= 5) {
      groupsHtml = sorted.map((g) => `<div>${esc(g)}</div>`).join('');
    } else {
      const first5 = sorted
        .slice(0, 5)
        .map((g) => `<div>${esc(g)}</div>`)
        .join('');
      const rest = sorted
        .slice(5)
        .map((g) => `<div>${esc(g)}</div>`)
        .join('');
      const moreText = t(locale, 'account_groups_see_more', { count: String(sorted.length - 5) });
      groupsHtml = `${first5}<details style="margin-top:.3rem"><summary style="cursor:pointer;color:#7e003e;font-size:.9rem">${esc(moreText)}</summary><div style="margin-top:.2rem">${rest}</div></details>`;
    }
  }
  const groupsRow = p.groups.length
    ? `<tr><th>${esc(t(locale, 'account_groups'))}</th><td>${groupsHtml}</td></tr>`
    : '';

  let mcpSection = '';
  if (p.mcp) {
    const { mcp } = p;
    const directBadge = mcp.fixedTimeRunning
      ? `<span style="display:inline-block;padding:.2rem .4rem;border-radius:.25rem;font-size:.8rem;font-weight:600;background:#d4edda;color:#155724">${esc(t(locale, 'account_mcp_active'))} (${mcp.remainingMinutes} min)</span>`
      : `<span style="display:inline-block;padding:.2rem .4rem;border-radius:.25rem;font-size:.8rem;font-weight:600;background:#fff3cd;color:#856404">${esc(t(locale, 'account_mcp_inactive'))}</span>`;

    const directAction = mcp.fixedTimeRunning
      ? `<form method="post" action="${esc(p.basePath)}/account/mcp/lease" style="display:inline">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<input type="hidden" name="action" value="cancel">
<button class="alt" style="padding:.3rem .6rem;font-size:.85rem">${esc(t(locale, 'account_mcp_cancel_lease'))}</button>
</form>`
      : `<form method="post" action="${esc(p.basePath)}/account/mcp/lease" style="display:inline">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<input type="hidden" name="action" value="enable">
<button style="padding:.3rem .6rem;font-size:.85rem">${esc(t(locale, 'account_mcp_enable_15m'))}</button>
</form>`;

    const lockBadge = mcp.listLocked
      ? `<span style="display:inline-block;padding:.2rem .4rem;border-radius:.25rem;font-size:.8rem;font-weight:600;background:#fff3cd;color:#856404">🔒 ${esc(t(locale, 'account_mcp_locked'))}</span> <small style="display:block;color:#555;margin-top:.2rem">${esc(t(locale, 'account_mcp_locked_desc'))}</small>`
      : `<span style="display:inline-block;padding:.2rem .4rem;border-radius:.25rem;font-size:.8rem;font-weight:600;background:#d4edda;color:#155724">🟢 ${esc(t(locale, 'account_mcp_unlocked'))}</span> <small style="display:block;color:#555;margin-top:.2rem">${esc(t(locale, 'account_mcp_unlocked_desc'))}</small>`;

    const lockAction = mcp.listLocked
      ? `<form method="post" action="${esc(p.basePath)}/account/mcp/lock" style="display:inline">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<input type="hidden" name="locked" value="false">
<button class="alt" style="padding:.3rem .6rem;font-size:.85rem">${esc(t(locale, 'account_mcp_unlock_list'))}</button>
</form>`
      : `<form method="post" action="${esc(p.basePath)}/account/mcp/lock" style="display:inline">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<input type="hidden" name="locked" value="true">
<button class="alt" style="padding:.3rem .6rem;font-size:.85rem">${esc(t(locale, 'account_mcp_lock_list'))}</button>
</form>`;

    let listContent;
    if (mcp.commitList.length === 0) {
      listContent = `<p style="color:#666;font-size:.9rem">${esc(t(locale, 'account_mcp_empty_list'))}</p>`;
    } else {
      const rows = mcp.commitList
        .map((item, idx) => {
          const isDestructive =
            item.method === 'delete' ||
            item.operationId === 'updateUser' ||
            item.command?.includes('delete') ||
            item.command?.includes('rotate') ||
            item.command?.includes('retire');
          const destBadge = isDestructive
            ? ` <span style="display:inline-block;padding:.1rem .3rem;border-radius:.2rem;font-size:.7rem;font-weight:600;background:#f8d7da;color:#721c24">${esc(t(locale, 'account_mcp_destructive'))}</span>`
            : '';
          const paramsStr = Object.keys(item.params || {}).length
            ? JSON.stringify(item.params)
            : '';
          const bodyStr = item.body ? JSON.stringify(item.body) : '';
          const details = [paramsStr, bodyStr].filter(Boolean).join(' ');
          const actorLabel = item.stagedBy?.label || item.stagedBy?.email || item.stagedBy?.userId;
          const actorInfo = actorLabel
            ? `<br><small style="color:#888">By: ${esc(actorLabel)}</small>`
            : '';
          return `<tr>
<td>${idx + 1}</td>
<td><strong>${esc(item.command || item.operationId)}</strong>${destBadge}<br><small style="color:#666">${esc(item.summary || '')}</small>${actorInfo}</td>
<td><code style="font-size:.75rem;word-break:break-all">${esc(details)}</code></td>
</tr>`;
        })
        .join('\n');

      listContent = `<div style="overflow-x:auto;margin:1rem 0">
<table style="width:100%;font-size:.85rem">
<thead>
<tr>
<th>#</th>
<th>${esc(t(locale, 'account_mcp_action'))}</th>
<th>${esc(t(locale, 'account_mcp_details'))}</th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
</div>`;
    }

    let commitControls = '';
    if (mcp.commitList.length > 0) {
      if (mcp.listLocked) {
        commitControls = `<div style="display:flex;gap:.5rem;margin-top:.8rem;align-items:center">
<form method="post" action="${esc(p.basePath)}/account/mcp/commit">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<button style="padding:.5rem 1rem">${esc(t(locale, 'account_mcp_commit_actions'))} (${mcp.commitList.length})</button>
</form>
<form method="post" action="${esc(p.basePath)}/account/mcp/clear">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<button class="secondary" style="padding:.5rem">${esc(t(locale, 'account_mcp_clear_list'))}</button>
</form>
</div>`;
      } else {
        commitControls = `<div style="margin-top:.8rem">
<p style="font-size:.85rem;color:#856404;background:#fff3cd;padding:.5rem;border-radius:.3rem">⚠️ ${esc(t(locale, 'account_mcp_lock_required_to_commit'))}</p>
<div style="display:flex;gap:.5rem;align-items:center">
<button disabled style="opacity:0.5;cursor:not-allowed;padding:.5rem 1rem">${esc(t(locale, 'account_mcp_commit_actions'))} (${mcp.commitList.length})</button>
<form method="post" action="${esc(p.basePath)}/account/mcp/clear">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<button class="secondary" style="padding:.5rem">${esc(t(locale, 'account_mcp_clear_list'))}</button>
</form>
</div>
</div>`;
      }
    }

    const noticeBanner = mcp.notice
      ? `<p style="color:#0f5132;background:#d1e7dd;padding:.5rem;border-radius:.3rem;font-size:.9rem">${esc(mcp.notice)}</p>`
      : '';
    const errorBanner = mcp.error
      ? `<p style="color:#842029;background:#f8d7da;padding:.5rem;border-radius:.3rem;font-size:.9rem">${esc(mcp.error)}</p>`
      : '';

    mcpSection = `<div style="border:1px solid #ccc;border-radius:.4rem;padding:1rem;margin-top:1.5rem">
<h3 style="margin-top:0">${esc(t(locale, 'account_mcp_title'))}</h3>
${noticeBanner}
${errorBanner}
<div style="margin-bottom:1rem">
<p style="margin:.3rem 0"><strong>${esc(t(locale, 'account_mcp_direct_window'))}:</strong> ${directBadge}</p>
<div style="margin-top:.4rem">${directAction}</div>
</div>
<div style="margin-bottom:1rem">
<p style="margin:.3rem 0"><strong>${esc(t(locale, 'account_mcp_staging_status'))}:</strong> ${lockBadge}</p>
<div style="margin-top:.4rem">${lockAction}</div>
</div>
<div>
<h4 style="margin:1rem 0 .5rem 0">${esc(t(locale, 'account_mcp_staging_status'))} (${mcp.commitList.length})</h4>
${listContent}
${commitControls}
</div>
</div>`;
  }

  const apps = p.apps ?? [];
  const appNoticeBanner = p.appNotice
    ? `<p style="color:#0f5132;background:#d1e7dd;padding:.5rem;border-radius:.3rem;font-size:.9rem">${esc(p.appNotice)}</p>`
    : '';

  let appsContent;
  if (apps.length === 0) {
    appsContent = `<p style="color:#666;font-size:.9rem">${esc(t(locale, 'account_apps_none'))}</p>`;
  } else {
    const rows = apps
      .map((app) => {
        const idSubtitle =
          app.clientName !== app.clientId
            ? `<br><small style="color:#666">${esc(app.clientId)}</small>`
            : '';
        const scopesStr = app.scopes.length ? esc(app.scopes.join(', ')) : '—';
        const mcpBadge = app.isMcp
          ? ` <span style="display:inline-block;padding:.1rem .3rem;border-radius:.2rem;font-size:.7rem;font-weight:600;background:#e0f2fe;color:#0369a1">MCP</span>`
          : '';
        const identityForm = app.isMcp
          ? '<form method="post" action="' +
            esc(p.basePath) +
            '/account/mcp/identity-mode" style="margin-top:.5rem">' +
            '<input type="hidden" name="csrf" value="' +
            esc(p.csrf) +
            '"><input type="hidden" name="clientId" value="' +
            esc(app.clientId) +
            '">' +
            '<label style="font-size:.8rem">MCP identity mode<select name="mode">' +
            '<option value="open" ' +
            ((app.identityMode || 'open') === 'open' ? 'selected' : '') +
            '>Open</option>' +
            '<option value="pseudo_ref" ' +
            (app.identityMode === 'pseudo_ref' ? 'selected' : '') +
            '>Pseudonym + refs</option>' +
            '<option value="ref_only" ' +
            (app.identityMode === 'ref_only' ? 'selected' : '') +
            '>Refs only</option>' +
            '</select></label><button class="alt" style="padding:.25rem .5rem;font-size:.8rem">Save</button></form>'
          : '';
        const resourcesStr =
          app.resources && app.resources.length > 0
            ? `<br><small style="color:#555"><em>${esc(t(locale, 'account_apps_resources'))}:</em> ${esc(app.resources.join(', '))}</small>`
            : '';
        return `<tr>
<td><strong>${esc(app.clientName)}</strong>${mcpBadge}${idSubtitle}</td>
<td><small style="color:#555">${scopesStr}</small>${resourcesStr}${identityForm}</td>
<td style="text-align:right">
<form method="post" action="${esc(p.basePath)}/account/apps/revoke" style="display:inline">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<input type="hidden" name="clientId" value="${esc(app.clientId)}">
<button class="alt" style="padding:.3rem .6rem;font-size:.85rem">${esc(t(locale, 'account_apps_revoke'))}</button>
</form>
</td>
</tr>`;
      })
      .join('\n');

    appsContent = `<div style="overflow-x:auto">
<table style="width:100%;font-size:.9rem">
<thead>
<tr>
<th>${esc(t(locale, 'account_apps_app'))}</th>
<th>${esc(t(locale, 'account_apps_permissions'))}</th>
<th></th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
</div>`;
  }

  const appsSection = `<div style="border:1px solid #ccc;border-radius:.4rem;padding:1rem;margin-top:1.5rem">
<h3 style="margin-top:0">${esc(t(locale, 'account_apps_title'))}</h3>
${appNoticeBanner}
${appsContent}
<p><a href="${esc(p.basePath)}/account/mcp-identities">Manage MCP pseudonyms and temporary references</a></p>
</div>`;

  let mcpIdentitiesSection = '';
  if (p.mcpIdentities) {
    const { subjects = [], users = [], clients = [] } = p.mcpIdentities;
    const clientOptions = clients
      .map(
        (c) =>
          `<option value="${esc(c.auth_kind)}|${esc(c.auth_client_key)}">${esc(c.label)}</option>`,
      )
      .join('');
    const userDatalistOptions = users
      .map(
        (u) =>
          `<option value="${esc(u.email)}">${esc(u.display_name || u.email)} (${esc(u.email)})</option>`,
      )
      .join('\n');

    const allActiveRefs = [];
    for (const s of subjects) {
      const sLabel = s.display_name || s.label || s.email || s.subject_id;
      for (const r of s.refs || []) {
        if (!r.revoked_at && new Date(r.expires_at).getTime() > Date.now()) {
          allActiveRefs.push({
            subjectLabel: sLabel,
            handle: r.handle,
            client: r.auth_client_key || r.auth_kind,
            expiresAt: r.expires_at,
          });
        }
      }
    }

    let activeRefsTable;
    if (allActiveRefs.length === 0) {
      activeRefsTable = `<p style="color:#64748b;font-size:.85rem;margin:.5rem 0">No active temporary references.</p>`;
    } else {
      const rows = allActiveRefs
        .map((r) => {
          const diffHours = Math.max(
            0,
            Math.round((new Date(r.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60)),
          );
          return `<tr>
<td><strong>${esc(r.subjectLabel)}</strong></td>
<td><code>ref:${esc(r.handle)}</code> <button type="button" class="copy-btn" data-copy="ref:${esc(r.handle)}" aria-label="Copy reference ref:${esc(r.handle)}">📋 Copy</button></td>
<td><small style="color:#64748b">${esc(r.client)}</small></td>
<td><small style="color:#64748b">${diffHours}h left</small></td>
</tr>`;
        })
        .join('\n');

      activeRefsTable = `<div style="overflow-x:auto;margin-top:.5rem">
<table class="compact-table">
<thead><tr><th>Subject</th><th>Reference</th><th>Credential</th><th>Expires</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>`;
    }

    mcpIdentitiesSection = `<div style="border:1px solid #ccc;border-radius:.4rem;padding:1rem;margin-top:1.5rem">
<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">
<h3 style="margin:0">MCP Pseudonyms & References</h3>
<a href="${esc(p.basePath)}/account/mcp-identities" style="font-size:.85rem;font-weight:600">Open full MCP directory & settings →</a>
</div>
<p style="color:#64748b;font-size:.85rem;margin:.4rem 0">Private pseudonyms and temporary 24-hour references for MCP clients (e.g. ChatGPT, Claude).</p>

<div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:.4rem;padding:1rem;margin:1rem 0">
  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem;margin-bottom:.5rem">
    <strong style="font-size:1rem">⚡ Quick Bulk Reference Creator</strong>
    <span style="font-size:.8rem;color:#64748b">Type user emails/names & press Enter</span>
  </div>
  <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.5rem">
    <div style="flex:1;min-width:14rem">
      <label style="font-size:.8rem;color:#475569;display:block;margin-bottom:.2rem">MCP Credential</label>
      <select id="quick-bulk-cred" style="width:100%;padding:.45rem;font:inherit;border-radius:.3rem;border:1px solid #cbd5e1">${clientOptions}</select>
    </div>
    <div style="flex:2;min-width:18rem">
      <label style="font-size:.8rem;color:#475569;display:block;margin-bottom:.2rem">Type User (Enter to add)</label>
      <input id="quick-bulk-input" list="quick-bulk-users-dl" placeholder="Type email or name, then press Enter..." autocomplete="off" style="margin:0;padding:.45rem;border:1px solid #cbd5e1;border-radius:.3rem">
      <datalist id="quick-bulk-users-dl">${userDatalistOptions}</datalist>
    </div>
  </div>
  <div style="margin-bottom:.6rem">
    <label style="font-size:.8rem;color:#475569;display:block;margin-bottom:.2rem">Recipients / Subjects to create refs for:</label>
    <div id="quick-bulk-chips" class="chip-container">
      <span style="color:#94a3b8;font-size:.85rem;padding:.2rem">Type email or name, then press Enter...</span>
    </div>
  </div>
  <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
    <button type="button" id="quick-bulk-btn" data-csrf="${esc(p.csrf)}" data-basepath="${esc(p.basePath)}" style="background:#0284c7;font-weight:600;padding:.5rem 1rem">⚡ Create Refs & Copy to Clipboard</button>
    <button type="button" id="quick-bulk-clear" class="secondary" style="font-size:.85rem">Clear</button>
    <span style="font-size:.75rem;color:#64748b">Shortcut: press <strong>Ctrl+Enter</strong> anytime</span>
  </div>
  <div id="quick-bulk-banner" style="display:none;margin-top:.75rem;padding:.75rem;border-radius:.35rem;background:#dcfce7;border:1px solid #86efac;color:#166534"></div>
</div>

<h4 style="margin:1rem 0 .4rem 0">Active References (${allActiveRefs.length})</h4>
${activeRefsTable}
</div>`;
  }

  let adminSection = '';
  if (p.adminUsers) {
    const { adminUsers } = p;
    const adminNoticeBanner = adminUsers.notice
      ? `<p style="color:#0f5132;background:#d1e7dd;padding:.5rem;border-radius:.3rem;font-size:.9rem">${esc(adminUsers.notice)}</p>`
      : '';
    const adminErrorBanner = adminUsers.error
      ? `<p style="color:#842029;background:#f8d7da;padding:.5rem;border-radius:.3rem;font-size:.9rem">${esc(adminUsers.error)}</p>`
      : '';

    const userDatalistOptions = (adminUsers.users || [])
      .map(
        (u) =>
          `<option value="${esc(u.email)}">${esc(u.display_name || u.email)} (${esc(u.email)})</option>`,
      )
      .join('\n');

    const allGroupDatalistOptions = (adminUsers.allGroups || [])
      .map((g) => `<option value="${esc(g.name)}"></option>`)
      .join('\n');

    let userDetail = '';
    if (adminUsers.selectedUser) {
      const u = adminUsers.selectedUser;
      const groups = adminUsers.selectedGroups || [];
      const groupItems = groups.length
        ? groups
            .map(
              (g) => `<li style="display:flex;align-items:center;gap:.5rem;margin:.3rem 0">
<code>${esc(g.name)}</code>
<form method="post" action="${esc(p.basePath)}/account/admin/groups/remove" style="display:inline;margin:0">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<input type="hidden" name="userId" value="${esc(u.id)}">
<input type="hidden" name="groupName" value="${esc(g.name)}">
<input type="hidden" name="userSearch" value="${esc(adminUsers.userSearch || '')}">
<button class="secondary" style="padding:.15rem .4rem;font-size:.75rem">✕ ${esc(t(locale, 'account_admin_users_delete'))}</button>
</form>
</li>`,
            )
            .join('\n')
        : `<li style="color:#666"><em>${esc(t(locale, 'account_admin_users_no_groups'))}</em></li>`;

      userDetail = `<div style="background:#f8f9fa;border:1px solid #ddd;border-radius:.4rem;padding:1rem;margin-top:1rem">
<h4 style="margin:0 0 .5rem 0">${esc(u.display_name || u.email)} <small style="color:#666;font-weight:normal">(${esc(u.email)})</small></h4>
<p style="margin:.3rem 0"><strong>${esc(t(locale, 'account_admin_users_groups'))}:</strong></p>
<ul style="list-style:none;padding:0;margin:.5rem 0">
${groupItems}
</ul>
<form method="post" action="${esc(p.basePath)}/account/admin/groups/add" style="display:flex;gap:.5rem;align-items:center;margin-top:.8rem">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<input type="hidden" name="userId" value="${esc(u.id)}">
<input type="hidden" name="userSearch" value="${esc(adminUsers.userSearch || '')}">
<input type="text" name="groupName" list="admin-all-groups-datalist" placeholder="${esc(t(locale, 'account_admin_users_add_placeholder'))}" style="width:180px;padding:.3rem .5rem;font-size:.85rem" required pattern="^[a-zA-Z0-9_\\u00c0-\\u017e]+([./:@_-][a-zA-Z0-9_\\u00c0-\\u017e*]+)*$">
<datalist id="admin-all-groups-datalist">
${allGroupDatalistOptions}
</datalist>
<button class="alt" style="padding:.3rem .6rem;font-size:.85rem">${esc(t(locale, 'account_admin_users_add_button'))}</button>
</form>
</div>`;
    } else if (adminUsers.userSearch) {
      userDetail = `<p style="color:#666;font-size:.9rem;margin-top:.5rem"><em>${esc(t(locale, 'account_admin_users_not_found', { query: adminUsers.userSearch }))}</em></p>`;
    }

    adminSection = `<div style="border:1px solid #ccc;border-radius:.4rem;padding:1rem;margin-top:1.5rem">
<h3 style="margin-top:0">${esc(t(locale, 'account_admin_users_title'))}</h3>
${adminNoticeBanner}
${adminErrorBanner}
<form method="get" action="${esc(p.basePath)}/account" style="display:flex;gap:.5rem;align-items:center">
<input type="text" name="user_search" list="admin-users-datalist" placeholder="${esc(t(locale, 'account_admin_users_search_placeholder'))}" value="${esc(adminUsers.userSearch || '')}" style="flex:1" autocomplete="off">
<datalist id="admin-users-datalist">
${userDatalistOptions}
</datalist>
<button class="alt" style="padding:.4rem .8rem">${esc(t(locale, 'account_admin_users_find'))}</button>
${adminUsers.userSearch ? `<a href="${esc(p.basePath)}/account" style="font-size:.85rem;color:#666;text-decoration:none">${esc(t(locale, 'account_admin_users_clear'))}</a>` : ''}
</form>
${userDetail}
</div>`;
  }

  const statusBadge =
    p.isActive !== false
      ? `<span style="display:inline-block;padding:.2rem .4rem;border-radius:.25rem;font-size:.8rem;font-weight:600;background:#d4edda;color:#155724">${esc(t(locale, 'account_status_active'))}</span>`
      : `<span style="display:inline-block;padding:.2rem .4rem;border-radius:.25rem;font-size:.8rem;font-weight:600;background:#fff3cd;color:#856404">${esc(t(locale, 'account_status_inactive'))}</span>`;

  const titleRow = `<tr><th>${esc(t(locale, 'title'))}</th><td>${esc(p.title || '—')}</td></tr>`;
  const phoneRow = `<tr><th>${esc(t(locale, 'phone_number'))}</th><td>${esc(p.phoneNumber || '—')}</td></tr>`;
  const statusRow = `<tr><th>${esc(t(locale, 'account_status'))}</th><td>${statusBadge}</td></tr>`;

  let lifecycleRows = '';
  if (p.activatesAt) {
    lifecycleRows += `<tr><th>${esc(t(locale, 'account_activates_at'))}</th><td>${esc(new Date(p.activatesAt).toLocaleString(locale))}</td></tr>`;
  }
  if (p.disablesAt) {
    lifecycleRows += `<tr><th>${esc(t(locale, 'account_disables_at'))}</th><td>${esc(new Date(p.disablesAt).toLocaleString(locale))}</td></tr>`;
  }

  const inactiveNotice =
    p.isActive === false
      ? `<div style="background:#fff3cd;color:#856404;border:1px solid #ffeeba;padding:.8rem 1rem;border-radius:.4rem;margin:1rem 0">${esc(t(locale, 'account_inactive_notice'))}</div>`
      : '';

  return layout(
    ctx,
    t(locale, 'account_title'),
    `<h2>${esc(t(locale, 'account_title'))}</h2>
${inactiveNotice}
<table>
<tr><th>${esc(t(locale, 'name'))}</th><td>${esc(p.displayName)}</td></tr>
<tr><th>${esc(t(locale, 'email'))}</th><td>${esc(p.email)}</td></tr>
${titleRow}
${phoneRow}
${statusRow}
${lifecycleRows}
${groupsRow}
<tr><th>${esc(t(locale, 'account_totp_title'))}</th><td>${esc(statusText)}</td></tr>
</table>
${p.isActive !== false ? appsSection : ''}
${p.isActive !== false ? mcpSection : ''}
${p.isActive !== false ? mcpIdentitiesSection : ''}
${p.isActive !== false ? adminSection : ''}
<div class="actions" style="margin-top:1.5rem">
${totpAction}
<form method="post" action="${esc(p.basePath)}/account/logout">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<button class="secondary">${esc(t(locale, 'logout_title'))}</button></form>
</div>
${p.mcpIdentities ? mcpScriptAndStyles() : ''}`,
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

function mcpScriptAndStyles() {
  return `<style>
body{max-width:64rem}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.copy-btn{font:inherit;padding:.2rem .45rem;font-size:.75rem;border-radius:.25rem;cursor:pointer;background:#e2e8f0;color:#1e293b;border:1px solid #cbd5e1;display:inline-flex;align-items:center;gap:.25rem;transition:background-color .15s,border-color .15s}
.copy-btn:hover{background:#cbd5e1}
.copy-btn.copied{background:#dcfce7 !important;color:#166534 !important;border-color:#86efac !important}
.chip-container{display:flex;flex-wrap:wrap;gap:.35rem;padding:.4rem;border:1px solid #cbd5e1;border-radius:.35rem;background:#fff;min-height:2.5rem;align-items:center}
.chip{display:inline-flex;align-items:center;gap:.35rem;background:#f1f5f9;color:#334155;padding:.2rem .5rem;border-radius:1rem;font-size:.8rem;border:1px solid #e2e8f0}
.chip-remove{background:none;border:none;color:#94a3b8;cursor:pointer;padding:0;font-size:.95rem;line-height:1}
.chip-remove:hover{color:#dc2626}
.compact-table{width:100%;border-collapse:collapse;font-size:.85rem;margin-top:.5rem}
.compact-table th{background:#f8fafc;border-bottom:2px solid #cbd5e1;padding:.4rem .5rem;text-align:left}
.compact-table td{padding:.4rem .5rem;border-bottom:1px solid #e2e8f0;vertical-align:top}
.badge{display:inline-block;padding:.15rem .35rem;border-radius:.25rem;font-size:.7rem;font-weight:600}
.badge-blue{background:#e0f2fe;color:#0369a1}
.badge-gray{background:#f1f5f9;color:#475569}
.badge-green{background:#dcfce7;color:#166534}
</style>
<div id="a11y-status" role="status" aria-live="polite" class="sr-only"></div>
<script>
(function() {
  function copyToClipboard(text, btn) {
    if (!text) return;
    function announce() {
      if (btn) {
        var orig = btn.innerHTML;
        btn.classList.add('copied');
        btn.innerHTML = '✓ Copied!';
        setTimeout(function() {
          btn.classList.remove('copied');
          btn.innerHTML = orig;
        }, 2000);
      }
      var live = document.getElementById('a11y-status');
      if (live) live.textContent = 'Copied to clipboard: ' + text.slice(0, 60);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(announce).catch(function() { fallback(text, announce); });
    } else {
      fallback(text, announce);
    }
  }
  function fallback(text, cb) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand('copy'); if (cb) cb(); } catch(e) {}
    document.body.removeChild(ta);
  }

  document.addEventListener('click', function(e) {
    var btn = e.target.closest('.copy-btn');
    if (btn && btn.dataset.copy) {
      copyToClipboard(btn.dataset.copy, btn);
    }
  });

  var bulkInput = document.getElementById('quick-bulk-input');
  var chipsBox = document.getElementById('quick-bulk-chips');
  var btnCreate = document.getElementById('quick-bulk-btn');
  var btnClear = document.getElementById('quick-bulk-clear');
  var banner = document.getElementById('quick-bulk-banner');
  var credSelect = document.getElementById('quick-bulk-cred');
  var chips = [];

  function renderChips() {
    if (!chipsBox) return;
    chipsBox.innerHTML = '';
    if (chips.length === 0) {
      var ph = document.createElement('span');
      ph.style.color = '#94a3b8';
      ph.style.fontSize = '.85rem';
      ph.style.padding = '.2rem';
      ph.textContent = 'Type email or name, then press Enter...';
      chipsBox.appendChild(ph);
      return;
    }
    chips.forEach(function(val, idx) {
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = val + ' ';
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'chip-remove';
      rm.textContent = '✕';
      rm.setAttribute('aria-label', 'Remove ' + val);
      rm.onclick = function() { chips.splice(idx, 1); renderChips(); };
      chip.appendChild(rm);
      chipsBox.appendChild(chip);
    });
  }

  function addChipFromInput() {
    if (!bulkInput) return;
    var val = bulkInput.value.trim().replace(/^[,\\s]+|[,\\s]+$/g, '');
    if (val && chips.indexOf(val) === -1) {
      chips.push(val);
      bulkInput.value = '';
      renderChips();
    }
  }

  if (bulkInput) {
    bulkInput.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        triggerBulkCreate();
      } else if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addChipFromInput();
      } else if (e.key === 'Backspace' && !bulkInput.value && chips.length > 0) {
        chips.pop();
        renderChips();
      }
    });
  }

  if (btnClear) {
    btnClear.addEventListener('click', function() {
      chips = [];
      if (bulkInput) bulkInput.value = '';
      renderChips();
      if (banner) banner.style.display = 'none';
    });
  }

  function triggerBulkCreate() {
    addChipFromInput();
    if (chips.length === 0) {
      alert('Please enter at least one email or identity identifier.');
      if (bulkInput) bulkInput.focus();
      return;
    }
    var cred = credSelect ? credSelect.value : '';
    if (!cred) {
      alert('Please select an MCP credential.');
      return;
    }
    var csrf = btnCreate ? btnCreate.dataset.csrf : '';
    var basePath = (btnCreate ? btnCreate.dataset.basepath : '') || '';
    if (btnCreate) {
      btnCreate.disabled = true;
      btnCreate.textContent = '⏳ Creating refs...';
    }
    fetch(basePath + '/account/mcp-identities/refs/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ csrf: csrf, credential: cred, inputs: chips })
    })
    .then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok) throw new Error(data.error || 'Server error');
        return data;
      });
    })
    .then(function(data) {
      copyToClipboard(data.text);
      if (banner) {
        banner.style.display = 'block';
        banner.innerHTML = '<strong>✓ Created ' + data.count + ' reference(s) and copied to clipboard!</strong><br>' +
          '<small>Paste them directly into your client. They expire in 24 hours.</small><br>' +
          '<textarea readonly style="width:100%;margin-top:.4rem;padding:.4rem;font-size:.8rem;height:4rem;box-sizing:border-box" onclick="this.select()">' +
          data.text + '</textarea>';
      }
      chips = [];
      renderChips();
      if (window.location.pathname.indexOf('/mcp-identities') !== -1) {
        setTimeout(function() { window.location.reload(); }, 1500);
      }
    })
    .catch(function(err) {
      alert('Error creating references: ' + err.message);
    })
    .finally(function() {
      if (btnCreate) {
        btnCreate.disabled = false;
        btnCreate.textContent = '⚡ Create Refs & Copy to Clipboard';
      }
    });
  }

  if (btnCreate) {
    btnCreate.addEventListener('click', triggerBulkCreate);
  }

  var dirFilter = document.getElementById('dir-filter');
  if (dirFilter) {
    dirFilter.addEventListener('input', function() {
      var q = dirFilter.value.toLowerCase().trim();
      var rows = document.querySelectorAll('.dir-row');
      rows.forEach(function(row) {
        var s = (row.dataset.search || '').toLowerCase();
        row.style.display = (!q || s.indexOf(q) !== -1) ? '' : 'none';
      });
    });
  }

  var checkAll = document.getElementById('check-all');
  var bulkBar = document.getElementById('bulk-action-bar');
  var selCount = document.getElementById('selected-rows-count');
  var btnCopySelRefs = document.getElementById('btn-copy-selected-refs');
  var btnCopySelPseudos = document.getElementById('btn-copy-selected-pseudos');
  var btnClearSel = document.getElementById('btn-clear-selection');

  function updateBulkSelection() {
    var checked = document.querySelectorAll('.row-select:checked');
    if (selCount) selCount.textContent = checked.length;
    if (bulkBar) {
      bulkBar.style.display = checked.length > 0 ? 'flex' : 'none';
    }
  }

  if (checkAll) {
    checkAll.addEventListener('change', function() {
      var visibleRows = document.querySelectorAll(".dir-row:not([style*='display: none']) .row-select");
      visibleRows.forEach(function(cb) { cb.checked = checkAll.checked; });
      updateBulkSelection();
    });
  }

  document.addEventListener('change', function(e) {
    if (e.target.classList.contains('row-select')) {
      updateBulkSelection();
    }
  });

  if (btnClearSel) {
    btnClearSel.addEventListener('click', function() {
      document.querySelectorAll('.row-select').forEach(function(cb) { cb.checked = false; });
      if (checkAll) checkAll.checked = false;
      updateBulkSelection();
    });
  }

  if (btnCopySelRefs) {
    btnCopySelRefs.addEventListener('click', function() {
      var items = [];
      document.querySelectorAll('.row-select:checked').forEach(function(cb) {
        var r = cb.dataset.refs;
        if (r) {
          r.split(',').forEach(function(h) { if (h && items.indexOf(h) === -1) items.push(h); });
        }
      });
      if (items.length === 0) {
        alert('No active references in selected rows.');
        return;
      }
      copyToClipboard(items.join('\\n'), btnCopySelRefs);
    });
  }

  if (btnCopySelPseudos) {
    btnCopySelPseudos.addEventListener('click', function() {
      var items = [];
      document.querySelectorAll('.row-select:checked').forEach(function(cb) {
        var p = cb.dataset.pseudos;
        if (p) {
          p.split(',').forEach(function(h) { if (h && items.indexOf(h) === -1) items.push(h); });
        }
      });
      if (items.length === 0) {
        alert('No pseudonyms in selected rows.');
        return;
      }
      copyToClipboard(items.join('\\n'), btnCopySelPseudos);
    });
  }
})();
</script>`;
}

/**
 * Owner-facing MCP identity directory and temporary reference management.
 * @param {Ctx} ctx
 * @param {{ basePath: string, csrf: string, subjects: any[], users: any[], clients: any[], notice?: string, error?: string }} p
 */
export function mcpIdentityPage(ctx, p) {
  const userOptions = p.users
    .map(
      (u) =>
        `<option value="${esc(u.id)}">${esc(u.display_name || u.email)} · ${esc(u.email)}</option>`,
    )
    .join('');
  const userDatalistOptions = p.users
    .map(
      (u) =>
        `<option value="${esc(u.email)}">${esc(u.display_name || u.email)} (${esc(u.email)})</option>`,
    )
    .join('\n');
  const subjectOptions = p.subjects
    .map(
      (s) =>
        `<option value="${esc(s.subject_id)}">${esc(s.display_name || s.label || s.email || s.subject_id)}</option>`,
    )
    .join('');
  const clientSettings = p.clients
    .map(
      (c) =>
        '<form method="post" action="' +
        esc(p.basePath) +
        '/account/mcp/identity-mode" style="margin:.5rem 0;padding:.5rem;border:1px solid #ddd;border-radius:.3rem">' +
        '<input type="hidden" name="csrf" value="' +
        esc(p.csrf) +
        '">' +
        '<input type="hidden" name="authKind" value="' +
        esc(c.auth_kind) +
        '">' +
        '<input type="hidden" name="authClientKey" value="' +
        esc(c.auth_client_key) +
        '">' +
        '<strong>' +
        esc(c.label) +
        '</strong><br><select name="mode" style="margin:.3rem 0;font:inherit">' +
        '<option value="open" ' +
        ((c.identity_mode || 'open') === 'open' ? 'selected' : '') +
        '>Open</option>' +
        '<option value="pseudo_ref" ' +
        (c.identity_mode === 'pseudo_ref' ? 'selected' : '') +
        '>Pseudonym + refs</option>' +
        '<option value="ref_only" ' +
        (c.identity_mode === 'ref_only' ? 'selected' : '') +
        '>Refs only</option>' +
        '</select> <button class="alt" style="padding:.3rem .6rem">Save mode</button></form>',
    )
    .join('');
  const clientOptions = p.clients
    .map(
      (c) =>
        `<option value="${esc(c.auth_kind)}|${esc(c.auth_client_key)}">${esc(c.label)}</option>`,
    )
    .join('');

  const directoryRows = p.subjects
    .map((s) => {
      const label = s.display_name || s.label || s.email || s.subject_id;
      const aliases = s.pseudonyms || [];
      const activeRefs = (s.refs || []).filter(
        (r) => !r.revoked_at && new Date(r.expires_at).getTime() > Date.now(),
      );
      const searchTerms = [
        label,
        s.email || '',
        s.tunnus_user_id || '',
        ...aliases.map((a) => a.pseudonym),
        ...activeRefs.map((r) => r.handle),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      const refsHandles = activeRefs.map((r) => `ref:${r.handle}`).join(',');
      const pseudoHandles = aliases.map((a) => `pseudo:${a.pseudonym}`).join(',');

      const pseudonymsHtml = aliases.length
        ? aliases
            .map(
              (a) => `
      <div style="display:inline-flex;align-items:center;gap:.25rem;margin:.1rem .25rem .1rem 0;background:#f1f5f9;border:1px solid #e2e8f0;padding:.15rem .35rem;border-radius:.25rem;font-size:.8rem">
        <code>pseudo:${esc(a.pseudonym)}</code>
        ${a.is_preferred ? '<span title="Preferred" style="font-size:.7rem;color:#0284c7;font-weight:bold">★</span>' : ''}
        <button type="button" class="copy-btn" data-copy="pseudo:${esc(a.pseudonym)}" aria-label="Copy pseudo:${esc(a.pseudonym)}" style="padding:.1rem .25rem;font-size:.7rem">📋</button>
        <form method="post" action="${esc(p.basePath)}/account/mcp-identities/pseudonyms/delete" style="display:inline;margin:0">
          <input type="hidden" name="csrf" value="${esc(p.csrf)}"><input type="hidden" name="pseudonymId" value="${esc(a.id)}">
          <button class="secondary" style="padding:0;color:#94a3b8;font-size:.8rem;text-decoration:none" title="Delete pseudonym">✕</button>
        </form>
      </div>`,
            )
            .join('')
        : '<span style="color:#94a3b8;font-size:.8rem">—</span>';

      const refsHtml = activeRefs.length
        ? activeRefs
            .map((r) => {
              const diffHours = Math.max(
                0,
                Math.round((new Date(r.expires_at).getTime() - Date.now()) / (1000 * 60 * 60)),
              );
              return `
      <div style="display:inline-flex;align-items:center;gap:.35rem;margin:.15rem 0;background:#f8fafc;border:1px solid #cbd5e1;padding:.15rem .4rem;border-radius:.25rem;font-size:.8rem">
        <code>ref:${esc(r.handle)}</code>
        <button type="button" class="copy-btn" data-copy="ref:${esc(r.handle)}" aria-label="Copy reference ref:${esc(r.handle)}" style="padding:.1rem .35rem;font-size:.75rem">📋 Copy</button>
        <span style="font-size:.75rem;color:#64748b">${esc(r.auth_client_key || r.auth_kind)} · ${diffHours}h left</span>
        <form method="post" action="${esc(p.basePath)}/account/mcp-identities/refs/extend" style="display:inline;margin:0">
          <input type="hidden" name="csrf" value="${esc(p.csrf)}"><input type="hidden" name="refId" value="${esc(r.id)}">
          <button class="alt" style="padding:.1rem .3rem;font-size:.7rem" title="Extend 24 hours">+24h</button>
        </form>
        <form method="post" action="${esc(p.basePath)}/account/mcp-identities/refs/revoke" style="display:inline;margin:0">
          <input type="hidden" name="csrf" value="${esc(p.csrf)}"><input type="hidden" name="refId" value="${esc(r.id)}">
          <button class="secondary" style="padding:.1rem .2rem;font-size:.7rem;color:#dc2626;text-decoration:none" title="Revoke reference">Revoke</button>
        </form>
      </div>`;
            })
            .join('<br>')
        : '<span style="color:#94a3b8;font-size:.8rem">—</span>';

      const subjectBadge = s.tunnus_user_id
        ? `<div style="font-size:.75rem;color:#64748b"><span class="badge badge-green">Linked</span> ${esc(s.email || s.tunnus_user_id)}</div>`
        : `<div style="font-size:.75rem;color:#64748b"><span class="badge badge-gray">External</span></div>`;

      return `<tr class="dir-row" data-search="${esc(searchTerms)}" data-refs="${esc(refsHandles)}" data-pseudos="${esc(pseudoHandles)}">
<td style="text-align:center"><input type="checkbox" class="row-select" data-refs="${esc(refsHandles)}" data-pseudos="${esc(pseudoHandles)}" aria-label="Select ${esc(label)}"></td>
<td><strong>${esc(label)}</strong>${subjectBadge}</td>
<td>${pseudonymsHtml}</td>
<td>${refsHtml}</td>
<td style="text-align:right">
<details style="display:inline-block;margin-right:.3rem">
  <summary style="cursor:pointer;font-size:.75rem;color:#0284c7;font-weight:600">+ Pseudo</summary>
  <form method="post" action="${esc(p.basePath)}/account/mcp-identities/pseudonyms" style="margin:.3rem 0;padding:.4rem;background:#fff;border:1px solid #cbd5e1;border-radius:.3rem;text-align:left">
    <input type="hidden" name="csrf" value="${esc(p.csrf)}"><input type="hidden" name="subjectId" value="${esc(s.subject_id)}">
    <input name="pseudonym" placeholder="New pseudonym" maxlength="100" required style="padding:.2rem;font-size:.75rem;margin:0 0 .3rem 0;width:100%;box-sizing:border-box">
    <label style="font-size:.75rem;display:block;margin-bottom:.3rem"><input type="checkbox" name="preferred" value="true"> Preferred</label>
    <button style="padding:.2rem .4rem;font-size:.75rem">Add</button>
  </form>
</details>
${
  !s.tunnus_user_id
    ? `
<details style="display:inline-block">
  <summary style="cursor:pointer;font-size:.75rem;color:#0284c7;font-weight:600">Link User</summary>
  <form method="post" action="${esc(p.basePath)}/account/mcp-identities/link" style="margin:.3rem 0;padding:.4rem;background:#fff;border:1px solid #cbd5e1;border-radius:.3rem;text-align:left">
    <input type="hidden" name="csrf" value="${esc(p.csrf)}"><input type="hidden" name="subjectId" value="${esc(s.subject_id)}">
    <select name="userId" required style="font-size:.75rem;margin:0 0 .3rem 0;width:100%"><option value="">Select user</option>${userOptions}</select>
    <button class="alt" style="padding:.2rem .4rem;font-size:.75rem">Link</button>
  </form>
</details>
`
    : ''
}
</td>
</tr>`;
    })
    .join('\n');

  const notice = p.notice
    ? `<p style="color:#0f5132;background:#d1e7dd;padding:.5rem;border-radius:.3rem;font-size:.9rem">${esc(p.notice)}</p>`
    : '';
  const error = p.error
    ? `<p class="err" style="background:#f8d7da;padding:.5rem;border-radius:.3rem;font-size:.9rem">${esc(p.error)}</p>`
    : '';

  return layout(
    ctx,
    'MCP pseudonyms and references',
    `<p><a href="${esc(p.basePath)}/account">← Back to Account</a></p>
<h2>MCP Pseudonyms & References Directory</h2>
<p style="color:#475569">Pseudonyms and temporary references are private to this account. References are scoped to one MCP credential and expire after 24 hours unless extended.</p>
${notice}${error}

<div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:.4rem;padding:1rem;margin:1rem 0">
  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem;margin-bottom:.5rem">
    <strong style="font-size:1rem">⚡ Quick Bulk Reference Creator</strong>
    <span style="font-size:.8rem;color:#64748b">Type user emails/names & press Enter</span>
  </div>
  <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.5rem">
    <div style="flex:1;min-width:14rem">
      <label style="font-size:.8rem;color:#475569;display:block;margin-bottom:.2rem">MCP Credential</label>
      <select id="quick-bulk-cred" style="width:100%;padding:.45rem;font:inherit;border-radius:.3rem;border:1px solid #cbd5e1">${clientOptions}</select>
    </div>
    <div style="flex:2;min-width:18rem">
      <label style="font-size:.8rem;color:#475569;display:block;margin-bottom:.2rem">Type User (Enter to add)</label>
      <input id="quick-bulk-input" list="quick-bulk-users-dl" placeholder="Type email or name, then press Enter..." autocomplete="off" style="margin:0;padding:.45rem;border:1px solid #cbd5e1;border-radius:.3rem">
      <datalist id="quick-bulk-users-dl">${userDatalistOptions}</datalist>
    </div>
  </div>
  <div style="margin-bottom:.6rem">
    <label style="font-size:.8rem;color:#475569;display:block;margin-bottom:.2rem">Recipients / Subjects to create refs for:</label>
    <div id="quick-bulk-chips" class="chip-container">
      <span style="color:#94a3b8;font-size:.85rem;padding:.2rem">Type email or name, then press Enter...</span>
    </div>
  </div>
  <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
    <button type="button" id="quick-bulk-btn" data-csrf="${esc(p.csrf)}" data-basepath="${esc(p.basePath)}" style="background:#0284c7;font-weight:600;padding:.5rem 1rem">⚡ Create Refs & Copy to Clipboard</button>
    <button type="button" id="quick-bulk-clear" class="secondary" style="font-size:.85rem">Clear</button>
    <span style="font-size:.75rem;color:#64748b">Shortcut: press <strong>Ctrl+Enter</strong> anytime</span>
  </div>
  <div id="quick-bulk-banner" style="display:none;margin-top:.75rem;padding:.75rem;border-radius:.35rem;background:#dcfce7;border:1px solid #86efac;color:#166534"></div>
</div>

<div style="margin-top:1.5rem">
  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem;margin-bottom:.5rem">
    <h3 style="margin:0">Identity Directory (${p.subjects.length})</h3>
    <input type="search" id="dir-filter" placeholder="🔍 Search directory..." style="max-width:18rem;margin:0;padding:.35rem .6rem;font-size:.85rem;border:1px solid #cbd5e1;border-radius:.3rem">
  </div>
  
  <div id="bulk-action-bar" style="display:none;background:#eff6ff;border:1px solid #bfdbfe;padding:.4rem .75rem;border-radius:.35rem;margin-bottom:.75rem;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.5rem">
    <span style="font-weight:600;font-size:.85rem;color:#1e40af"><span id="selected-rows-count">0</span> row(s) selected</span>
    <div style="display:flex;gap:.5rem;align-items:center">
      <button type="button" class="copy-btn" id="btn-copy-selected-refs">📋 Copy Selected Active Refs</button>
      <button type="button" class="copy-btn" id="btn-copy-selected-pseudos">📋 Copy Selected Pseudonyms</button>
      <button type="button" class="secondary" id="btn-clear-selection" style="font-size:.8rem">Clear selection</button>
    </div>
  </div>

  <div style="overflow-x:auto">
    <table class="compact-table">
      <thead>
        <tr>
          <th style="width:2rem;text-align:center"><input type="checkbox" id="check-all" aria-label="Select all rows"></th>
          <th>Subject / Person</th>
          <th>Pseudonyms</th>
          <th>Active References (24 h)</th>
          <th style="text-align:right">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${directoryRows || '<tr><td colspan="5" style="text-align:center;color:#64748b;padding:1rem">No identity subjects yet.</td></tr>'}
      </tbody>
    </table>
  </div>
</div>

<details style="border:1px solid #e2e8f0;border-radius:.4rem;padding:.75rem;margin-top:1.5rem">
<summary style="cursor:pointer;font-weight:600">Add External / Custom Identity Subject</summary>
<form method="post" action="${esc(p.basePath)}/account/mcp-identities/subjects" style="margin-top:.75rem">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<label>Existing Tunnus user (optional)<select name="userId"><option value="">External / not linked</option>${userOptions}</select></label>
<label>Label for external identity<input name="label" maxlength="200"></label>
<button>Create subject</button>
</form>
</details>

<details style="border:1px solid #e2e8f0;border-radius:.4rem;padding:.75rem;margin-top:.75rem">
<summary style="cursor:pointer;font-weight:600">MCP Client Identity Modes</summary>
<div style="margin-top:.75rem">${clientSettings || '<p>No active MCP credentials found.</p>'}</div>
</details>

<details style="border:1px solid #e2e8f0;border-radius:.4rem;padding:.75rem;margin-top:.75rem">
<summary style="cursor:pointer;font-weight:600">Create Single Reference (Manual)</summary>
<form method="post" action="${esc(p.basePath)}/account/mcp-identities/refs" style="margin-top:.75rem">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<label>Existing identity subject<select name="subjectId"><option value="">Select subject</option>${subjectOptions}</select></label>
<label>Or select Tunnus user<select name="userId"><option value="">Select user</option>${userOptions}</select></label>
<label>MCP credential<select name="credential" required><option value="">Select client</option>${clientOptions}</select></label>
<button>Create new reference (24 h)</button>
</form>
</details>
${mcpScriptAndStyles()}`,
  );
}
