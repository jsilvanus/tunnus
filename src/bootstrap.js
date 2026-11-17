import { audit } from './audit.js';
import { createAdminToken } from './adminTokens.js';
import { createUser } from './accounts.js';
import { isValidEmail } from './emailAddress.js';

/** A problem with the bootstrap inputs (a usage error, not a system failure). */
export class BootstrapInputError extends Error {}

/**
 * @typedef {{
 *   email: string,
 *   name?: string,
 *   label?: string,
 *   expiresDays?: number,
 *   defaultGroups?: string[],
 * }} BootstrapInput
 */

/**
 * Check bootstrap inputs and return them normalised.
 * @param {BootstrapInput} input
 * @returns {{ email: string, name: string | undefined, label: string, expiresDays: number, defaultGroups: string[] }}
 * @throws {BootstrapInputError}
 */
export function validateBootstrapInput(input) {
  const email = String(input.email ?? '')
    .trim()
    .toLowerCase();
  if (!isValidEmail(email)) {
    throw new BootstrapInputError('--email must be a valid email address');
  }
  const name = input.name?.trim();
  if (name !== undefined && (name.length === 0 || name.length > 200)) {
    throw new BootstrapInputError('--name must be 1 to 200 characters');
  }
  const label = input.label ?? 'bootstrap';
  if (label.trim().length === 0 || label.length > 100) {
    throw new BootstrapInputError('--label must be 1 to 100 characters');
  }
  const expiresDays = input.expiresDays ?? 90;
  if (!Number.isInteger(expiresDays) || expiresDays < 1 || expiresDays > 365) {
    throw new BootstrapInputError('--expires-days must be an integer from 1 to 365');
  }
  return { email, name, label, expiresDays, defaultGroups: input.defaultGroups ?? [] };
}

/**
 * Create the first admin, or promote an existing user (re-activating a disabled one), and issue a token.
 * Allowed even when admins exist: it is the recovery path. Audited with no actor.
 * @param {import('pg').Pool} pool
 * @param {BootstrapInput} input
 * @returns {Promise<{ userId: string, created: boolean, tokenId: string, token: string, expiresAt: Date }>}
 */
export async function bootstrapAdmin(pool, input) {
  const { email, name, label, expiresDays, defaultGroups } = validateBootstrapInput(input);
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  let userId;
  let created;
  if (rows[0]) {
    userId = /** @type {string} */ (rows[0].id);
    created = false;
    await pool.query("UPDATE users SET is_admin = true, status = 'active' WHERE id = $1", [userId]);
  } else {
    userId = await createUser(pool, email, defaultGroups, name);
    await pool.query('UPDATE users SET is_admin = true WHERE id = $1', [userId]);
    created = true;
  }
  const issued = await createAdminToken(pool, {
    userId,
    label,
    expiresInDays: expiresDays,
    createdBy: null,
  });
  await audit(pool, {
    actorUserId: null,
    action: 'admin.bootstrap',
    targetType: 'user',
    targetId: userId,
    details: { created, token_id: issued.row.id },
  });
  return {
    userId,
    created,
    tokenId: issued.row.id,
    token: issued.token,
    expiresAt: issued.row.expires_at,
  };
}
