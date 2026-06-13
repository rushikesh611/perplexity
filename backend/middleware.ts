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

        try {
            await prisma.user.create({
                data: {
                    provider: data.data.user?.app_metadata.provider === "google" ? "Google" : "Github",
                    email: data.data.user?.email!,
                    name: data.data.user?.user_metadata.full_name,
                    supabaseId: data.data.user!.id,
                    id: data.data.user!.id
                }
            })

        } catch (e) {
            console.log("Error", e)
        }

        next();
    } else {
        res.status(403).json({ error: "Unauthorized" });
    }
}