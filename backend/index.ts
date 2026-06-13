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

app.listen(3001)