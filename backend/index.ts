import "./env";
import { OpenRouter } from '@openrouter/sdk';
import express, { type NextFunction, type Request, type Response as ExpressResponse } from "express";
import { PROMPT_TEMPLATE, SYSTEM_PROMPT } from "./prompt";
import { prisma } from './db';
import { middleware } from './middleware';
const { tavily } = require('@tavily/core');
import cors from "cors";

declare module "express-serve-static-core" {
    interface Request {
        userId?: string;
    }
}

function slugify(text: string) {
    const base = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "chat";
    return `${base}-${crypto.randomUUID().slice(0, 8)}`
}

function sourcesBlock(results: { url: string }[]) {
    return `\n<SOURCES>\n${JSON.stringify(results.map(r => ({ url: r.url })))}\n</SOURCES>\n`
}

const app = express();
const client = tavily({ apiKey: process.env.TAVILY_API_KEY });

class WebSearchError extends Error {}

async function searchWeb(query: string) {
    try {
        return await client.search(query, { searchDepth: "advanced" });
    } catch (error) {
        console.error("Tavily search request failed:", error);
        throw new WebSearchError("Web search is temporarily unavailable. Please try again.");
    }
}

const openRouterClient = new OpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY
});

type OpenRouterMessage = {
    role: "system" | "user" | "assistant";
    content: string | OpenRouterContentPart[];
};

type OpenRouterContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
    | { type: "file"; file: { filename: string; file_data: string } };

type RequestAttachment = {
    name: string;
    mediaType: string;
    data: string;
};

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_TEXT_ATTACHMENT_SIZE = 2 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_SIZE = 15 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAttachments(value: unknown): { attachments: RequestAttachment[]; error?: string } {
    if (value === undefined) return { attachments: [] };
    if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) {
        return { attachments: [], error: `Attach no more than ${MAX_ATTACHMENTS} files.` };
    }

    const attachments: RequestAttachment[] = [];
    let totalSize = 0;

    for (const item of value) {
        if (!isRecord(item) || typeof item.name !== "string" || typeof item.mediaType !== "string" || typeof item.data !== "string") {
            return { attachments: [], error: "An attachment is invalid." };
        }

        const { name, mediaType, data } = item;
        const isImage = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType);
        const isText = mediaType.startsWith("text/") || ["application/json", "application/xml"].includes(mediaType);
        const isPdf = mediaType === "application/pdf";
        if (!name.trim() || name.length > 255 || /[\u0000-\u001f]/.test(name) || (!isImage && !isText && !isPdf)) {
            return { attachments: [], error: `${name || "A file"} has an unsupported type or filename.` };
        }

        let size: number;
        if (isText) {
            size = new TextEncoder().encode(data).byteLength;
            if (size === 0 || size > MAX_TEXT_ATTACHMENT_SIZE) {
                return { attachments: [], error: `${name} must be a non-empty text file no larger than 2 MB.` };
            }
        } else {
            const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(data);
            const dataMediaType = match?.[1];
            const encodedData = match?.[2];
            if (!dataMediaType || dataMediaType !== mediaType || !encodedData || encodedData.length % 4 !== 0) {
                return { attachments: [], error: `${name} could not be read as a supported file.` };
            }
            const padding = encodedData.endsWith("==") ? 2 : encodedData.endsWith("=") ? 1 : 0;
            size = encodedData.length * 3 / 4 - padding;
            if (size === 0 || size > MAX_ATTACHMENT_SIZE) {
                return { attachments: [], error: `${name} must be no larger than 10 MB.` };
            }
        }

        totalSize += size;
        if (totalSize > MAX_TOTAL_ATTACHMENT_SIZE) {
            return { attachments: [], error: "Attachments must total 15 MB or less." };
        }
        attachments.push({ name, mediaType, data });
    }

    return { attachments };
}

function userMessageContent(query: string, attachments: RequestAttachment[]) {
    if (!attachments.length) return query;
    return `${query}\n\nAttached files: ${attachments.map(({ name }) => name).join(", ")}`;
}

function modelUserContent(prompt: string, attachments: RequestAttachment[]): string | OpenRouterContentPart[] {
    if (!attachments.length) return prompt;

    const content: OpenRouterContentPart[] = [{ type: "text", text: prompt }];
    for (const attachment of attachments) {
        if (attachment.mediaType.startsWith("image/")) {
            content.push({ type: "image_url", image_url: { url: attachment.data } });
        } else if (attachment.mediaType === "application/pdf") {
            content.push({ type: "file", file: { filename: attachment.name, file_data: attachment.data } });
        } else {
            content.push({ type: "text", text: `Attached file: ${attachment.name}\n${attachment.data}` });
        }
    }
    return content;
}

async function requestOpenRouterRest(messages: OpenRouterMessage[]) {
    const apiKey = process.env.FUSE_VIRTUAL_KEY;
    if (!apiKey) {
        throw new Error("FUSE_VIRTUAL_KEY is not configured");
    }

    return fetch("https://fuse-gateway.rushi611.workers.dev/api/v1/chat/completions", {


    // return fetch("http://127.0.0.1:8787/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: "openrouter/free",
            messages,
            stream: true
        })
    });
}

async function* streamOpenRouterRest(response: Response) {
    if (!response.body) {
        throw new Error("OpenRouter REST response did not include a stream");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
        while (true) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? "";

            for (const line of lines) {
                if (!line.startsWith("data:")) continue;
                const data = line.slice(5).trim();
                if (data === "[DONE]") return;

                const chunk = JSON.parse(data) as {
                    choices?: Array<{ delta?: { content?: string | null } }>;
                };
                const content = chunk.choices?.[0]?.delta?.content;
                if (content) yield content;
            }

            if (done) break;
        }

        if (buffer.startsWith("data:")) {
            const data = buffer.slice(5).trim();
            if (data && data !== "[DONE]") {
                const chunk = JSON.parse(data) as {
                    choices?: Array<{ delta?: { content?: string | null } }>;
                };
                const content = chunk.choices?.[0]?.delta?.content;
                if (content) yield content;
            }
        }
    } finally {
        reader.releaseLock();
    }
}

app.use(express.json({ limit: "22mb" }));
app.use(cors())

app.get("/conversations", middleware, async (req, res) => {
    const conversations = await prisma.conversation.findMany({
        where: { userId: req.userId },
        select: { id: true, title: true, slug: true }
    })
    res.json(conversations)
});

app.get("/conversations/:conversationId", middleware, async (req, res) => {

    const conversationId = req.params.conversationId;
    if (typeof conversationId !== "string") {
        res.status(400).json({
            message: "Invalid conversation id"
        })
        return
    }

    const conversation = await prisma.conversation.findFirst({
        where: {
            id: conversationId,
            userId: req.userId
        },
        include: {
            messages: { orderBy: { createdAt: "asc" } }
        }
    })

    if (!conversation) {
        res.status(404).json({ message: "conversation not found" })
        return
    }

    res.json({ conversation })
});

app.post("/ask", middleware, async (req, res) => {

    const query = req.body.query;
    if (typeof query !== "string" || !query.trim()) {
        res.status(400).json({ error: "Query is required" });
        return;
    }

    const webSearchResponse = await searchWeb(query)

    const webSearchResults = webSearchResponse.results;


    const conversation = await prisma.conversation.create({
        data: {
            title: query.slice(0, 80),
            slug: slugify(query),
            userId: req.userId!,
            messages: {
                create: { content: query, role: "User" }
            }
        }
    })

    const userPrompt = PROMPT_TEMPLATE
        .replace("{{WEB_SEARCH_RESULTS}}", JSON.stringify(webSearchResults))
        .replace("{{USER_QUERY}}", query);

    const stream = await openRouterClient.chat.send({
        chatRequest: {
            model: 'openrouter/free',
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userPrompt }
            ],
            stream: true,
        }
    });

    res.header("Content-Type", "text/event-stream");
    res.header("Cache-Control", "no-cache");
    res.header("Connection", "keep-alive");
    res.header('x-conversation-id', conversation.id)

    let assistantText = ""

    for await (const chunk of stream) {
        const content = chunk.choices?.[0]?.delta?.content;
        if (content) {
            assistantText += content
            res.write(content);
        }
    }

    const sources = sourcesBlock(webSearchResults)
    res.write(sources);

    res.end();

    await prisma.message.create({
        data: {
            content: assistantText + sources,
            role: "Assistant",
            conversationId: conversation.id
        }
    })
});

app.post("/ask-rest", middleware, async (req, res) => {
    const query = typeof req.body.query === "string" ? req.body.query.trim() : "";
    const parsedAttachments = parseAttachments(req.body.attachments);
    if (parsedAttachments.error) {
        res.status(400).json({ error: parsedAttachments.error });
        return;
    }
    const attachments = parsedAttachments.attachments;
    if (!query && !attachments.length) {
        res.status(400).json({ error: "A query or attachment is required" });
        return;
    }

    const userQuery = query || "Please analyze the attached file(s).";
    const webSearchResults = query
        ? (await searchWeb(query)).results
        : [];

    const conversation = await prisma.conversation.create({
        data: {
            title: userQuery.slice(0, 80),
            slug: slugify(userQuery),
            userId: req.userId!,
            messages: {
                create: { content: userMessageContent(userQuery, attachments), role: "User" }
            }
        }
    });

    const userPrompt = PROMPT_TEMPLATE
        .replace("{{WEB_SEARCH_RESULTS}}", JSON.stringify(webSearchResults))
        .replace("{{USER_QUERY}}", userQuery);

    const openRouterResponse = await requestOpenRouterRest([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: modelUserContent(userPrompt, attachments) }
    ]);
    console.log("OpenRouter REST response status:", openRouterResponse.status);
    console.log(openRouterResponse.statusText)
    if (!openRouterResponse.ok) {
        res.status(openRouterResponse.status).json({
            error: "OpenRouter REST request failed",
            details: await openRouterResponse.text()
        });
        return;
    }

    res.header("Content-Type", "text/event-stream");
    res.header("Cache-Control", "no-cache");
    res.header("Connection", "keep-alive");
    res.header("x-conversation-id", conversation.id);

    let assistantText = "";
    for await (const content of streamOpenRouterRest(openRouterResponse)) {
        assistantText += content;
        res.write(content);
    }

    const sources = sourcesBlock(webSearchResults);
    res.write(sources);
    res.end();

    await prisma.message.create({
        data: {
            content: assistantText + sources,
            role: "Assistant",
            conversationId: conversation.id
        }
    });
});

app.post("/ask-with-followup", middleware, async (req, res) => {
    const query = req.body.query

    const conversationId = req.body.conversationId

    if (typeof query !== "string" || !query.trim() || typeof conversationId !== "string") {
        res.status(400).json({ messages: "Missing query or conversationId" })
        return
    }

    const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, userId: req.userId },
        include: { messages: { orderBy: { createdAt: "asc" } } }
    })

    if (!conversation) { res.status(404).json({ message: "conversation not found" }); return }

    const webSearchResponse = await searchWeb(query)

    const webSearchResults = webSearchResponse.results;

    await prisma.message.create({
        data: {
            content: query,
            role: "User",
            conversationId: conversation.id
        }
    })

    const history = conversation.messages.map(m => ({
        role: m.role === "User" ? "user" as const : "assistant" as const,
        content: typeof m.content === "string" ? m.content : String(m.content)
    }))


    const currentPrompt = PROMPT_TEMPLATE
        .replace("{{WEB_SEARCH_RESULTS}}", JSON.stringify(webSearchResults))
        .replace("{{USER_QUERY}}", query);

    const stream = await openRouterClient.chat.send({
        chatRequest: {
            model: 'openrouter/free',
            messages: [...history, { role: 'user', content: currentPrompt }
            ],
            stream: true,
        }
    });

    res.header("Content-Type", "text/event-stream");
    res.header("Cache-Control", "no-cache");
    res.header("Connection", "keep-alive");
    res.header('x-conversation-id', conversation.id)


    let assistantText = ""

    for await (const chunk of stream) {
        const content = chunk.choices?.[0]?.delta?.content;
        if (content) {
            assistantText += content
            res.write(content);
        }
    }

    const sources = sourcesBlock(webSearchResults)
    res.write(sources);

    res.end();

    await prisma.message.create({
        data: {
            content: assistantText + sources,
            role: "Assistant",
            conversationId: conversation.id
        }
    })


});

app.post("/ask-with-followup-rest", middleware, async (req, res) => {
    const query = typeof req.body.query === "string" ? req.body.query.trim() : "";
    const conversationId = req.body.conversationId;
    const parsedAttachments = parseAttachments(req.body.attachments);

    if (parsedAttachments.error) {
        res.status(400).json({ error: parsedAttachments.error });
        return;
    }
    const attachments = parsedAttachments.attachments;
    if ((!query && !attachments.length) || typeof conversationId !== "string") {
        res.status(400).json({ error: "A query or attachment and conversationId are required" });
        return;
    }
    const userQuery = query || "Please analyze the attached file(s).";

    const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, userId: req.userId },
        include: { messages: { orderBy: { createdAt: "asc" } } }
    });

    if (!conversation) {
        res.status(404).json({ message: "conversation not found" });
        return;
    }

    const webSearchResults = query
        ? (await searchWeb(query)).results
        : [];

    const history: OpenRouterMessage[] = conversation.messages.map(message => ({
        role: message.role === "User" ? "user" : "assistant",
        content: typeof message.content === "string" ? message.content : String(message.content)
    }));

    const currentPrompt = PROMPT_TEMPLATE
        .replace("{{WEB_SEARCH_RESULTS}}", JSON.stringify(webSearchResults))
        .replace("{{USER_QUERY}}", userQuery);

    const openRouterResponse = await requestOpenRouterRest([
        ...history,
        { role: "user", content: modelUserContent(currentPrompt, attachments) }
    ]);
    if (!openRouterResponse.ok) {
        res.status(openRouterResponse.status).json({
            error: "OpenRouter REST request failed",
            details: await openRouterResponse.text()
        });
        return;
    }

    await prisma.message.create({
        data: {
            content: userMessageContent(userQuery, attachments),
            role: "User",
            conversationId: conversation.id
        }
    });

    res.header("Content-Type", "text/event-stream");
    res.header("Cache-Control", "no-cache");
    res.header("Connection", "keep-alive");
    res.header("x-conversation-id", conversation.id);

    let assistantText = "";
    for await (const content of streamOpenRouterRest(openRouterResponse)) {
        assistantText += content;
        res.write(content);
    }

    const sources = sourcesBlock(webSearchResults);
    res.write(sources);
    res.end();

    await prisma.message.create({
        data: {
            content: assistantText + sources,
            role: "Assistant",
            conversationId: conversation.id
        }
    });
});

app.use((error: unknown, _req: Request, res: ExpressResponse, next: NextFunction) => {
    if (error instanceof WebSearchError) {
        res.status(502).json({ error: error.message });
        return;
    }
    next(error);
});

app.listen(3001)