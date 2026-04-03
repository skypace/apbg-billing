// Stateless signed tokens for approval URLs
// No database needed — bill data is encoded in the URL itself
import crypto from 'crypto';

const SECRET = process.env.TOKEN_SECRET || process.env.QBO_CLIENT_SECRET || 'pacer-billing-default';

export function createToken(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyToken(token) {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) throw new Error('Invalid token format');

  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  if (sig !== expected) throw new Error('Invalid token signature');

  return JSON.parse(Buffer.from(payload, 'base64url').toString());
}
