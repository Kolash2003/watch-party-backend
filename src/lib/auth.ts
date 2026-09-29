import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { NextFunction, Request, Response } from 'express';
import { serverConfig } from '../config';
import { UnauthorizedError } from '../utils/errors/app.error';

export const COOKIE = 'wp_session';

export function hashPassword(pw: string) {
    const salt = crypto.randomBytes(16).toString('hex');
    return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string) {
    const [salt, hash] = stored.split(':');
    const a = Buffer.from(hash, 'hex');
    const b = crypto.scryptSync(pw, salt, 64);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const signToken = (userId: string) => jwt.sign({ sub: userId }, serverConfig.SESSION_SECRET, { expiresIn: '30d' });

export function userIdFromCookieHeader(header?: string | null): string | null {
    const raw = header?.split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE + '='));
    if (!raw) return null;
    try {
        return (jwt.verify(decodeURIComponent(raw.slice(COOKIE.length + 1)), serverConfig.SESSION_SECRET) as jwt.JwtPayload).sub ?? null;
    } catch {
        return null;
    }
}

declare global {
    namespace Express {
        interface Request { userId: string }
    }
}

export const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    const id = userIdFromCookieHeader(req.headers.cookie);
    if (!id) throw new UnauthorizedError('Not signed in');
    req.userId = id;
    next();
};
