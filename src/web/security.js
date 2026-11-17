/**
 * Security headers for every response: strict CSP without inline scripts,
 * HSTS (when the issuer is https), no framing, no sniffing.
 * @param {{ issuer: string }} config
 * @returns {import('express').RequestHandler}
 */
export function securityHeaders(config) {
  const https = config.issuer.startsWith('https:');
  return (_req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      ...(https ? { 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains' } : {}),
    });
    next();
  };
}
