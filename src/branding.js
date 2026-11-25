import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Common logo and icon file extensions and their MIME types.
 * @type {Record<string, string>}
 */
const MIME_TYPES = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

/**
 * Determine MIME type from file extension.
 * @param {string} filePath
 * @returns {string}
 */
export function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Look for a local logo file in prioritized locations.
 * @param {string} [customPath] Explicit path from environment (e.g. BRAND_LOGO_FILE)
 * @param {{ existsSync?: (p: string) => boolean }} [io]
 * @returns {string | null}
 */
export function findLocalLogoFile(customPath, io = {}) {
  const exists = io.existsSync ?? existsSync;
  if (customPath && exists(customPath)) {
    return customPath;
  }
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, 'logo.png'),
    path.resolve(cwd, 'logo.svg'),
    path.resolve(cwd, 'logo.jpg'),
    path.resolve(cwd, 'logo.jpeg'),
    path.resolve(cwd, 'logo.webp'),
    '/app/logo.png',
    '/app/logo.svg',
  ];
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return null;
}

/**
 * Look for a local favicon file in prioritized locations.
 * @param {string} [customPath] Explicit path from environment (e.g. BRAND_FAVICON_FILE)
 * @param {{ existsSync?: (p: string) => boolean }} [io]
 * @returns {string | null}
 */
export function findLocalFaviconFile(customPath, io = {}) {
  const exists = io.existsSync ?? existsSync;
  if (customPath && exists(customPath)) {
    return customPath;
  }
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, 'favicon.ico'),
    path.resolve(cwd, 'favicon.png'),
    path.resolve(cwd, 'favicon.svg'),
    '/app/favicon.ico',
    '/app/favicon.png',
  ];
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return null;
}
