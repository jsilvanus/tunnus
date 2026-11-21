import Provider, { interactionPolicy } from 'oidc-provider';
import { createAdapterClass } from './adapter.js';
import { createFindAccount } from '../accounts.js';
import { errorFields, logger } from '../logger.js';
import { accountIdOf, touchLastLogin } from './loginActivity.js';
import { pickLocale } from '../i18n.js';
import { alwaysGroupsOf, scopeWithGroups } from './alwaysGroups.js';
import { logoutDonePage, logoutPage } from '../web/pages.js';

/**
 * Build the oidc-provider instance.
 * @param {{ config: import('../config.js').Config, pool: import('pg').Pool, clients: Record<string, any>[], jwks: { keys: any[] } }} deps
 */
export function createProvider({ config, pool, clients, jwks }) {
  const alwaysGroups = alwaysGroupsOf(clients);
  const day = 24 * 60 * 60;
  /** @param {any} ctx */
  const pageCtx = (ctx) => ({ config, locale: pickLocale(ctx.req, config.defaultLocale) });

  // With an existing session, ask the user to confirm the account unless the client passed prompt=none.
  const policy = interactionPolicy.base();
  policy.get('login')?.checks.add(
    new interactionPolicy.Check('continue_as', 'Confirm the signed-in account', (ctx) => {
      const oidc = /** @type {any} */ (ctx.oidc);
      if (!oidc.session?.accountId || oidc.result?.login)
        return interactionPolicy.Check.NO_NEED_TO_PROMPT;
      if (
        String(oidc.params?.prompt ?? '')
          .split(' ')
          .includes('none')
      )
        return interactionPolicy.Check.NO_NEED_TO_PROMPT;
      return interactionPolicy.Check.REQUEST_PROMPT;
    }),
    0,
  );

  const mcpOauth = Boolean(config.mcp?.oauthEnabled);
  const scopes = ['openid', 'offline_access', 'email', 'profile', 'groups'];
  if (mcpOauth) scopes.push('mcp');

  const provider = new Provider(config.issuer, {
    adapter: createAdapterClass(pool),
    clients: clients.map(({ client_id, always_include_groups, first_party, disabled, ...rest }) => ({
      id_token_signed_response_alg: 'RS256',
      ...rest,
      client_id,
      always_include_groups: Boolean(always_include_groups),
      first_party: Boolean(first_party),
      disabled: Boolean(disabled),
    })),
    extraClientMetadata: { properties: ['first_party', 'always_include_groups', 'disabled'] },
    jwks,
    cookies: { keys: config.cookieSecrets },
    findAccount: createFindAccount(pool),
    claims: {
      openid: ['sub'],
      email: ['email', 'email_verified'],
      profile: ['name'],
      groups: ['groups'],
    },
    scopes,
    conformIdTokenClaims: false,
    pkce: { required: () => true },
    ttl: {
      AuthorizationCode: 60,
      AccessToken: 600,
      IdToken: 600,
      RefreshToken: 30 * day,
      Interaction: 600,
      Session: config.sessionTtlDays * day,
      Grant: 30 * day,
    },
    rotateRefreshToken: true,
    interactions: {
      policy,
      url: (_ctx, interaction) => `${config.basePath}/interaction/${interaction.uid}`,
    },
    features: {
      devInteractions: { enabled: false },
      // Branded pages in place of the library's English pages, which load a web font and so do not
      // render under the CSP. Both use the same form contract (xsrf field, logout=yes).
      rpInitiatedLogout: {
        enabled: true,
        logoutSource: async (/** @type {any} */ ctx, /** @type {string} */ form) => {
          ctx.type = 'html';
          ctx.body = logoutPage(pageCtx(ctx), form);
        },
        postLogoutSuccessSource: async (/** @type {any} */ ctx) => {
          ctx.type = 'html';
          ctx.body = logoutDonePage(pageCtx(ctx));
        },
      },
      // Clients may revoke their own access and refresh tokens (RFC 7009).
      revocation: { enabled: true },
      ...(mcpOauth
        ? {
            clientIdMetadataDocument: {
              enabled: true,
              ack: 'draft-02',
            },
            resourceIndicators: {
              enabled: true,
              getResourceServerInfo: (
                /** @type {any} */ _ctx,
                /** @type {string} */ resourceIndicator,
              ) => {
                if (resourceIndicator !== config.mcp.resourceUrl)
                  return /** @type {any} */ (undefined);
                return {
                  scope: 'mcp',
                  audience: resourceIndicator,
                  accessTokenTTL: 600,
                  accessTokenFormat: 'jwt',
                  jwt: { sign: { alg: 'RS256' } },
                };
              },
            },
          }
        : {}),
    },
    // First-party clients skip the consent screen.
    loadExistingGrant: async (ctx) => {
      const oidc = /** @type {any} */ (ctx.oidc);
      const client = oidc.client;
      const grantId = oidc.result?.consent?.grantId || oidc.session.grantIdFor(client.clientId);
      if (grantId) {
        const grant = await oidc.provider.Grant.find(grantId);
        // A first-party client was granted its scopes at the first sign-in. A scope it asks for
        // later is added to that grant, so the consent screen is not shown for it.
        if (grant && client.first_party && oidc.params.scope) {
          grant.addOIDCScope(oidc.params.scope);
          await grant.save();
        }
        return grant;
      }
      if (!client.first_party) return undefined;
      const grant = new oidc.provider.Grant({
        clientId: client.clientId,
        accountId: oidc.session.accountId,
      });
      grant.addOIDCScope(oidc.params.scope ?? '');
      await grant.save();
      return grant;
    },
  });

  // Clients flagged always_include_groups receive the groups claim without asking for the scope.
  // Only GET /auth reaches the authorization endpoint: POST /auth is off (enableHttpPostMethods is
  // not set), and pushed requests and request objects are off too. If any of them is enabled, the
  // scope has to be rewritten there as well (see scopeWithGroups).
  provider.use(async (ctx, next) => {
    if (ctx.oidc?.route === undefined && ctx.path.endsWith('/auth') && ctx.method === 'GET') {
      const params = new URLSearchParams(ctx.querystring);
      const scope = scopeWithGroups(
        params.get('scope') ?? undefined,
        params.get('client_id') ?? undefined,
        alwaysGroups,
      );
      if (scope !== undefined) {
        params.set('scope', scope);
        ctx.querystring = params.toString();
      }
    }
    await next();
  });

  // Activity without an interactive sign-in (silent authorization, refresh tokens) counts too.
  const recordActivity = (/** @type {any} */ ctx) => {
    const accountId = accountIdOf(ctx);
    if (accountId)
      touchLastLogin(pool, accountId).catch((err) =>
        logger.error({ err: errorFields(err) }, 'last login update failed'),
      );
  };
  provider.on('authorization.success', recordActivity);
  provider.on('grant.success', recordActivity);

  if (config.trustProxy) provider.proxy = true;

  const origFindClient = provider.Client.find.bind(provider.Client);
  provider.Client.find = async (id) => {
    const client = await origFindClient(id);
    if (client?.disabled) return undefined;
    return client;
  };

  return provider;
}
