import { sendNotification, setVapidDetails } from 'web-push';
import { logger } from './logger.js';

/**
 * @typedef {{
 *   vapidPublicKey: string,
 *   vapidPrivateKey: string,
 *   vapidSubject?: string,
 * }} PushConfig
 *
 * @typedef {{
 *   id?: string,
 *   endpoint: string,
 *   p256dh: string,
 *   auth: string,
 * }} PushSubscriptionRecord
 *
 * @typedef {{
 *   title: string,
 *   body?: string,
 *   icon?: string,
 *   badge?: string,
 *   tag?: string,
 *   data?: Record<string, unknown>,
 * }} PushPayload
 */

/**
 * Configure global VAPID details for web-push.
 * @param {PushConfig} config
 */
export function configureWebPush(config) {
  if (config.vapidPublicKey && config.vapidPrivateKey) {
    const subject = config.vapidSubject || 'mailto:it@riihimaenseurakunta.fi';
    setVapidDetails(subject, config.vapidPublicKey, config.vapidPrivateKey);
  }
}

/**
 * Save or update a Web Push subscription for a user.
 * @param {import('pg').Pool} pool
 * @param {{
 *   userId?: string | null,
 *   endpoint: string,
 *   p256dh: string,
 *   auth: string,
 *   userAgent?: string,
 * }} params
 * @returns {Promise<PushSubscriptionRecord>}
 */
export async function savePushSubscription(pool, { userId, endpoint, p256dh, auth, userAgent = '' }) {
  const query = `
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, last_used_at)
    VALUES ($1, $2, $3, $4, $5, now())
    ON CONFLICT (endpoint) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      p256dh = EXCLUDED.p256dh,
      auth = EXCLUDED.auth,
      user_agent = EXCLUDED.user_agent,
      last_used_at = now()
    RETURNING id, endpoint, p256dh, auth
  `;
  const { rows } = await pool.query(query, [userId || null, endpoint, p256dh, auth, userAgent]);
  return rows[0];
}

/**
 * Remove a subscription by endpoint.
 * @param {import('pg').Pool} pool
 * @param {string} endpoint
 */
export async function deletePushSubscription(pool, endpoint) {
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

/**
 * Fetch all subscriptions for a specific user.
 * @param {import('pg').Pool} pool
 * @param {string} userId
 * @returns {Promise<PushSubscriptionRecord[]>}
 */
export async function getSubscriptionsForUser(pool, userId) {
  const { rows } = await pool.query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId]
  );
  return rows;
}

/**
 * Send a push notification to a specific subscription.
 * Handles 404 / 410 Gone by removing expired subscriptions from PostgreSQL automatically.
 * @param {import('pg').Pool} pool
 * @param {PushSubscriptionRecord} sub
 * @param {PushPayload} payload
 * @param {typeof sendNotification} [sendImpl]
 * @returns {Promise<{ ok: boolean, expired?: boolean }>}
 */
export async function sendPushNotification(
  pool,
  sub,
  payload,
  sendImpl = sendNotification
) {
  const pushSubscription = {
    endpoint: sub.endpoint,
    keys: {
      p256dh: sub.p256dh,
      auth: sub.auth,
    },
  };

  try {
    await sendImpl(pushSubscription, JSON.stringify(payload));
    await pool.query('UPDATE push_subscriptions SET last_used_at = now() WHERE endpoint = $1', [
      sub.endpoint,
    ]);
    return { ok: true };
  } catch (err) {
    const statusCode = /** @type {any} */ (err)?.statusCode;
    if (statusCode === 404 || statusCode === 410) {
      logger.info({ endpoint: sub.endpoint, statusCode }, 'push subscription expired or gone, pruning');
      await deletePushSubscription(pool, sub.endpoint);
      return { ok: false, expired: true };
    }
    logger.error({ endpoint: sub.endpoint, err }, 'push notification delivery failed');
    throw err;
  }
}
