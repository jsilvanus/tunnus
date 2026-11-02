/**
 * oidc-provider storage adapter backed by the `oidc_payloads` table.
 * @param {import('pg').Pool} pool
 */
export function createAdapterClass(pool) {
  return class PgAdapter {
    /** @param {string} name */
    constructor(name) {
      this.name = name;
    }

    /**
     * @param {string} id
     * @param {Record<string, any>} payload
     * @param {number} expiresIn seconds
     */
    async upsert(id, payload, expiresIn) {
      const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
      await pool.query(
        `INSERT INTO oidc_payloads (type, id, payload, grant_id, uid, user_code, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (type, id) DO UPDATE SET payload = EXCLUDED.payload,
           grant_id = EXCLUDED.grant_id, uid = EXCLUDED.uid,
           user_code = EXCLUDED.user_code, expires_at = EXCLUDED.expires_at`,
        [
          this.name,
          id,
          payload,
          payload.grantId ?? null,
          payload.uid ?? null,
          payload.userCode ?? null,
          expiresAt,
        ],
      );
    }

    /** @param {import('pg').QueryResult} res */
    static row(res) {
      const r = res.rows[0];
      if (!r) return undefined;
      return {
        ...r.payload,
        ...(r.consumed_at ? { consumed: Math.floor(r.consumed_at.getTime() / 1000) } : {}),
      };
    }

    /** @param {string} id */
    async find(id) {
      return PgAdapter.row(
        await pool.query(
          'SELECT payload, consumed_at FROM oidc_payloads WHERE type = $1 AND id = $2 AND (expires_at IS NULL OR expires_at > now())',
          [this.name, id],
        ),
      );
    }

    /** @param {string} uid */
    async findByUid(uid) {
      return PgAdapter.row(
        await pool.query(
          'SELECT payload, consumed_at FROM oidc_payloads WHERE type = $1 AND uid = $2 AND (expires_at IS NULL OR expires_at > now())',
          [this.name, uid],
        ),
      );
    }

    /** @param {string} userCode */
    async findByUserCode(userCode) {
      return PgAdapter.row(
        await pool.query(
          'SELECT payload, consumed_at FROM oidc_payloads WHERE type = $1 AND user_code = $2 AND (expires_at IS NULL OR expires_at > now())',
          [this.name, userCode],
        ),
      );
    }

    /** @param {string} id */
    async destroy(id) {
      await pool.query('DELETE FROM oidc_payloads WHERE type = $1 AND id = $2', [this.name, id]);
    }

    /** @param {string} id */
    async consume(id) {
      await pool.query('UPDATE oidc_payloads SET consumed_at = now() WHERE type = $1 AND id = $2', [
        this.name,
        id,
      ]);
    }

    /** @param {string} grantId */
    async revokeByGrantId(grantId) {
      await pool.query('DELETE FROM oidc_payloads WHERE grant_id = $1', [grantId]);
    }
  };
}
