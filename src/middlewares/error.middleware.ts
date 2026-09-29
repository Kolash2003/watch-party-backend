import { NextFunction, Request, Response } from "express";
import { AppError } from "../utils/errors/app.error";
import logger from "../config/logger.config";

export const appErrorHandler = (err: AppError, req: Request, res: Response, next: NextFunction) => {
    if (!err.statusCode) return next(err);
    res.status(err.statusCode).json({ error: { code: err.name, message: err.message } });
}

export const genericErrorHandler = (err: Error, req: Request, res: Response, next: NextFunction) => {
    logger.error(err.message, { stack: err.stack });
    res.status(500).json({ error: { code: "InternalServerError", message: "Internal Server Error" } });
}
