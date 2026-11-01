import { OpenRouter } from '@openrouter/sdk';
import express from "express";
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

const openRouterClient = new OpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY
});

type OpenRouterMessage = {
    role: "system" | "user" | "assistant";
    content: string;
};

async function requestOpenRouterRest(messages: OpenRouterMessage[]) {
    const apiKey = process.env.FUSE_VIRTUAL_KEY;
    if (!apiKey) {
        throw new Error("FUSE_VIRTUAL_KEY is not configured");
    }

    return fetch("https://fuse-gateway.rushi611.workers.dev/api/v1/chat/completions", {
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

app.use(express.json());
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

    const webSearchResponse = await client.search(query, {
        searchDepth: "advanced",
    })

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
    const query = req.body.query;
    if (typeof query !== "string" || !query.trim()) {
        res.status(400).json({ error: "Query is required" });
        return;
    }

    const webSearchResponse = await client.search(query, {
        searchDepth: "advanced",
    });
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
    });

    const userPrompt = PROMPT_TEMPLATE
        .replace("{{WEB_SEARCH_RESULTS}}", JSON.stringify(webSearchResults))
        .replace("{{USER_QUERY}}", query);

    const openRouterResponse = await requestOpenRouterRest([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt }
    ]);
    console.log("OpenRouter REST response status:", openRouterResponse.status);
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

    const webSearchResponse = await client.search(query, {
        searchDepth: "advanced",
    })

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
    const query = req.body.query;
    const conversationId = req.body.conversationId;

    if (typeof query !== "string" || !query.trim() || typeof conversationId !== "string") {
        res.status(400).json({ messages: "Missing query or conversationId" });
        return;
    }

    const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, userId: req.userId },
        include: { messages: { orderBy: { createdAt: "asc" } } }
    });

    if (!conversation) {
        res.status(404).json({ message: "conversation not found" });
        return;
    }

    const webSearchResponse = await client.search(query, {
        searchDepth: "advanced",
    });
    const webSearchResults = webSearchResponse.results;

    const history: OpenRouterMessage[] = conversation.messages.map(message => ({
        role: message.role === "User" ? "user" : "assistant",
        content: typeof message.content === "string" ? message.content : String(message.content)
    }));

    const currentPrompt = PROMPT_TEMPLATE
        .replace("{{WEB_SEARCH_RESULTS}}", JSON.stringify(webSearchResults))
        .replace("{{USER_QUERY}}", query);

    const openRouterResponse = await requestOpenRouterRest([
        ...history,
        { role: "user", content: currentPrompt }
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
            content: query,
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

app.listen(3001)