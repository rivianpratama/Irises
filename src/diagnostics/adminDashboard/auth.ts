import { Request } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'crypto';

// Auth: DASHBOARD_PASSWORD (default "adminofirises"). A correct login sets a
// stateless HMAC cookie derived from the password, so sessions survive restarts
// and rotating the password invalidates every session at once.

const PASSWORD = process.env.DASHBOARD_PASSWORD || 'adminofirises';
const SECRET = createHash('sha256').update(`irises-dashboard-v1:${PASSWORD}`).digest();
const SESSION_TOKEN = createHmac('sha256', SECRET).update('admin-session').digest('hex');
const COOKIE = 'irises_dash';
const COOKIE_MAX_AGE_S = 30 * 24 * 3600;

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function checkPassword(password: string): boolean {
  return safeEqual(password, PASSWORD);
}

function cookieValue(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE) return rest.join('=');
  }
  return null;
}

export function authed(req: Request): boolean {
  const v = cookieValue(req);
  return !!v && safeEqual(v, SESSION_TOKEN);
}

/** Set-Cookie value for login (or logout with clear=true). The 30-day session token is a
 *  credential — mark it Secure whenever the request came in over HTTPS (direct or via
 *  proxy header), while keeping plain-http localhost dev working. */
export function sessionCookie(req: Request, clear = false): string {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return clear
    ? `${COOKIE}=; Path=/dashboard; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
    : `${COOKIE}=${SESSION_TOKEN}; Path=/dashboard; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}${secure}`;
}

// Light brute-force damper: max 20 login attempts per IP per minute.
const attempts = new Map<string, { count: number; windowStart: number }>();
export function rateLimited(ip: string): boolean {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || now - a.windowStart > 60_000) { attempts.set(ip, { count: 1, windowStart: now }); return false; }
  a.count++;
  return a.count > 20;
}
