import Provider, { interactionPolicy } from 'oidc-provider';
import { createAdapterClass } from './adapter.js';
import { createFindAccount } from '../accounts.js';

/**
 * Build the oidc-provider instance.
 * @param {{ config: import('../config.js').Config, pool: import('pg').Pool, clients: Record<string, any>[], jwks: { keys: any[] } }} deps
 */
export function createProvider({ config, pool, clients, jwks }) {
  const alwaysGroups = new Set(
    clients.filter((c) => c.always_include_groups).map((c) => c.client_id),
  );
  const day = 24 * 60 * 60;

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

  const provider = new Provider(config.issuer, {
    adapter: createAdapterClass(pool),
    clients: clients.map(({ client_id, always_include_groups, first_party, ...rest }) => ({
      id_token_signed_response_alg: 'RS256',
      ...rest,
      client_id,
      always_include_groups: Boolean(always_include_groups),
      first_party: Boolean(first_party),
    })),
    extraClientMetadata: { properties: ['first_party', 'always_include_groups'] },
    jwks,
    cookies: { keys: config.cookieSecrets },
    findAccount: createFindAccount(pool),
    claims: {
      openid: ['sub'],
      email: ['email', 'email_verified'],
      profile: ['name'],
      groups: ['groups'],
    },
    scopes: ['openid', 'offline_access', 'email', 'profile', 'groups'],
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
    features: { devInteractions: { enabled: false }, rpInitiatedLogout: { enabled: true } },
    // First-party clients skip the consent screen.
    loadExistingGrant: async (ctx) => {
      const oidc = /** @type {any} */ (ctx.oidc);
      const client = oidc.client;
      const grantId = oidc.result?.consent?.grantId || oidc.session.grantIdFor(client.clientId);
      if (grantId) return oidc.provider.Grant.find(grantId);
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
  provider.use(async (ctx, next) => {
    if (ctx.oidc?.route === undefined && ctx.path.endsWith('/auth') && ctx.method === 'GET') {
      const params = new URLSearchParams(ctx.querystring);
      const scope = params.get('scope');
      if (
        scope &&
        alwaysGroups.has(params.get('client_id') ?? '') &&
        !scope.split(' ').includes('groups')
      ) {
        params.set('scope', `${scope} groups`);
        ctx.querystring = params.toString();
      }
    }
    await next();
  });

  if (config.trustProxy) provider.proxy = true;
  return provider;
}
