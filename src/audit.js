/**
 * Append an audit event. `details` must never contain email addresses or codes.
 * @param {import('pg').Pool} pool
 * @param {{ actorUserId?: string | null, action: string, targetType?: string, targetId?: string, ip?: string | null, details?: Record<string, unknown> }} event
 */
export async function audit(pool, event) {
  await pool.query(
    'INSERT INTO audit_events (actor_user_id, action, target_type, target_id, ip, details) VALUES ($1, $2, $3, $4, $5, $6)',
    [
      event.actorUserId ?? null,
      event.action,
      event.targetType ?? null,
      event.targetId ?? null,
      event.ip ?? null,
      event.details ?? {},
    ],
  );
}
