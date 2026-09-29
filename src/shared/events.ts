// Socket event contract. Imported by the API and (type-only) by the web app.
export type PublicUser = { id: string; name: string };
export type Member = PublicUser & { buffering: boolean; joinedAt: number };
export type ChatMessage = { id: string; user: PublicUser; text: string; at: number };
export type PlaybackUpdate = { playing: boolean; position: number; serverTime: number; by: PublicUser | null; waitingFor?: string | null };
export type RoomState = {
    code: string;
    hostId: string;
    controlMode: 'HOST_ONLY' | 'EVERYONE';
    playback: PlaybackUpdate; // position is already "as of serverTime"
    members: Member[];
    chat: ChatMessage[];
};

export interface ClientToServerEvents {
    'room:join': (p: { code: string }) => void;
    'room:leave': (p: object) => void;
    'playback:play': (p: { position: number }) => void;
    'playback:pause': (p: { position: number }) => void;
    'playback:seek': (p: { position: number }) => void;
    'playback:buffering': (p: { isBuffering: boolean }) => void;
    'chat:send': (p: { text: string }) => void;
    'reaction:send': (p: { emoji: string }) => void;
    'time:ping': (p: { clientTime: number }) => void;
}

export interface ServerToClientEvents {
    'room:state': (s: RoomState) => void;
    'playback:update': (u: PlaybackUpdate) => void;
    'member:joined': (p: { user: Member }) => void;
    'member:left': (p: { user: PublicUser }) => void;
    'member:buffering': (p: { userId: string; buffering: boolean }) => void;
    'host:changed': (p: { hostId: string }) => void;
    'chat:message': (m: ChatMessage) => void;
    reaction: (p: { user: PublicUser; emoji: string }) => void;
    'time:pong': (p: { clientTime: number; serverTime: number }) => void;
    error: (p: { code: string; message: string }) => void;
}
