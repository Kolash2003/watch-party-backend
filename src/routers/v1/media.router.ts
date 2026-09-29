import express from 'express';
import path from 'path';
import { prisma } from '../../lib/db';
import { redis } from '../../lib/redis';
import { requireAuth } from '../../lib/auth';
import { videosDir } from '../../lib/storage';
import { allowedKey } from './rooms.router';
import { ForbiddenError } from '../../utils/errors/app.error';

const mediaRouter = express.Router();
mediaRouter.use(requireAuth);

// Owner, or member of an open room that plays this video.
async function canWatch(userId: string, videoId: string) {
    if (await prisma.video.findFirst({ where: { id: videoId, ownerId: userId }, select: { id: true } })) return true;
    const rooms = await prisma.room.findMany({ where: { videoId, closedAt: null }, select: { code: true } });
    for (const r of rooms) if (await redis.sismember(allowedKey(r.code), userId)) return true;
    return false;
}

mediaRouter.get('/:videoId/*path', async (req, res, next) => {
    const params = req.params as unknown as { videoId: string; path: string[] };
    if (!(await canWatch(req.userId, params.videoId))) throw new ForbiddenError('No access to this video');
    const rel = params.path.join('/');
    const isSegment = rel.endsWith('.ts');
    res.sendFile(path.join(videosDir(), params.videoId, rel), {
        dotfiles: 'deny',
        headers: {
            'Content-Type': ({ '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.vtt': 'text/vtt', '.jpg': 'image/jpeg' } as Record<string, string>)[path.extname(rel)] ?? 'application/octet-stream',
            // auth-checked, so cache only in the browser
            'Cache-Control': isSegment ? 'private, max-age=31536000, immutable' : 'private, no-cache',
        },
    }, (err) => err && next(Object.assign(err, { statusCode: 404, name: 'NotFoundError' })));
});

export default mediaRouter;
