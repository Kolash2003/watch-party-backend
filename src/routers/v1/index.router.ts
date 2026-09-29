import express from 'express';
import authRouter, { meHandler } from './auth.router';
import videosRouter from './videos.router';
import roomsRouter from './rooms.router';
import mediaRouter from './media.router';

const v1Router = express.Router();

v1Router.get('/healthz', (_req, res) => { res.status(200).send('OK'); });
v1Router.use('/auth', authRouter);
v1Router.get('/me', ...meHandler);
v1Router.use('/videos', videosRouter);
v1Router.use('/rooms', roomsRouter);
v1Router.use('/media', mediaRouter);

export default v1Router;
