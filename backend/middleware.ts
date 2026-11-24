import type { NextFunction, Request, Response } from "express";
import { createsupabaseClient } from "./client";
import { prisma } from "./db";

const client = createsupabaseClient();
export async function middleware(req: Request, res: Response, next: NextFunction) {
    const token = req.headers.authorization;

    const data = await client.auth.getUser(token);
    const userId = data.data.user?.id;

    if (userId) {
        req.userId = userId;

        const user = data.data.user!;
        const userData = {
            provider: user.app_metadata.provider === "google" ? "Google" as const : "Github" as const,
            email: user.email!,
            name: user.user_metadata.full_name || user.email!,
            supabaseId: user.id
        };
        await prisma.user.upsert({
            where: { id: userId },
            create: { ...userData, id: userId },
            update: userData
        });

        next();
    } else {
        res.status(403).json({ error: "Unauthorized" });
    }
}