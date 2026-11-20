import { describe, expect, it } from 'vitest';
import { encodeQrMatrix, qrDataUrl } from '../src/qr.js';

describe('QR code generator', () => {
  it('encodes an otpauth URI with valid finder and timing patterns', () => {
    const uri =
      'otpauth://totp/Example:ada%40example.org?secret=JBSWY3DPEHPK3PXP&issuer=Example&algorithm=SHA1&digits=6&period=30';
    const mat = encodeQrMatrix(uri);
    const n = mat.length;
    expect(n).toBeGreaterThanOrEqual(21);
    expect(mat.every((row) => row.length === n)).toBe(true);

    // Top-left 7x7 finder corners and center
    expect(mat[0][0]).toBe(true);
    expect(mat[0][6]).toBe(true);
    expect(mat[6][0]).toBe(true);
    expect(mat[3][3]).toBe(true);
    expect(mat[1][1]).toBe(false);

    // Timing pattern at row 6, cols 8..n-9
    for (let c = 8; c < n - 8; c++) {
      expect(mat[6][c]).toBe(c % 2 === 0);
    }
  });

  it('renders a valid base64 SVG data URL', () => {
    const url = qrDataUrl('otpauth://totp/Tunnus:ada@example.org?secret=JBSWY3DPEHPK3PXP');
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const svg = Buffer.from(url.slice('data:image/svg+xml;base64,'.length), 'base64').toString(
      'utf8',
    );
    expect(svg).toContain('<svg ');
    expect(svg).toContain('<rect ');
  });
});
