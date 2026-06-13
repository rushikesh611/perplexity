import { OpenRouter } from '@openrouter/sdk';
import express from "express";
import { PROMPT_TEMPLATE, SYSTEM_PROMPT } from "./prompt";
import { prisma } from './db';
const { tavily } = require('@tavily/core');


const app = express();
const client = tavily({ apiKey: process.env.TAVILY_API_KEY });

const openRouterClient = new OpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY
});


app.use(express.json());


app.post("/ask", async (req, res) => {
    // Step 1 - get the query from the user

    const query = req.body.query;
    if (!query) {
        res.status(400).json({ error: "Query is required" });
        return;
    }

    // Step 2 - make sure the user has access/credits to hit the endpoint [Will do later]

    // Step 3 - check if we have web search indexed for a similar query [Will do later]

    // Step 4 - web search to get the sources
    const webSearchResponse = await client.search(query, {
        searchDepth: "advanced",
    })

    const webSearchResults = webSearchResponse.results;


    // Step 5 - do some context engineering on the prompt + web search response

    // Step 6 - hit the LLM with the prompt and stream the response back to the user

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

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    for await (const chunk of stream) {
        const content = chunk.choices?.[0]?.delta?.content;
        if (content) {
            res.write(content);
        }
    }

    res.write("--------------SOURCES----------------\n\n");

    // Step 7 - also stream back the sources and the follow up questions we can get from another parallel LLM call

    res.write(JSON.stringify({ sources: webSearchResults }));

    // Step 8 - Close the event stream
    res.end();
});


app.post("/ask-with-followup", async (req, res) => {
    (
        // Step 1 : Get the existing chat from the db

        // Step 2 : Forward the full history to the LLM

        // Step 2.5 : Do context engineering [Will do later]
        // Step 3 : Stream the response back to the user


        console.log("This is the ask with followup endpoint")
    )
});

app.listen(3000)