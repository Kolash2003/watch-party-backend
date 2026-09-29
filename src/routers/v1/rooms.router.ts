import crypto from 'crypto';
import express from 'express';
import { prisma } from '../../lib/db';
import { redis } from '../../lib/redis';
import { requireAuth } from '../../lib/auth';
import { initRoomState } from '../../lib/rooms';
import { validateRequestBody } from '../../validators';
import { createRoomSchema } from '../../validators/schemas';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../utils/errors/app.error';
import { closeRoom } from '../../socket';

const roomsRouter = express.Router();
roomsRouter.use(requireAuth);

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes
const newCode = () => Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');

export const allowedKey = (code: string) => `room:${code}:allowed`;

async function openRoom(code: string) {
    const room = await prisma.room.findUnique({ where: { code }, include: { video: true, host: true } });
    if (!room || room.closedAt) throw new NotFoundError('Room not found');
    return room;
}

const info = async (room: Awaited<ReturnType<typeof openRoom>>) => ({
    code: room.code,
    controlMode: room.controlMode,
    host: { id: room.host.id, name: room.host.name },
    video: { id: room.video.id, title: room.video.title, status: room.video.status, renditions: room.video.renditions, hasSubtitles: room.video.hasSubtitles },
    memberCount: await redis.hlen(`room:${room.code}:members`),
});

roomsRouter.post('/', validateRequestBody(createRoomSchema), async (req, res) => {
    const video = await prisma.video.findFirst({ where: { id: req.body.videoId, ownerId: req.userId } });
    if (!video) throw new NotFoundError('Video not found');
    if (video.status !== 'READY') throw new BadRequestError('Video is not ready yet');
    const code = newCode();
    await prisma.room.create({ data: { code, hostId: req.userId, videoId: video.id, controlMode: req.body.controlMode } });
    await initRoomState(code, req.userId, video.id, req.body.controlMode);
    await redis.sadd(allowedKey(code), req.userId);
    res.status(201).json({ code });
});

roomsRouter.get('/mine', async (req, res) => {
    const rooms = await prisma.room.findMany({ where: { hostId: req.userId, closedAt: null }, include: { video: true }, orderBy: { createdAt: 'desc' } });
    res.json(rooms.map((r) => ({ code: r.code, videoTitle: r.video.title, createdAt: r.createdAt })));
});

roomsRouter.get('/:code', async (req, res) => {
    res.json(await info(await openRoom(req.params.code)));
});

roomsRouter.post('/:code/join', async (req, res) => {
    const room = await openRoom(req.params.code);
    await redis.multi().sadd(allowedKey(room.code), req.userId).expire(allowedKey(room.code), 24 * 3600).exec();
    res.json(await info(room));
});

roomsRouter.delete('/:code', async (req, res) => {
    const room = await openRoom(req.params.code);
    if (room.hostId !== req.userId) throw new ForbiddenError('Only the host can close the room');
    await prisma.room.update({ where: { id: room.id }, data: { closedAt: new Date() } });
    closeRoom(room.code);
    res.status(204).end();
});

export default roomsRouter;
