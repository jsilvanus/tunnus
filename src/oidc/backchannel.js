import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { getActiveKey } from './keys.js';
import { revokeUserSessions } from '../accounts.js';
import { audit } from '../audit.js';
import { errorFields, logger } from '../logger.js';

/**
 * Build and sign an RS256 logout_token JWT.
 * @param {{
 *   config: import('../config.js').Config,
 *   activeKey: Record<string, any>,
 *   userId: string,
 *   clientId: string,
 *   events?: Record<string, any>,
 * }} params
 * @returns {string}
 */
export function createLogoutToken({ config, activeKey, userId, clientId, events }) {
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    kid: activeKey.kid,
  };
  const payload = {
    iss: config.issuer,
    sub: userId,
    aud: clientId,
    iat: Math.floor(Date.now() / 1000),
    jti: randomUUID(),
    events: events || {
      'http://schemas.openid.net/event/backchannel-logout': {},
      'https://tunnus.fi/event/mcp-revoke': {},
    },
  };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const privateKey = createPrivateKey({ key: activeKey, format: 'jwk' });
  const signature = sign('sha256', Buffer.from(signingInput), privateKey).toString('base64url');

  return `${signingInput}.${signature}`;
}

/**
 * Dispatch back-channel logout to a registered client.
 * @param {{
 *   config: import('../config.js').Config,
 *   pool: import('pg').Pool,
 *   getProvider: () => any | any,
 *   userId: string,
 *   clientId: string,
 *   events?: Record<string, any>,
 * }} params
 * @returns {Promise<{ dispatched: boolean, status?: number, error?: string }>}
 */
export async function dispatchBackchannelLogout({
  config,
  pool,
  getProvider,
  userId,
  clientId,
  events,
}) {
  try {
    const provider = typeof getProvider === 'function' ? await getProvider() : getProvider;
    if (!provider?.Client) {
      return { dispatched: false, error: 'no_provider' };
    }
    const client = await provider.Client.find(clientId);
    if (!client) {
      return { dispatched: false, error: 'client_not_found' };
    }

    const logoutUri = client.backchannel_logout_uri || client.backchannelLogoutUri;
    if (!logoutUri) {
      return { dispatched: false, error: 'no_backchannel_logout_uri' };
    }

    const activeKey = await getActiveKey(pool, config.keyEncryptionSecret);
    const logoutToken = createLogoutToken({ config, activeKey, userId, clientId, events });

    const body = new URLSearchParams();
    body.set('logout_token', logoutToken);

    const response = await fetch(logoutUri, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      logger.warn(
        { clientId, uri: logoutUri, status: response.status },
        'backchannel logout response not ok',
      );
      if (pool) {
        await audit(pool, {
          actorUserId: userId,
          action: 'backchannel_logout.failed',
          targetType: 'client',
          targetId: clientId,
          details: { status: response.status, uri: logoutUri },
        }).catch(() => undefined);
      }
      return { dispatched: false, status: response.status, error: `status_${response.status}` };
    }

    logger.info({ clientId, uri: logoutUri }, 'backchannel logout delivered');
    if (pool) {
      await audit(pool, {
        actorUserId: userId,
        action: 'backchannel_logout.dispatched',
        targetType: 'client',
        targetId: clientId,
        details: { uri: logoutUri },
      }).catch(() => undefined);
    }
    return { dispatched: true, status: response.status };
  } catch (err) {
    logger.warn({ err: errorFields(err), clientId }, 'backchannel logout dispatch failed');
    if (pool) {
      await audit(pool, {
        actorUserId: userId,
        action: 'backchannel_logout.failed',
        targetType: 'client',
        targetId: clientId,
        details: { error: /** @type {any} */ (err)?.name || 'Error' },
      }).catch(() => undefined);
    }
    return { dispatched: false, error: /** @type {any} */ (err)?.name || 'Error' };
  }
}

/**
 * Dispatch backchannel logout and MCP revocation to ALL clients where the user has active grants,
 * sessions, or tokens, then revoke all sessions and admin tokens.
 * @param {{
 *   config: import('../config.js').Config,
 *   pool: import('pg').Pool,
 *   getProvider?: () => any | any,
 *   userId: string,
 *   events?: Record<string, any>,
 *   reason?: string,
 * }} params
 * @returns {Promise<{ clientIds: string[], count: number }>}
 */
export async function dispatchAllBackchannelLogouts({
  config,
  pool,
  getProvider,
  userId,
  events,
  reason = 'account_disabled',
}) {
  const { rows } = await pool.query(
    `SELECT DISTINCT payload->>'clientId' AS client_id
       FROM oidc_payloads
      WHERE payload->>'accountId' = $1 AND (expires_at IS NULL OR expires_at > now())`,
    [userId],
  );

  const clientIds = rows.map((r) => r.client_id).filter(Boolean);

  if (getProvider) {
    for (const clientId of clientIds) {
      try {
        await dispatchBackchannelLogout({
          config,
          pool,
          getProvider,
          userId,
          clientId,
          events: events || {
            'http://schemas.openid.net/event/backchannel-logout': {},
            'https://tunnus.fi/event/mcp-revoke': { reason },
          },
        });
      } catch (err) {
        logger.warn(
          { err: errorFields(err), clientId, userId },
          'failed to dispatch backchannel logout in broadcast',
        );
      }
    }
  }

  const revokedCount = await revokeUserSessions(pool, userId);
  await pool.query(
    'UPDATE admin_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );

  return { clientIds, count: revokedCount };
}
