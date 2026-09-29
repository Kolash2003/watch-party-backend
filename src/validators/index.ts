import { NextFunction, Request, Response } from "express";
import { ZodTypeAny } from "zod";
import logger from "../config/logger.config";

/**
 * 
 * @param schema - Zod schema to validate the request body
 * @returns - Middleware function to validate the request body
 */
export const validateRequestBody = (schema: ZodTypeAny) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {

            logger.info("Validating request body");
            req.body = await schema.parseAsync(req.body);
            logger.info("Request body is valid");
            next();

        } catch (error) {
            // If the validation fails, 
            logger.error("Request body is invalid");
            res.status(400).json({ error: { code: "BadRequest", message: "Invalid request body", details: error } });
            
        }
    }
}

/**
 * 
 * @param schema - Zod schema to validate the request body
 * @returns - Middleware function to validate the request query params
 */
export const validateQueryParams = (schema: ZodTypeAny) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {

            await schema.parseAsync(req.query);
            console.log("Query params are valid");
            next();

        } catch (error) {
            // If the validation fails, 

            res.status(400).json({ error: { code: "BadRequest", message: "Invalid query params", details: error } });
            
        }
    }
}

