/**
 * Tunnus Notification Client Helpers
 *
 * Provides unified client functions for interacting with Tunnus notification
 * relay endpoints (Web Push, Webhooks, Email, and SMS).
 */

/**
 * Send an event to Tunnus webhook bus.
 * @param {object} params
 * @param {string} [params.tunnusUrl='https://tunnus.riihimaenseurakunta.fi']
 * @param {string} params.token Bearer relay token
 * @param {string} params.event Event name (e.g. 'asset.created', 'shift.assigned')
 * @param {string} [params.tenant=''] Tenant or parish slug
 * @param {Record<string, unknown>} [params.data] Additional event data
 * @param {typeof fetch} [params.fetchImpl=fetch]
 */
export async function emitNotificationEvent({
  tunnusUrl = 'https://tunnus.riihimaenseurakunta.fi',
  token,
  event,
  tenant = '',
  data = {},
  fetchImpl = fetch,
}) {
  const res = await fetchImpl(`${tunnusUrl}/api/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      event,
      tenant,
      timestamp: new Date().toISOString(),
      ...data,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to emit notification event: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

/**
 * Send a Web Push notification to a user or endpoint.
 * @param {object} params
 * @param {string} [params.tunnusUrl='https://tunnus.riihimaenseurakunta.fi']
 * @param {string} params.token Bearer relay token
 * @param {string} [params.userId] Target user UUID in Tunnus
 * @param {string} [params.endpoint] Direct browser push subscription endpoint
 * @param {object} params.notification
 * @param {string} params.notification.title
 * @param {string} [params.notification.body]
 * @param {string} [params.notification.icon]
 * @param {Record<string, unknown>} [params.notification.data]
 * @param {typeof fetch} [params.fetchImpl=fetch]
 */
export async function sendWebPushNotification({
  tunnusUrl = 'https://tunnus.riihimaenseurakunta.fi',
  token,
  userId,
  endpoint,
  notification,
  fetchImpl = fetch,
}) {
  const res = await fetchImpl(`${tunnusUrl}/api/push/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      userId,
      endpoint,
      notification,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to send web push: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

/**
 * Send an email via Tunnus mail relay.
 * @param {object} params
 * @param {string} [params.tunnusUrl='https://tunnus.riihimaenseurakunta.fi']
 * @param {string} params.token Bearer relay token
 * @param {string|string[]} params.to Recipient email(s)
 * @param {string} params.subject Subject line
 * @param {string} params.text Plaintext message
 * @param {string} [params.html] HTML message
 * @param {number} [params.templateId] Brevo template ID
 * @param {Record<string, unknown>} [params.params] Template parameters
 * @param {typeof fetch} [params.fetchImpl=fetch]
 */
export async function sendRelayEmail({
  tunnusUrl = 'https://tunnus.riihimaenseurakunta.fi',
  token,
  to,
  subject,
  text,
  html,
  templateId,
  params,
  fetchImpl = fetch,
}) {
  const res = await fetchImpl(`${tunnusUrl}/api/mail`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      to: Array.isArray(to) ? to : [to],
      subject,
      text,
      html,
      templateId,
      params,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to send relay email: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}
