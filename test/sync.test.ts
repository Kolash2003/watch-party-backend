import http from 'http';
import { AddressInfo } from 'net';
import { io as connect, Socket } from 'socket.io-client';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { prisma } from '../src/lib/db';
import { redis } from '../src/lib/redis';
import { signToken } from '../src/lib/auth';
import { expectedPosition, initRoomState } from '../src/lib/rooms';
import { attachSocket } from '../src/socket';

const tag = Date.now().toString(36);
const code = `t${tag}`.slice(0, 10);
let server: http.Server, url: string;
const users: { id: string }[] = [];

const client = (userId: string) => connect(url, { extraHeaders: { cookie: `wp_session=${signToken(userId)}` }, transports: ['websocket'] });
const once = <T = any>(s: Socket, ev: string) => new Promise<T>((r) => s.once(ev, r));

beforeAll(async () => {
    for (const n of ['host', 'guest', 'outsider']) users.push(await prisma.user.create({ data: { email: `${n}-${tag}@t.io`, name: n, passwordHash: 'x' } }));
    const video = await prisma.video.create({ data: { ownerId: users[0].id, title: 't', status: 'READY' } });
    await prisma.room.create({ data: { code, hostId: users[0].id, videoId: video.id } });
    await initRoomState(code, users[0].id, video.id, 'HOST_ONLY');
    await redis.sadd(`room:${code}:allowed`, users[0].id, users[1].id);
    server = http.createServer();
    attachSocket(server);
    await new Promise<void>((r) => server.listen(0, r));
    url = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await prisma.chatMessage.deleteMany({ where: { room: { code } } });
    await prisma.room.deleteMany({ where: { code } });
    await prisma.video.deleteMany({ where: { ownerId: users[0].id } });
    await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
    await redis.del(`room:${code}:allowed`, `room:${code}:state`, `room:${code}:members`, `room:${code}:chat`);
    server.close();
    await prisma.$disconnect();
    redis.disconnect();
});

test('expectedPosition advances only while playing', () => {
    expect(expectedPosition({ playing: false, position: 5, updatedAt: 0 }, 10_000)).toBe(5);
    expect(expectedPosition({ playing: true, position: 5, updatedAt: 0 }, 10_000)).toBe(15);
});

test('viewers converge after play, seek, pause; guests cannot control; chat works; outsiders rejected', async () => {
    const host = client(users[0].id), guest = client(users[1].id), outsider = client(users[2].id);
    host.emit('room:join', { code });
    await once(host, 'room:state');
    guest.emit('room:join', { code });
    const state = await once(guest, 'room:state');
    expect(state.members).toHaveLength(2);

    outsider.emit('room:join', { code });
    expect((await once(outsider, 'error')).code).toBe('FORBIDDEN');

    const both = (ev: string) => Promise.all([once(host, ev), once(guest, ev)]);
    for (const [ev, playing, position] of [['play', true, 3], ['seek', true, 40], ['pause', false, 41]] as const) {
        const got = both('playback:update');
        host.emit(`playback:${ev}`, { position });
        const [a, b] = await got;
        expect(a).toEqual(b);
        expect(a.playing).toBe(playing);
        expect(a.position).toBe(position);
    }

    guest.emit('playback:play', { position: 0 });
    expect((await once(guest, 'error')).code).toBe('FORBIDDEN');

    const chat = both('chat:message');
    guest.emit('chat:send', { text: 'hi' });
    expect((await chat)[0].text).toBe('hi');
    [host, guest, outsider].forEach((s) => s.close());
});
