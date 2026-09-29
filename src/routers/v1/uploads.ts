import path from 'path';
import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { serverConfig } from '../../config';
import { prisma } from '../../lib/db';
import { transcodeQueue } from '../../lib/queue';
import { tmpDir } from '../../lib/storage';
import { userIdFromCookieHeader } from '../../lib/auth';

const ALLOWED = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v']);
export const UPLOAD_DIR = tmpDir('uploads');

const reject = (status_code: number, message: string) => ({ status_code, body: message });

export const tusServer = new Server({
    path: '/api/v1/uploads',
    datastore: new FileStore({ directory: UPLOAD_DIR }),
    maxSize: serverConfig.MAX_UPLOAD_BYTES,
    respectForwardedHeaders: true,
    allowedOrigins: [serverConfig.WEB_ORIGIN],
    allowedCredentials: true,
    async onUploadCreate(req, upload) {
        const userId = userIdFromCookieHeader(req.headers.get('cookie'));
        if (!userId) throw reject(401, 'Not signed in');
        const ext = path.extname(String(upload.metadata?.filename ?? '')).toLowerCase();
        if (!ALLOWED.has(ext)) throw reject(400, `Unsupported file type ${ext || '(none)'}`);
        const used = await prisma.video.aggregate({ where: { ownerId: userId }, _sum: { sizeBytes: true } });
        if (Number(used._sum.sizeBytes ?? 0) + (upload.size ?? 0) > serverConfig.USER_QUOTA_BYTES) throw reject(413, 'Storage quota exceeded');
        return { metadata: { ...upload.metadata, userId } }; // ids come from the cookie, never from the client
    },
    async onUploadFinish(_req, upload) {
        const filename = String(upload.metadata?.filename ?? 'Untitled');
        const video = await prisma.video.create({
            data: { ownerId: String(upload.metadata!.userId), title: path.basename(filename, path.extname(filename)), sizeBytes: BigInt(upload.size ?? 0) },
        });
        await transcodeQueue.add('transcode', { videoId: video.id, uploadId: upload.id }, {
            attempts: 3, // first try + 2 retries
            backoff: { type: 'exponential', delay: 10_000 },
            removeOnComplete: true,
        });
        return { headers: { 'X-Video-Id': video.id } };
    },
});
