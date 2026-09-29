import { z } from 'zod';

export const signupSchema = z.object({
    email: z.string().email(),
    name: z.string().min(1).max(50),
    password: z.string().min(8).max(200),
});
export const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
export const createRoomSchema = z.object({
    videoId: z.string().min(1),
    controlMode: z.enum(['HOST_ONLY', 'EVERYONE']).default('HOST_ONLY'),
});
export const patchVideoSchema = z.object({ title: z.string().min(1).max(200) });
