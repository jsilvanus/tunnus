import Provider, { interactionPolicy } from 'oidc-provider';
import { createAdapterClass } from './adapter.js';
import { createFindAccount } from '../accounts.js';
import { errorFields, logger } from '../logger.js';
import { accountIdOf, touchLastLogin } from './loginActivity.js';
import { pickLocale } from '../i18n.js';
import { alwaysGroupsOf, scopeWithGroups } from './alwaysGroups.js';
import { logoutDonePage, logoutPage } from '../web/pages.js';
import {
  EXTRA_CLIENT_METADATA_PROPERTIES,
  normalizeClientForProvider,
} from '../clients/validate.js';

export { EXTRA_CLIENT_METADATA_PROPERTIES };

/**
 * Create the getResourceServerInfo resolver for RFC 8707 / RFC 9728 resource indicators.
 * @param {{ config: import('../config.js').Config, clients: Record<string, any>[] }} deps
 */
export function createResourceServerInfoResolver({ config, clients }) {
  return (
    /** @type {any} */ ctx,
    /** @type {string} */ resourceIndicator,
    /** @type {any} */ client,
  ) => {
    const c = client || ctx?.oidc?.client;
    const rawClient = clients?.find((cl) => cl.client_id === (c?.clientId || c?.client_id));
    const clientAllowedResources = c?.allowed_resources || rawClient?.allowed_resources;
    const isFirstParty = Boolean(c?.first_party || rawClient?.first_party);

    let isAllowed = false;
    if (config.mcp?.resourceUrl && resourceIndicator === config.mcp.resourceUrl) {
      isAllowed = true;
    } else if (
      Array.isArray(clientAllowedResources) &&
      clientAllowedResources.includes(resourceIndicator)
    ) {
      isAllowed = true;
    } else if (isFirstParty) {
      if (
        Array.isArray(config.allowedResourceOrigins) &&
        config.allowedResourceOrigins.some(
          (origin) => origin && resourceIndicator.startsWith(origin),
        )
      ) {
        isAllowed = true;
      } else if (
        Array.isArray(clientAllowedResources) &&
        clientAllowedResources.some((res) => res && resourceIndicator.startsWith(res))
      ) {
        isAllowed = true;
      } else if (clients) {
        for (const otherClient of clients) {
          if (
            Array.isArray(otherClient.allowed_resources) &&
            otherClient.allowed_resources.includes(resourceIndicator)
          ) {
            isAllowed = true;
            break;
          }
          if (Array.isArray(otherClient.redirect_uris)) {
            for (const uri of otherClient.redirect_uris) {
              try {
                const origin = new URL(uri).origin;
                if (origin && resourceIndicator.startsWith(origin)) {
                  isAllowed = true;
                  break;
                }
              } catch {
                // ignore invalid url
              }
            }
            if (isAllowed) break;
          }
        }
      }
    }

    if (!isAllowed) return /** @type {any} */ (undefined);

    return {
      scope: 'mcp',
      audience: resourceIndicator,
      accessTokenTTL: 600,
      accessTokenFormat: 'jwt',
      jwt: { sign: { alg: 'RS256' } },
    };
  };
}

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
    clients: clients.map(normalizeClientForProvider),
    extraClientMetadata: {
      properties: EXTRA_CLIENT_METADATA_PROPERTIES,
    },
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
      backchannelLogout: { enabled: true },
      ...(mcpOauth
        ? {
            clientIdMetadataDocument: {
              enabled: true,
              ack: 'draft-02',
            },
            resourceIndicators: {
              enabled: true,
              getResourceServerInfo: createResourceServerInfoResolver({ config, clients }),
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
