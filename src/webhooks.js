import crypto from 'node:crypto';
import { logger } from './logger.js';

/**
 * Format Slack Block Kit messages.
 * @param {any} payload
 */
export function formatSlackPayload(payload) {
  const { event, parishSlug, asset, context } = payload;
  const eventIcons = {
    'asset.created': '✨ Uusi media lisätty',
    'asset.updated': '✏️ Media päivitetty',
    'asset.deleted': '🗑️ Media poistettu',
    'asset.used': '🚀 Media otettu käyttöön',
  };

  const eventLabel = eventIcons[event] || `📢 Tapahtuma: ${event}`;
  const channelText = context?.channel ? ` [Kanava: ${context.channel}]` : '';
  const canvaText = context?.canvaDesignTitle ? ` (Canva: "${context.canvaDesignTitle}")` : '';
  const title = asset?.title || 'Tuntematon kohde';
  const parish = parishSlug || payload.tenant || 'Yleinen';

  return {
    text: `${eventLabel} seurakunnassa ${parish}: *${title}*${channelText}${canvaText}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `Valopankki: ${eventLabel}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Seurakunta:*\n${parish}` },
          { type: 'mrkdwn', text: `*Media:*\n${title} (${(asset?.format || 'media').toUpperCase()})` },
          { type: 'mrkdwn', text: `*Tyyppi:*\n${asset?.kind || 'asset'}` },
          { type: 'mrkdwn', text: `*Kanava:*\n${context?.channel || 'Verkko'}${canvaText}` },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Aikaleima: ${payload.timestamp || new Date().toISOString()} • ID: \`${asset?.id || '-'}\``,
          },
        ],
      },
    ],
  };
}

/**
 * Format Discord Embed cards.
 * @param {any} payload
 */
export function formatDiscordPayload(payload) {
  const { event, parishSlug, asset, context } = payload;
  const colors = {
    'asset.created': 0x22c55e,
    'asset.updated': 0x3b82f6,
    'asset.deleted': 0xef4444,
    'asset.used': 0xf4b41a,
  };

  const titles = {
    'asset.created': '✨ Uusi media ladattu Valopankkiin',
    'asset.updated': '✏️ Mediaa muokattu',
    'asset.deleted': '🗑️ Media poistettu',
    'asset.used': '🚀 Media otettu käyttöön',
  };

  const parish = parishSlug || payload.tenant || 'Yleinen';
  const title = titles[event] || `Ilmoitus: ${event}`;

  return {
    embeds: [
      {
        title,
        color: colors[event] || 0x0d2c54,
        fields: [
          { name: 'Seurakunta', value: parish, inline: true },
          { name: 'Otsikko', value: asset?.title || '-', inline: true },
          { name: 'Formaatti', value: (asset?.format || 'MEDIA').toUpperCase(), inline: true },
          {
            name: 'Käyttökanava',
            value: context?.channel
              ? `${context.channel}${context.canvaDesignTitle ? ` ("${context.canvaDesignTitle}")` : ''}`
              : 'Verkko / CMS',
            inline: false,
          },
        ],
        footer: { text: `Valopankki • ${payload.timestamp || new Date().toISOString()}` },
      },
    ],
  };
}

/**
 * Dispatch an event to matching active hooks.
 * @param {import('pg').Pool} pool
 * @param {string} tenant
 * @param {string} event
 * @param {any} payload
 * @param {typeof fetch} [fetchImpl]
 */
export async function dispatchWebhookEvent(pool, tenant, event, payload, fetchImpl = fetch) {
  const { rows: hooks } = await pool.query(
    `SELECT id, name, url, events, secret
     FROM notification_hooks
     WHERE active = true AND (tenant = $1 OR tenant = '')`,
    [tenant]
  );

  const matching = hooks.filter(
    (h) => !h.events || h.events.length === 0 || h.events.includes(event) || h.events.includes('*')
  );

  if (matching.length === 0) {
    return [];
  }

  const results = [];

  for (const hook of matching) {
    let success = false;
    let statusCode = null;
    let errorMessage = null;

    try {
      let bodyToSend;
      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'Tunnus-Webhook-Dispatcher/1.0',
        'X-Event-Type': event,
        'X-Tenant': tenant,
      };

      if (hook.url.includes('hooks.slack.com')) {
        bodyToSend = JSON.stringify(formatSlackPayload(payload));
      } else if (hook.url.includes('discord.com/api/webhooks')) {
        bodyToSend = JSON.stringify(formatDiscordPayload(payload));
      } else {
        bodyToSend = JSON.stringify(payload);
      }

      if (hook.secret) {
        const hmac = crypto.createHmac('sha256', hook.secret).update(bodyToSend).digest('hex');
        headers['X-Hub-Signature-256'] = `sha256=${hmac}`;
        headers['X-Valopankki-Signature'] = `sha256=${hmac}`;
      }

      const res = await fetchImpl(hook.url, {
        method: 'POST',
        headers,
        body: bodyToSend,
        signal: AbortSignal.timeout(8000),
      });

      statusCode = res.status;
      success = res.ok;
      if (!res.ok) {
        errorMessage = `HTTP error ${res.status}: ${res.statusText}`;
      }
    } catch (err) {
      success = false;
      errorMessage = err instanceof Error ? err.message : 'Network error or timeout';
    }

    // Record delivery log
    try {
      await pool.query(
        `INSERT INTO notification_deliveries (hook_id, tenant, event, payload, status_code, success, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [hook.id, tenant, event, JSON.stringify(payload), statusCode, success, errorMessage]
      );
    } catch (logErr) {
      logger.error({ logErr }, 'failed to record webhook delivery');
    }

    results.push({
      hookId: hook.id,
      name: hook.name,
      url: hook.url,
      statusCode,
      success,
      error: errorMessage,
    });
  }

  return results;
}
