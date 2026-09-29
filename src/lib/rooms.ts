import { redis } from './redis';

export type ControlMode = 'HOST_ONLY' | 'EVERYONE';
export type PlaybackState = { playing: boolean; position: number; updatedAt: number };

const TTL = 24 * 3600;
const key = (code: string, k: string) => `room:${code}:${k}`;

// Position is never stored as "now"; derive it from the last event.
export function expectedPosition(s: PlaybackState, now = Date.now()) {
    return s.playing ? s.position + (now - s.updatedAt) / 1000 : s.position;
}

export async function getState(code: string): Promise<(PlaybackState & { hostId: string; videoId: string; controlMode: ControlMode }) | null> {
    const h = await redis.hgetall(key(code, 'state'));
    if (!h.hostId) return null;
    return {
        playing: h.playing === '1',
        position: Number(h.position),
        updatedAt: Number(h.updatedAt),
        hostId: h.hostId,
        videoId: h.videoId,
        controlMode: (h.controlMode as ControlMode) || 'HOST_ONLY',
    };
}

export async function setState(code: string, patch: Record<string, string | number | boolean>) {
    const flat = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v)]));
    await redis.multi().hset(key(code, 'state'), flat).expire(key(code, 'state'), TTL).exec();
}

export const initRoomState = (code: string, hostId: string, videoId: string, controlMode: ControlMode) =>
    setState(code, { playing: false, position: 0, updatedAt: Date.now(), hostId, videoId, controlMode });

export const pushChat = async (code: string, msg: object) => {
    await redis.multi().rpush(key(code, 'chat'), JSON.stringify(msg)).ltrim(key(code, 'chat'), -100, -1).expire(key(code, 'chat'), TTL).exec();
};
export const recentChat = async (code: string) => (await redis.lrange(key(code, 'chat'), 0, -1)).map((s) => JSON.parse(s));
