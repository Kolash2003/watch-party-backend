import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { serverConfig } from './config';
import v1Router from './routers/v1/index.router';
import { tusServer } from './routers/v1/uploads';
import { requireAuth } from './lib/auth';
import { appErrorHandler, genericErrorHandler } from './middlewares/error.middleware';
import logger from './config/logger.config';
import { attachCorrelationIdMiddleware } from './middlewares/correlation.middleware';
import { attachSocket } from './socket';

const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } })); // media is fetched from the web origin
app.use(cors({ origin: serverConfig.WEB_ORIGIN, credentials: true, exposedHeaders: ['X-Video-Id', 'Upload-Offset', 'Upload-Length', 'Location', 'Tus-Resumable'] }));
app.use(attachCorrelationIdMiddleware);

// tus needs the raw request stream, so it goes before express.json()
app.all('/api/v1/uploads', requireAuth, (req, res) => { tusServer.handle(req, res); });
app.all('/api/v1/uploads/*path', requireAuth, (req, res) => { tusServer.handle(req, res); });

app.use(express.json());
app.use('/api/v1', v1Router);

app.use(appErrorHandler);
app.use(genericErrorHandler);

const server = http.createServer(app);
attachSocket(server);

server.listen(serverConfig.PORT, () => {
    logger.info(`Server is running on http://localhost:${serverConfig.PORT}`);
});
