import { handlers as meHandlers } from './me.js';
import { handlers as usersHandlers } from './users.js';
import { handlers as groupsHandlers } from './groups.js';
import { handlers as keysHandlers } from './keys.js';
import { handlers as auditHandlers } from './audit.js';
import { handlers as clientsHandlers } from './clients.js';

/**
 * Every operationId in openapi.yaml maps to one handler here. The router checks both directions at startup.
 * @type {Record<string, (ctx: import('../types.js').HandlerContext) => Promise<import('../types.js').HandlerResult>>}
 */
export const handlers = {
  ...meHandlers,
  ...usersHandlers,
  ...groupsHandlers,
  ...keysHandlers,
  ...auditHandlers,
  ...clientsHandlers,
};
