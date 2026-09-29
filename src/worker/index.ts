import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { Job, UnrecoverableError, Worker } from 'bullmq';
import logger from '../config/logger.config';
import { prisma } from '../lib/db';
import { makeRedis } from '../lib/redis';
import { storage, tmpDir } from '../lib/storage';

const LADDER = [
    { name: '360p', h: 360, vb: '800k', maxrate: '856k', ab: '96k' },
    { name: '720p', h: 720, vb: '2800k', maxrate: '2996k', ab: '128k' },
    { name: '1080p', h: 1080, vb: '5000k', maxrate: '5350k', ab: '192k' },
];
const JOB_TIMEOUT_MS = 6 * 3600_000;
const UPLOAD_DIR = tmpDir('uploads');

// Args are always an array, never a shell string.
function run(cmd: string, args: string[], onStdoutLine?: (l: string) => void): Promise<string> {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args);
        let out = '', err = '', buf = '';
        const timer = setTimeout(() => p.kill('SIGKILL'), JOB_TIMEOUT_MS);
        p.stdout.on('data', (d) => {
            out += d;
            if (onStdoutLine) { buf += d; const lines = buf.split('\n'); buf = lines.pop()!; lines.forEach(onStdoutLine); }
        });
        p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
        p.on('error', reject);
        p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`)); });
    });
}

async function probe(file: string) {
    let info: any;
    try {
        info = JSON.parse(await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
    } catch {
        throw new UnrecoverableError('Not a valid video file');
    }
    const v = info.streams?.find((s: any) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
    if (!v) throw new UnrecoverableError('File has no video stream');
    const duration = Number(info.format?.duration ?? v.duration);
    if (!(duration > 0)) throw new UnrecoverableError('Could not determine video duration');
    return { duration, width: v.width as number, height: v.height as number, hasAudio: info.streams.some((s: any) => s.codec_type === 'audio') };
}

async function transcode(job: Job) {
    const { videoId, uploadId } = job.data as { videoId: string; uploadId: string };
    const src = path.join(UPLOAD_DIR, uploadId);
    await prisma.video.update({ where: { id: videoId }, data: { status: 'PROCESSING', progress: 0, errorMessage: null } });

    const meta = await probe(src);
    let rungs = LADDER.filter((r) => r.h <= meta.height);
    if (!rungs.length) rungs = [{ ...LADDER[0], name: `${meta.height}p`, h: meta.height }]; // smaller than 360p: keep source size

    const out = tmpDir('transcode', videoId);
    await fs.rm(out, { recursive: true, force: true });
    await fs.mkdir(out, { recursive: true });
    for (let i = 0; i < rungs.length; i++) await fs.mkdir(path.join(out, `v${i}`));

    const n = rungs.length;
    const filter = `[0:v]split=${n}${rungs.map((_, i) => `[s${i}]`).join('')};` +
        rungs.map((r, i) => `[s${i}]scale=-2:${r.h}[v${i}]`).join(';');
    const args = ['-y', '-nostdin', '-progress', 'pipe:1', '-nostats', '-i', src, '-filter_complex', filter];
    rungs.forEach((r, i) => {
        args.push('-map', `[v${i}]`, `-c:v:${i}`, 'libx264', `-preset`, 'veryfast', `-b:v:${i}`, r.vb, `-maxrate:v:${i}`, r.maxrate, `-bufsize:v:${i}`, `${parseInt(r.vb) * 2}k`);
        if (meta.hasAudio) args.push('-map', '0:a:0', `-c:a:${i}`, 'aac', `-b:a:${i}`, r.ab, '-ac', '2');
    });
    args.push('-g', '48', '-keyint_min', '48', '-sc_threshold', '0', '-force_key_frames', 'expr:gte(t,n_forced*6)',
        '-f', 'hls', '-hls_time', '6', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
        '-master_pl_name', 'master.m3u8',
        '-var_stream_map', rungs.map((_, i) => (meta.hasAudio ? `v:${i},a:${i}` : `v:${i}`)).join(' '),
        '-hls_segment_filename', path.join(out, 'v%v', 'seg_%04d.ts'), path.join(out, 'v%v', 'index.m3u8'));

    let last = 0;
    await run('ffmpeg', args, (line) => {
        const m = line.match(/^out_time_us=(\d+)/);
        if (!m) return;
        const pct = Math.min(99, Math.floor((Number(m[1]) / 1e6 / meta.duration) * 100));
        if (pct > last) { last = pct; job.updateProgress(pct); prisma.video.update({ where: { id: videoId }, data: { progress: pct } }).catch(() => {}); }
    });

    await run('ffmpeg', ['-y', '-nostdin', '-ss', String(meta.duration * 0.1), '-i', src, '-frames:v', '1', '-vf', 'scale=-2:360', path.join(out, 'thumb.jpg')]);
    // Text subtitles only; image-based tracks fail here and we just skip them.
    const hasSubtitles = await run('ffmpeg', ['-y', '-nostdin', '-i', src, '-map', '0:s:0', path.join(out, 'subtitles.vtt')]).then(() => true, () => false);

    await storage.put(videoId, out);
    await prisma.video.update({
        where: { id: videoId },
        data: { status: 'READY', progress: 100, durationSec: Math.round(meta.duration), width: meta.width, height: meta.height, renditions: rungs.map((r) => r.name), hasSubtitles },
    });
    await Promise.all([fs.rm(src, { force: true }), fs.rm(`${src}.json`, { force: true })]);
}

const worker = new Worker('transcode', async (job) => {
    try {
        await transcode(job);
    } catch (e) {
        const final = e instanceof UnrecoverableError || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        if (final) await prisma.video.update({ where: { id: job.data.videoId }, data: { status: 'FAILED', errorMessage: (e as Error).message.slice(0, 500) } }).catch(() => {});
        throw e;
    }
}, { connection: makeRedis(), concurrency: 1 });

worker.on('completed', (job) => logger.info('transcode done', { videoId: job.data.videoId }));
worker.on('failed', (job, err) => logger.error('transcode failed', { videoId: job?.data.videoId, err: err.message }));
logger.info('Transcode worker started');
