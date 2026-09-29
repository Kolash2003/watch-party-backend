import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { serverConfig } from '../config';
import logger from '../config/logger.config';
import { prisma } from '../lib/db';
import { redis } from '../lib/redis';
import { userIdFromCookieHeader } from '../lib/auth';
import { expectedPosition, getState, pushChat, recentChat, setState } from '../lib/rooms';
import type { ClientToServerEvents, Member, PlaybackUpdate, ServerToClientEvents } from '../shared/events';

type Data = { userId: string; name: string; code?: string };
type IO = Server<ClientToServerEvents, ServerToClientEvents, object, Data>;
type Sock = Socket<ClientToServerEvents, ServerToClientEvents, object, Data>;

const BUFFER_GRACE_MS = 2000;
const HOST_GRACE_MS = 60_000;
const membersKey = (code: string) => `room:${code}:members`;

let io: IO;
// Per-process timers: fine while the API is one process (see roadmap: Redis adapter for multi-server).
const bufferTimers = new Map<string, NodeJS.Timeout>(); // socketId
const hostTimers = new Map<string, NodeJS.Timeout>(); // room code
const autoPaused = new Set<string>(); // room codes paused because someone buffered

const pos = z.object({ position: z.number().finite().min(0) });
const schemas = {
    join: z.object({ code: z.string().min(1).max(20) }),
    buffering: z.object({ isBuffering: z.boolean() }),
    chat: z.object({ text: z.string().trim().min(1).max(500) }),
    reaction: z.object({ emoji: z.string().min(1).max(8) }),
    ping: z.object({ clientTime: z.number() }),
    pos,
};

async function members(code: string): Promise<(Member & { socketId: string })[]> {
    const h = await redis.hgetall(membersKey(code));
    return Object.entries(h).map(([socketId, v]) => ({ socketId, ...JSON.parse(v) }));
}

async function limited(kind: string, userId: string, max: number, windowSec: number) {
    const k = `ratelimit:${kind}:${userId}`;
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, windowSec);
    return n > max;
}

async function broadcastPlayback(code: string, patch: { playing?: boolean; position?: number }, by: Data | null, waitingFor: string | null = null) {
    const s = (await getState(code))!;
    const now = Date.now();
    const position = patch.position ?? expectedPosition(s, now);
    const playing = patch.playing ?? s.playing;
    await setState(code, { playing, position, updatedAt: now });
    const update: PlaybackUpdate = { playing, position, serverTime: now, by: by && { id: by.userId, name: by.name }, waitingFor };
    io.to(code).emit('playback:update', update);
}

// Pause when someone has buffered >2s; resume once everyone is ready.
async function checkBuffering(code: string) {
    const all = await members(code);
    const slow = all.find((m) => m.buffering && !bufferTimers.has(m.socketId));
    const s = await getState(code);
    if (!s) return;
    if (slow && s.playing) {
        autoPaused.add(code);
        await broadcastPlayback(code, { playing: false }, null, slow.name);
    } else if (!all.some((m) => m.buffering) && autoPaused.delete(code)) {
        await broadcastPlayback(code, { playing: true }, null);
    }
}

async function leave(socket: Sock) {
    const code = socket.data.code;
    if (!code) return;
    socket.data.code = undefined;
    socket.leave(code);
    clearTimeout(bufferTimers.get(socket.id));
    bufferTimers.delete(socket.id);
    await redis.hdel(membersKey(code), socket.id);
    const rest = await members(code);
    if (!rest.some((m) => m.id === socket.data.userId)) io.to(code).emit('member:left', { user: { id: socket.data.userId, name: socket.data.name } });
    if (rest.length === 0) autoPaused.delete(code);
    else await checkBuffering(code);

    const s = await getState(code);
    if (s && s.hostId === socket.data.userId && !rest.some((m) => m.id === s.hostId)) {
        hostTimers.set(code, setTimeout(() => handOverHost(code).catch((e) => logger.error(e.message)), HOST_GRACE_MS));
    }
}

async function handOverHost(code: string) {
    hostTimers.delete(code);
    const s = await getState(code);
    const rest = await members(code);
    if (!s || rest.some((m) => m.id === s.hostId) || rest.length === 0) return;
    const next = rest.reduce((a, b) => (a.joinedAt <= b.joinedAt ? a : b));
    await setState(code, { hostId: next.id });
    await prisma.room.update({ where: { code }, data: { hostId: next.id } });
    io.to(code).emit('host:changed', { hostId: next.id });
}

export function closeRoom(code: string) {
    io?.to(code).emit('error', { code: 'ROOM_CLOSED', message: 'The host closed this room' });
    io?.in(code).socketsLeave(code);
    redis.del(membersKey(code));
    clearTimeout(hostTimers.get(code));
    hostTimers.delete(code);
    autoPaused.delete(code);
}

export function attachSocket(server: HttpServer) {
    io = new Server(server, { cors: { origin: serverConfig.WEB_ORIGIN, credentials: true } }) as IO;

    io.use(async (socket, next) => {
        const userId = userIdFromCookieHeader(socket.handshake.headers.cookie);
        const user = userId && (await prisma.user.findUnique({ where: { id: userId } }));
        if (!user) return next(new Error('unauthorized'));
        socket.data = { userId: user.id, name: user.name };
        next();
    });

    io.on('connection', (socket) => {
        const fail = (code: string, message: string) => socket.emit('error', { code, message });
        // Validates payload, catches async errors, and requires a joined room when `needRoom`.
        const on = <T extends z.ZodTypeAny>(ev: keyof ClientToServerEvents, schema: T, needRoom: boolean, fn: (p: z.infer<T>, code: string) => Promise<unknown>) =>
            socket.on(ev as any, async (raw: unknown) => {
                const p = schema.safeParse(raw);
                if (!p.success) return fail('BAD_PAYLOAD', 'Invalid payload');
                if (needRoom && !socket.data.code) return fail('NOT_IN_ROOM', 'Join a room first');
                try { await fn(p.data, socket.data.code!); } catch (e) { logger.error((e as Error).message); fail('INTERNAL', 'Something went wrong'); }
            });

        on('room:join', schemas.join, false, async ({ code }) => {
            const room = await prisma.room.findUnique({ where: { code } });
            if (!room || room.closedAt) return fail('ROOM_NOT_FOUND', 'Room not found');
            if (!(await redis.sismember(`room:${code}:allowed`, socket.data.userId))) return fail('FORBIDDEN', 'Join the room via its invite link first');
            if (socket.data.code) await leave(socket);
            let s = await getState(code);
            if (!s) { // Redis state expired; rebuild from DB
                await setState(code, { playing: false, position: 0, updatedAt: Date.now(), hostId: room.hostId, videoId: room.videoId, controlMode: room.controlMode });
                s = (await getState(code))!;
            }
            socket.data.code = code;
            socket.join(code);
            const me: Member = { id: socket.data.userId, name: socket.data.name, buffering: false, joinedAt: Date.now() };
            const before = await members(code);
            await redis.multi().hset(membersKey(code), socket.id, JSON.stringify(me)).expire(membersKey(code), 24 * 3600).exec();
            if (s.hostId === me.id) { clearTimeout(hostTimers.get(code)); hostTimers.delete(code); }
            const now = Date.now();
            socket.emit('room:state', {
                code, hostId: s.hostId, controlMode: s.controlMode,
                playback: { playing: s.playing, position: expectedPosition(s, now), serverTime: now, by: null },
                members: [...before, me].map(({ socketId, ...m }: any) => m),
                chat: await recentChat(code),
            });
            if (!before.some((m) => m.id === me.id)) socket.to(code).emit('member:joined', { user: me });
        });

        on('room:leave', z.object({}).passthrough(), false, () => leave(socket));

        const control = (ev: 'play' | 'pause' | 'seek') =>
            on(`playback:${ev}` as keyof ClientToServerEvents, schemas.pos, true, async ({ position }, code) => {
                const s = await getState(code);
                if (!s) return;
                if (s.controlMode === 'HOST_ONLY' && s.hostId !== socket.data.userId) return fail('FORBIDDEN', 'Only the host can control playback');
                autoPaused.delete(code); // an explicit action overrides auto-pause
                await broadcastPlayback(code, { position, ...(ev === 'seek' ? {} : { playing: ev === 'play' }) }, socket.data);
            });
        control('play'); control('pause'); control('seek');

        on('playback:buffering', schemas.buffering, true, async ({ isBuffering }, code) => {
            const raw = await redis.hget(membersKey(code), socket.id);
            if (!raw) return;
            await redis.hset(membersKey(code), socket.id, JSON.stringify({ ...JSON.parse(raw), buffering: isBuffering }));
            io.to(code).emit('member:buffering', { userId: socket.data.userId, buffering: isBuffering });
            clearTimeout(bufferTimers.get(socket.id));
            bufferTimers.delete(socket.id);
            if (isBuffering) {
                const t = setTimeout(() => { bufferTimers.delete(socket.id); checkBuffering(code).catch((e) => logger.error(e.message)); }, BUFFER_GRACE_MS);
                bufferTimers.set(socket.id, t);
            } else await checkBuffering(code);
        });

        on('chat:send', schemas.chat, true, async ({ text }, code) => {
            if (await limited('chat', socket.data.userId, 5, 5)) return fail('RATE_LIMITED', 'Slow down');
            const room = await prisma.room.findUniqueOrThrow({ where: { code } });
            const row = await prisma.chatMessage.create({ data: { roomId: room.id, userId: socket.data.userId, text } });
            const msg = { id: row.id, user: { id: socket.data.userId, name: socket.data.name }, text, at: row.createdAt.getTime() };
            await pushChat(code, msg);
            io.to(code).emit('chat:message', msg);
        });

        on('reaction:send', schemas.reaction, true, async ({ emoji }, code) => {
            if (await limited('reaction', socket.data.userId, 10, 5)) return;
            io.to(code).emit('reaction', { user: { id: socket.data.userId, name: socket.data.name }, emoji });
        });

        on('time:ping', schemas.ping, false, async ({ clientTime }) => { socket.emit('time:pong', { clientTime, serverTime: Date.now() }); });

        socket.on('disconnect', () => { leave(socket).catch((e) => logger.error(e.message)); });
    });
    return io;
}
