import express from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../../lib/db';
import { COOKIE, hashPassword, requireAuth, signToken, verifyPassword } from '../../lib/auth';
import { validateRequestBody } from '../../validators';
import { loginSchema, signupSchema } from '../../validators/schemas';
import { ConflictError, UnauthorizedError } from '../../utils/errors/app.error';

const authRouter = express.Router();
authRouter.use(rateLimit({ windowMs: 60_000, limit: 20 }));

const cookieOpts = { httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', maxAge: 30 * 864e5 };
const publicUser = (u: { id: string; email: string; name: string }) => ({ id: u.id, email: u.email, name: u.name });

authRouter.post('/signup', validateRequestBody(signupSchema), async (req, res) => {
    const { email, name, password } = req.body;
    if (await prisma.user.findUnique({ where: { email } })) throw new ConflictError('Email already registered');
    const user = await prisma.user.create({ data: { email, name, passwordHash: hashPassword(password) } });
    res.cookie(COOKIE, signToken(user.id), cookieOpts).status(201).json(publicUser(user));
});

authRouter.post('/login', validateRequestBody(loginSchema), async (req, res) => {
    const user = await prisma.user.findUnique({ where: { email: req.body.email } });
    if (!user || !verifyPassword(req.body.password, user.passwordHash)) throw new UnauthorizedError('Invalid email or password');
    res.cookie(COOKIE, signToken(user.id), cookieOpts).json(publicUser(user));
});

authRouter.post('/logout', (_req, res) => {
    res.clearCookie(COOKIE, cookieOpts).status(204).end();
});

export const meHandler = [requireAuth, async (req: express.Request, res: express.Response) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    res.json(publicUser(user));
}];

export default authRouter;
