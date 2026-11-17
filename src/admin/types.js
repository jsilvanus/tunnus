/**
 * Shared types for admin handlers.
 *
 * @typedef {{
 *   req: import('express').Request,
 *   pool: import('pg').Pool,
 *   config: import('../config.js').Config,
 *   clients: Record<string, any>[],
 *   actor: { userId: string, tokenId: string },
 *   ip: string | null,
 *   params: Record<string, any>,
 *   query: Record<string, any>,
 *   body: any,
 *   reloadKeys: () => Promise<void>,
 * }} HandlerContext
 */

/**
 * @typedef {{
 *   status?: number,
 *   body?: unknown,
 *   audit?: { targetType?: string, targetId?: string, details?: Record<string, unknown> },
 * }} HandlerResult
 */

/**
 * The request after auth middleware has run.
 * @typedef {import('express').Request & {
 *   admin: {
 *     userId: string,
 *     tokenId: string,
 *     token: Record<string, any>,
 *     user: { id: string, email: string, display_name: string, status: string, is_admin: boolean },
 *   },
 * }} AdminRequest
 */

export {};
