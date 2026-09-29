import fs from 'fs/promises';
import path from 'path';
import { serverConfig } from '../config';

export interface Storage {
    put(key: string, localPath: string): Promise<void>;
    delete(prefix: string): Promise<void>;
    getPublicUrl(key: string): string;
}

const root = () => path.join(serverConfig.STORAGE_ROOT, 'videos');

export class LocalStorage implements Storage {
    // Moves a directory (or file) into place; tmp and videos share a disk so rename is atomic.
    async put(key: string, localPath: string) {
        const dest = path.join(root(), key);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.rm(dest, { recursive: true, force: true });
        await fs.rename(localPath, dest);
    }
    async delete(prefix: string) {
        await fs.rm(path.join(root(), prefix), { recursive: true, force: true });
    }
    getPublicUrl(key: string) {
        return `/api/v1/media/${key}`;
    }
}

export const storage: Storage = new LocalStorage();
export const videosDir = root;
export const tmpDir = (...p: string[]) => path.join(serverConfig.STORAGE_ROOT, 'tmp', ...p);
