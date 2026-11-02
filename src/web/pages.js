/** @param {unknown} s */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * @param {{ brand: { name: string, color: string, logoUrl: string, privacyNoticeUrl: string } }} config
 * @param {string} title
 * @param {string} body
 */
export function layout(config, title, body) {
  const { brand } = config;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(brand.name)}</title>
<style>body{font:16px system-ui,sans-serif;max-width:24rem;margin:3rem auto;padding:0 1rem}
button{background:${esc(brand.color)};color:#fff;border:0;padding:.6rem 1rem;border-radius:.3rem;font:inherit;cursor:pointer}
input{font:inherit;padding:.5rem;width:100%;box-sizing:border-box;margin:.4rem 0 1rem}.err{color:#b00020}</style>
</head><body>${brand.logoUrl ? `<img src="${esc(brand.logoUrl)}" alt="" height="40">` : ''}
<h1>${esc(brand.name)}</h1>${body}
${brand.privacyNoticeUrl ? `<p><a href="${esc(brand.privacyNoticeUrl)}">Privacy</a></p>` : ''}
</body></html>`;
}

/**
 * @param {any} config
 * @param {string} action
 * @param {string} [error]
 */
export function emailPage(config, action, error) {
  return layout(
    config,
    'Sign in',
    `<form method="post" action="${esc(action)}">
<label>Email address<input type="email" name="email" autocomplete="email" required autofocus></label>
${error ? `<p class="err">${esc(error)}</p>` : ''}<button>Send code</button></form>`,
  );
}

/**
 * @param {any} config
 * @param {string} action
 * @param {string} [error]
 */
export function codePage(config, action, error) {
  return layout(
    config,
    'Enter code',
    `<p>If the address can sign in, we have sent a 6-digit code to it.</p>
<form method="post" action="${esc(action)}">
<label>Code<input name="code" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" required autofocus></label>
${error ? `<p class="err">${esc(error)}</p>` : ''}<button>Continue</button></form>`,
  );
}

/**
 * @param {any} config
 * @param {string} action
 * @param {string} clientName
 * @param {string[]} scopes
 */
export function consentPage(config, action, clientName, scopes) {
  return layout(
    config,
    'Consent',
    `<p><strong>${esc(clientName)}</strong> wants access to: ${scopes.map(esc).join(', ')}.</p>
<form method="post" action="${esc(action)}"><button>Allow</button></form>
<form method="post" action="${esc(action)}/abort"><button>Deny</button></form>`,
  );
}
