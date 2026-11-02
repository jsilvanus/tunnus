/**
 * @typedef {{ sendCode(to: string, code: string, link: string | null): Promise<void> }} Mailer
 */

/**
 * Development sender that logs the code instead of sending mail.
 * @param {{ info: (o: object, m: string) => void }} logger
 * @returns {Mailer}
 */
export function createConsoleMailer(logger) {
  return {
    async sendCode(to, code) {
      logger.info({ to, code }, 'sign-in code (console mail provider)');
    },
  };
}
