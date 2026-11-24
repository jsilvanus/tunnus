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
<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}
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
        const resourcesStr =
          app.resources && app.resources.length > 0
            ? `<br><small style="color:#555"><em>${esc(t(locale, 'account_apps_resources'))}:</em> ${esc(app.resources.join(', '))}</small>`
            : '';
        return `<tr>
<td><strong>${esc(app.clientName)}</strong>${mcpBadge}${idSubtitle}</td>
<td><small style="color:#555">${scopesStr}</small>${resourcesStr}</td>
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
</div>`;

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

/**
 * Owner-facing MCP identity directory and temporary reference management.
 * @param {Ctx} ctx
 * @param {{ basePath: string, csrf: string, subjects: any[], users: any[], clients: any[], notice?: string, error?: string }} p
 */
export function mcpIdentityPage(ctx, p) {
  const userOptions = p.users.map((u) =>
    `<option value="${esc(u.id)}">${esc(u.display_name || u.email)} · ${esc(u.email)}</option>`,
  ).join('');
  const subjectOptions = p.subjects.map((s) =>
    `<option value="${esc(s.subject_id)}">${esc(s.display_name || s.label || s.email || s.subject_id)}</option>`,
  ).join('');
  const clientOptions = p.clients.map((c) =>
    `<option value="${esc(c.auth_kind)}|${esc(c.auth_client_key)}">${esc(c.label)}</option>`,
  ).join('');

  const subjectCards = p.subjects.map((s) => {
    const label = s.display_name || s.label || s.email || s.subject_id;
    const aliases = (s.pseudonyms || []).map((a) => `<li><code>pseudo:${esc(a.pseudonym)}</code> ${a.is_preferred ? '<strong>(preferred)</strong>' : ''}
<form method="post" action="${esc(p.basePath)}/account/mcp-identities/pseudonyms/delete" style="display:inline">
<input type="hidden" name="csrf" value="${esc(p.csrf)}"><input type="hidden" name="pseudonymId" value="${esc(a.id)}">
<button class="secondary">Delete</button></form></li>`).join('');
    const refs = (s.refs || []).map((r) => {
      const expired = r.revoked_at || new Date(r.expires_at).getTime() <= Date.now();
      const scope = `${r.auth_kind}: ${r.auth_client_key}`;
      return `<tr><td><code>ref:${esc(r.handle)}</code><br><small>${esc(scope)}</small></td>
<td>${esc(new Date(r.expires_at).toLocaleString(ctx.locale))}${r.revoked_at ? ' · revoked' : expired ? ' · expired' : ''}</td>
<td>${expired ? '' : `<form method="post" action="${esc(p.basePath)}/account/mcp-identities/refs/extend"><input type="hidden" name="csrf" value="${esc(p.csrf)}"><input type="hidden" name="refId" value="${esc(r.id)}"><button class="alt">Extend 24 h</button></form>
<form method="post" action="${esc(p.basePath)}/account/mcp-identities/refs/revoke"><input type="hidden" name="csrf" value="${esc(p.csrf)}"><input type="hidden" name="refId" value="${esc(r.id)}"><button class="secondary">Revoke</button></form>`}</td></tr>`;
    }).join('');
    const linked = s.tunnus_user_id ? `<small>Linked Tunnus user: ${esc(s.email || s.tunnus_user_id)}</small>` : '<small>External identity (not linked)</small>';
    const linkForm = !s.tunnus_user_id ? `<form method="post" action="${esc(p.basePath)}/account/mcp-identities/link">
<input type="hidden" name="csrf" value="${esc(p.csrf)}"><input type="hidden" name="subjectId" value="${esc(s.subject_id)}">
<label>Link to Tunnus user<select name="userId" required><option value="">Select user</option>${userOptions}</select></label><button class="alt">Link</button></form>` : '';
    return `<section style="border:1px solid #ccc;border-radius:.4rem;padding:1rem;margin:1rem 0">
<h3>${esc(label)}</h3>${linked}
<h4>Pseudonyms</h4><ul>${aliases || '<li>None</li>'}</ul>
<form method="post" action="${esc(p.basePath)}/account/mcp-identities/pseudonyms">
<input type="hidden" name="csrf" value="${esc(p.csrf)}"><input type="hidden" name="subjectId" value="${esc(s.subject_id)}">
<label>New pseudonym<input name="pseudonym" maxlength="100" required></label>
<label><input type="checkbox" name="preferred" value="true"> Preferred output pseudonym</label><button>Add pseudonym</button></form>
${linkForm}
<h4>Temporary references</h4><table><thead><tr><th>Reference / client</th><th>Expires</th><th></th></tr></thead><tbody>${refs || '<tr><td colspan="3">No references</td></tr>'}</tbody></table>
</section>`;
  }).join('');

  const notice = p.notice ? `<p style="color:#155724">${esc(p.notice)}</p>` : '';
  const error = p.error ? `<p class="err">${esc(p.error)}</p>` : '';
  return layout(ctx, 'MCP pseudonyms and references', `<p><a href="${esc(p.basePath)}/account">← Account</a></p>
<h2>MCP pseudonyms and references</h2>
<p>Pseudonyms and temporary references are private to this account. References are scoped to one MCP credential and expire after 24 hours unless extended.</p>
${notice}${error}
<section><h3>Add identity subject</h3>
<form method="post" action="${esc(p.basePath)}/account/mcp-identities/subjects">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<label>Existing Tunnus user (optional)<select name="userId"><option value="">External / not linked</option>${userOptions}</select></label>
<label>Label for external identity<input name="label" maxlength="200"></label><button>Create subject</button></form></section>
<section><h3>Create temporary reference</h3>
<form method="post" action="${esc(p.basePath)}/account/mcp-identities/refs">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<label>Identity subject<select name="subjectId" required><option value="">Select subject</option>${subjectOptions}</select></label>
<label>MCP credential<select name="credential" required><option value="">Select client</option>${clientOptions}</select></label>
<button>Create new reference (24 h)</button></form></section>
${subjectCards || '<p>No identity subjects yet.</p>'}`);
}
