import express from 'express';
import { prisma } from '../../lib/db';
import { requireAuth } from '../../lib/auth';
import { storage } from '../../lib/storage';
import { NotFoundError } from '../../utils/errors/app.error';

const videosRouter = express.Router();
videosRouter.use(requireAuth);

// BigInt isn't JSON-serialisable
const out = (v: { sizeBytes: bigint | null }) => ({ ...v, sizeBytes: v.sizeBytes === null ? null : Number(v.sizeBytes) });

videosRouter.get('/', async (req, res) => {
    const videos = await prisma.video.findMany({ where: { ownerId: req.userId }, orderBy: { createdAt: 'desc' } });
    res.json(videos.map(out));
});

videosRouter.get('/:id', async (req, res) => {
    const v = await prisma.video.findFirst({ where: { id: req.params.id, ownerId: req.userId } });
    if (!v) throw new NotFoundError('Video not found');
    res.json(out(v));
});

videosRouter.delete('/:id', async (req, res) => {
    const v = await prisma.video.findFirst({ where: { id: req.params.id, ownerId: req.userId } });
    if (!v) throw new NotFoundError('Video not found');
    await prisma.$transaction([
        prisma.chatMessage.deleteMany({ where: { room: { videoId: v.id } } }),
        prisma.room.deleteMany({ where: { videoId: v.id } }),
        prisma.video.delete({ where: { id: v.id } }),
    ]);
    await storage.delete(v.id);
    res.status(204).end();
});

export default videosRouter;
