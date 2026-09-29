require('dotenv').config();
const searchService = require('./search');
const discordActions = require('./discordActions');
const timeService = require('./time');
const memoryService = require('./memory');

/**
 * Service to interact with the Gemini AI model.
 * Uses native fetch to avoid external dependencies.
 */
class AIService {
    constructor() {
        this.apiKey = process.env.GEMINI_API_KEY;
        this.model = 'gemini-2.5-flash';
    }

    /**
     * Generate content from a text prompt.
     * @param {string} prompt The prompt to send to the AI
     * @param {Array} history Optional conversation history
     * @returns {Promise<string>} The response text from the AI
     */
    /**
     * Helper to call Google Gemini generateContent REST API.
     */
    async executeGenerateContent(contents, tools) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
        let systemInstructionText = `You are an AI assistant operating inside Discord.`;
        if (tools) {
            systemInstructionText += `\nYou have access to external tools that provide current information and manage long-term user memories.
You must use the appropriate tool whenever the user's request requires information that may be current, real-time, recent, or time-sensitive.
Never guess current information from your internal knowledge when an appropriate tool is available.

TOOL SELECTION LOGIC:
- IF the user asks for information involving the current date or time (e.g. today's date, current day, current time, current year, today's date/time in India/Asia/Kolkata):
  * Use getCurrentDateTime()
  * Treat the tool result as the authoritative current date/time. Do not manually calculate, estimate, or hardcode today's date.
- ELSE IF the user asks for information that may have changed recently or requires live web information (e.g. latest news, technology versions, company/product details, current prices, market details, recent releases, statistics, or information that may have changed since the model's knowledge was created):
  * Use webSearch(query)
  * Trust the web search results over outdated internal knowledge. Synthesize the returned content and preserve source URLs.
- ELSE (for stable/general questions that do not require current information like "What is Java?", "Explain OOP", "What is inheritance?", "What is MongoDB?"):
  * Do not call any tool; answer directly using your internal knowledge.

If a question requires BOTH current date/time and web information (e.g. "What is the current date and latest AI news?"), use both tools when necessary.

LONG-TERM MEMORY INSTRUCTIONS:
You have access to a persistent, user-isolated long-term memory store.
- If the user explicitly shares details about themselves, their preferences, project description, goals, or tells you to remember something (e.g. "I prefer Python now", "My favorite language is Java", "Remember that my project is a Discord AI Agent"):
  * Call save_memory(key, value, category, importance) or update_memory(key, value) if a memory on this topic already exists. Choose a clean lowercase key identifier.
  * Do NOT save ordinary conversational questions (e.g. "What is Java?", "Explain OOP").
- If the user asks you to "forget" something, or clear their data (e.g. "Forget my favorite language", "Forget everything you know about me"):
  * Call delete_memory(key). Use "everything" or "*all*" as the key to wipe all records for the user.
- If the user references their past preferences, projects, goals, or asks you "what do you know about me?", or if you need past user context to answer a query:
  * Autonomously call search_memory(query) first to retrieve relevant memories.

CONVERSATIONAL BEHAVIOR:
- Tool calls happen internally. Do not output any technical implementation details (such as "I am calling getCurrentDateTime" or "Executing webSearch") to the user. Simply provide the final natural language answer once the tool results are received.
- Do not claim to have searched the web if the webSearch tool was not actually executed.
- If a tool fails, do not fabricate results. Explain to the user that current information could not be retrieved. Do not expose internal details, API keys, or stack traces.

DISCORD ACTION TOOLS:
You also have access to Discord Action Tools (e.g. send_message, create_channel, edit_message). Use them whenever the user requests you to perform an action on the Discord server (like "post this in #general" or "send a message").
For deleting multiple messages (e.g. "Delete the last 10 messages"), ALWAYS follow this workflow: 1. Call fetch_messages to get recent messages. 2. Filter if needed (e.g. by author). 3. Pass their IDs to bulk_delete_messages.
Do not claim an action was completed unless the tool execution actually succeeds.`;
        } else {
            systemInstructionText += `\nProvide helpful, natural, and accurate responses directly using your knowledge base. Tool usage is currently disabled for this interaction.`;
        }

        const requestBody = { 
            contents,
            systemInstruction: {
                parts: [{
                    text: systemInstructionText
                }]
            }
        };
        if (tools) {
            requestBody.tools = tools;
        }

        let attempts = 0;
        const maxAttempts = 3;
        let backoffMs = 1000;
        let rateLimitAttempts = 0;
        const maxRateLimitAttempts = 1; // Only retry 429 once to avoid infinite loops

        while (attempts < maxAttempts) {
            attempts++;
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(requestBody),
                    signal: AbortSignal.timeout(15000) // 15 second timeout
                });

                // If Service Unavailable (503), retry with exponential backoff
                if (response.status === 503 && attempts < maxAttempts) {
                    console.warn(`Gemini API returned 503. Retrying attempt ${attempts} in ${backoffMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                    backoffMs *= 2;
                    continue;
                }

                if (!response.ok) {
                    const errData = await response.json().catch(() => ({}));
                    console.error('Gemini API error status:', response.status, errData);
                    
                    if (response.status === 429) {
                        if (rateLimitAttempts >= maxRateLimitAttempts) {
                            const err = new Error("Gemini API rate limit exceeded. Please wait a moment before trying again.");
                            err.type = "GeminiAPIError";
                            err.status = response.status;
                            err.apiResponse = JSON.stringify(errData);
                            throw err;
                        }
                        rateLimitAttempts++;
                        let waitMs = 30000; // Default 30s
                        const message = errData && errData.error && errData.error.message;
                        if (message) {
                            const match = message.match(/retry in ([\d\.]+)s/i);
                            if (match && match[1]) {
                                waitMs = Math.ceil(parseFloat(match[1]) * 1000) + 1000;
                            }
                        }
                        console.warn(`[Gemini] API returned 429. Automatically waiting ${waitMs}ms before retrying...`);
                        await new Promise(resolve => setTimeout(resolve, waitMs));
                        attempts--; // Do not count 429 wait towards attempts
                        continue;
                    } else if (response.status === 503) {
                        const err = new Error("The AI service is temporarily overloaded or unavailable (503). Please try again shortly.");
                        err.type = "GeminiAPIError";
                        err.status = response.status;
                        err.apiResponse = JSON.stringify(errData);
                        throw err;
                    } else {
                        const err = new Error(`Error from Gemini API: Status ${response.status}. Please check your API key and connection.`);
                        err.type = "GeminiAPIError";
                        err.status = response.status;
                        err.apiResponse = JSON.stringify(errData);
                        throw err;
                    }
                }

                const data = await response.json();
                
                if (data && data.candidates && data.candidates[0] && data.candidates[0].content) {
                    return data.candidates[0].content;
                }

                throw new Error("Received an empty or unexpected response format from the AI service.");
            } catch (error) {
                // If it is our custom error or we reached max attempts, throw it
                if (attempts >= maxAttempts || error.message.includes("Rate limit") || error.message.includes("temporarily overloaded")) {
                    console.error('AIService executeGenerateContent Error:', error);
                    throw error;
                }
                
                // For connection-level network errors, retry
                console.warn(`Network error on attempt ${attempts}. Retrying in ${backoffMs}ms...`, error);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
                backoffMs *= 2;
            }
        }
    }

    /**
     * Generate content from a text prompt.
     * @param {string} prompt The prompt to send to the AI
     * @param {Array} history Optional conversation history
     * @returns {Promise<string>} The response text from the AI
     */
    async generateContent(prompt, history = [], options = {}) {
        if (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.trim() !== '' && process.env.GROQ_API_KEY !== 'your_groq_api_key_here') {
            try {
                return await this.generateContentGroq(prompt, history, options);
            } catch (err) {
                console.warn(`[Failover] Groq API failed (${err.message}). Falling back to Gemini...`);
                // Fall through to Gemini execution
            }
        }

        if (!this.apiKey || this.apiKey === 'your_gemini_api_key_here') {
            throw new Error("AI feature is not configured. Please add a valid `GEMINI_API_KEY` to your `.env` file.");
        }

        console.log(`[Gemini] Processing request`);

        const contents = [];
        
        // Add existing conversation history if provided
        if (history && history.length > 0) {
            contents.push(...history.map(h => ({
                role: h.role,
                parts: h.parts.map(p => {
                    if (p.text) return { text: p.text };
                    if (p.functionCall) return { functionCall: p.functionCall };
                    if (p.functionResponse) return { functionResponse: p.functionResponse };
                    return { text: '' };
                })
            })));
        }

        // Add the new user prompt
        contents.push({
            role: 'user',
            parts: [{ text: prompt }]
        });

        const tools = options.disableTools ? null : [{
            functionDeclarations: [
                {
                    name: 'webSearch',
                    description: "Searches the live web for current information. Use this tool when the user asks for recent, latest, current, real-time, news, or explicitly web-based information.",
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            query: {
                                type: 'STRING',
                                description: "The search query string to run on the web."
                            }
                        },
                        required: ['query']
                    }
                },
                {
                    name: 'getCurrentDateTime',
                    description: "Returns the current date and time using the server clock. Use this tool whenever the user asks for today's date, current date, current time, current day, current year, or other real-time date and time information.",
                    parameters: {
                        type: 'OBJECT',
                        properties: {}
                    }
                },
                {
                    name: 'save_memory',
                    description: "Always save any details the user mentions about their life, trips, plans, or preferences, even if mentioned casually. Extract as much detail as possible to build a comprehensive user profile.",
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            key: {
                                type: 'STRING',
                                description: "The short unique lowercase key identifier for the memory (e.g. 'favorite_language', 'project_name', 'theme_preference')."
                            },
                            value: {
                                type: 'STRING',
                                description: "The actual facts/information/preference text to store."
                            },
                            category: {
                                type: 'STRING',
                                description: "The category classification for this memory.",
                                enum: ['preference', 'profile', 'project', 'goal', 'instruction', 'context', 'other']
                            },
                            importance: {
                                type: 'INTEGER',
                                description: "The scale of importance from 1 (lowest) to 10 (highest). Default is 5."
                            }
                        },
                        required: ['key', 'value']
                    }
                },
                {
                    name: 'search_memory',
                    description: "Searches the user's stored long-term memories using a query term. Use this autonomously when the user references their past preferences, projects, goals, or asks you what you know about them.",
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            query: {
                                type: 'STRING',
                                description: "The search query (keywords) to query the user's memory database."
                            }
                        },
                        required: ['query']
                    }
                },
                {
                    name: 'update_memory',
                    description: "Updates an existing saved memory value for the user when their preferences or details change. Do not create a duplicate key if a memory on the topic already exists.",
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            key: {
                                type: 'STRING',
                                description: "The key of the memory to update."
                            },
                            value: {
                                type: 'STRING',
                                description: "The new value to associate with the key."
                            }
                        },
                        required: ['key', 'value']
                    }
                },
                {
                    name: 'delete_memory',
                    description: "Deletes a saved memory by key, or clears all user memories if the user requests you to forget everything.",
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            key: {
                                type: 'STRING',
                                description: "The key of the memory to delete (e.g. 'favorite_language'). Use 'everything' or '*all*' to wipe all memories for this user."
                            }
                        },
                        required: ['key']
                    }
                },
                {
                    name: 'send_message',
                    description: "Sends a text message to a specific Discord channel.",
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            channelId: { type: 'STRING', description: "The ID or name (e.g. #general) of the channel." },
                            message: { type: 'STRING', description: "The message content." }
                        },
                        required: ['channelId', 'message']
                    }
                },
                {
                    name: 'create_channel',
                    description: "Creates a new Discord channel.",
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            name: { type: 'STRING' },
                            type: { type: 'STRING' }
                        },
                        required: ['name', 'type']
                    }
                },
                {
                    name: 'edit_message',
                    description: "Edits an existing Discord message.",
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            messageId: { type: 'STRING' },
                            content: { type: 'STRING' }
                        },
                        required: ['messageId', 'content']
                    }
                },
                {
                    name: 'delete_message',
                    description: "Deletes a Discord message.",
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            messageId: { type: 'STRING' }
                        },
                        required: ['messageId']
                    }
                },
                {
                    name: 'add_reaction',
                    description: "Adds an emoji reaction to a message.",
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            messageId: { type: 'STRING' },
                            emoji: { type: 'STRING' }
                        },
                        required: ['messageId', 'emoji']
                    }
                },
                {
                    name: 'assign_role',
                    description: "Assigns a role to a server member.",
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            userId: { type: 'STRING' },
                            roleId: { type: 'STRING' }
                        },
                        required: ['userId', 'roleId']
                    }
                },
                {
                    name: 'remove_role',
                    description: "Removes a role from a server member.",
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            userId: { type: 'STRING' },
                            roleId: { type: 'STRING' }
                        },
                        required: ['userId', 'roleId']
                    }
                },
                {
                    name: 'get_server_info',
                    description: "Gets information about the current Discord server.",
                    parameters: {
                        type: 'OBJECT',
                        properties: {}
                    }
                },
                {
                    name: 'get_member_info',
                    description: "Gets information about a specific server member.",
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            userId: { type: 'STRING' }
                        },
                        required: ['userId']
                    }
                },
                {
                    name: 'moderate_message',
                    description: "Analyzes a message for toxicity/spam.",
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            content: { type: 'STRING' }
                        },
                        required: ['content']
                    }
                },
                {
                    name: 'fetch_messages',
                    description: "Fetch recent messages from a Discord channel.",
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            channelId: { type: 'STRING', description: "The ID or name (e.g. #general) of the channel." },
                            limit: { type: 'INTEGER', description: "Number of messages to fetch (max 100)." }
                        },
                        required: ['channelId', 'limit']
                    }
                },
                {
                    name: 'bulk_delete_messages',
                    description: "Delete multiple messages securely. Cannot delete messages older than 14 days.",
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            messageIds: {
                                type: 'ARRAY',
                                items: { type: 'STRING' },
                                description: "Array of message IDs to delete."
                            }
                        },
                        required: ['messageIds']
                    }
                }
            ]
        }];

        let loopCount = 0;
        const maxLoops = 5; // Max 5 tool calls for chaining tools

        while (loopCount < maxLoops) {
            loopCount++;
            
            // Log only for the user /ask tool-calling flow (not classification/formatting)
            const showAskLogs = !options.disableTools;
            
            if (showAskLogs) {
                if (loopCount === 1) {
                    console.log('[ASK 3] Sending request to Gemini');
                } else {
                    console.log('[ASK 8] Sending tool result back to Gemini');
                }
            } else {
                console.log(`[Gemini] Processing request (Attempt ${loopCount})`);
            }
            
            const startGeminiCall = Date.now();
            const content = await this.executeGenerateContent(contents, tools);
            const durationGeminiCall = ((Date.now() - startGeminiCall) / 1000).toFixed(2);
            
            if (showAskLogs) {
                console.log(`[ASK 4] Gemini response received (took ${durationGeminiCall}s)`);
            } else {
                console.log(`[Gemini] Response received (took ${durationGeminiCall}s)`);
            }
            
            if (!content.parts || content.parts.length === 0) {
                throw new Error("Received empty parts from Gemini API.");
            }

            const part = content.parts[0];

            // If Gemini decides to call a tool
            if (part.functionCall) {
                const call = part.functionCall;
                if (showAskLogs) {
                    console.log(`[ASK 5] Tool requested: ${call.name}`);
                }
                
                // Explicit routing: only execute getCurrentDateTime and webSearch
                if (call.name === 'webSearch') {
                    
                    // Validate query argument
                    let query = call.args && call.args.query;
                    let searchResults;
                    
                    if (!query || typeof query !== 'string' || query.trim() === '') {
                        console.error(`[WebSearch] Error: Invalid or missing query argument`);
                        searchResults = [{ error: "Invalid or missing 'query' argument." }];
                    } else {
                        if (showAskLogs) {
                            console.log(`[ASK 6] Executing tool`);
                        }
                        try {
                            searchResults = await searchService.search(query);
                            if (showAskLogs) {
                                console.log(`[ASK 7] Tool completed`);
                            }
                        } catch (err) {
                            console.error(`[WebSearch] Error:`, err.message);
                            searchResults = [{ error: `Search failed: ${err.message}` }];
                            if (showAskLogs) {
                                console.log(`[ASK 7] Tool completed`);
                            }
                        }
                    }

                    // 1. Add model's turn requesting the function call
                    contents.push({
                        role: 'model',
                        parts: [
                            {
                                functionCall: {
                                    name: 'webSearch',
                                    args: { query: query || "" }
                                }
                            }
                        ]
                    });

                    // 2. Add function execution result
                    contents.push({
                        role: 'function',
                        parts: [
                            {
                                functionResponse: {
                                    name: 'webSearch',
                                    response: {
                                        content: searchResults
                                    }
                                }
                            }
                        ]
                    });

                    // Re-run loop to send function response back to Gemini
                    continue;
                } else if (call.name === 'getCurrentDateTime') {
                    if (showAskLogs) {
                        console.log(`[ASK 6] Executing tool`);
                    }
                    
                    let timeResult;
                    try {
                        timeResult = timeService.getCurrentDateTime();
                        if (showAskLogs) {
                            console.log(`[ASK 7] Tool completed`);
                        }
                    } catch (err) {
                        console.error(`[Tool] Error:`, err.message);
                        timeResult = { error: `Time retrieval failed: ${err.message}` };
                        if (showAskLogs) {
                            console.log(`[ASK 7] Tool completed`);
                        }
                    }

                    // 1. Add model's turn requesting the function call
                    contents.push({
                        role: 'model',
                        parts: [
                            {
                                functionCall: {
                                    name: 'getCurrentDateTime',
                                    args: {}
                                }
                            }
                        ]
                    });

                    // 2. Add function execution result
                    contents.push({
                        role: 'function',
                        parts: [
                            {
                                functionResponse: {
                                    name: 'getCurrentDateTime',
                                    response: timeResult
                                }
                            }
                        ]
                    });

                    // Re-run loop to send function response back to Gemini
                    continue;
                } else if (call.name === 'save_memory') {
                    const key = call.args && call.args.key;
                    const value = call.args && call.args.value;
                    const category = (call.args && call.args.category) || 'other';
                    const importance = (call.args && call.args.importance) || 5;

                    if (showAskLogs) console.log(`[ASK 6] Executing tool`);
                    const result = await memoryService.saveMemory(options.userId, options.guildId, key, value, category, importance);
                    if (showAskLogs) console.log(`[ASK 7] Tool completed`);

                    contents.push({
                        role: 'model',
                        parts: [{ functionCall: { name: 'save_memory', args: { key, value, category, importance } } }]
                    });
                    contents.push({
                        role: 'function',
                        parts: [{ functionResponse: { name: 'save_memory', response: result ? { success: true } : { success: false, error: "Failed to save memory" } } }]
                    });
                    continue;
                } else if (call.name === 'search_memory') {
                    const query = call.args && call.args.query;
                    if (showAskLogs) console.log(`[ASK 6] Executing tool`);
                    const memories = await memoryService.searchMemories(options.userId, options.guildId, query);
                    if (showAskLogs) console.log(`[ASK 7] Tool completed`);

                    contents.push({
                        role: 'model',
                        parts: [{ functionCall: { name: 'search_memory', args: { query } } }]
                    });
                    contents.push({
                        role: 'function',
                        parts: [{ functionResponse: { name: 'search_memory', response: { results: memories } } }]
                    });
                    continue;
                } else if (call.name === 'update_memory') {
                    const key = call.args && call.args.key;
                    const value = call.args && call.args.value;

                    if (showAskLogs) console.log(`[ASK 6] Executing tool`);
                    const result = await memoryService.updateMemory(options.userId, options.guildId, key, value);
                    if (showAskLogs) console.log(`[ASK 7] Tool completed`);

                    contents.push({
                        role: 'model',
                        parts: [{ functionCall: { name: 'update_memory', args: { key, value } } }]
                    });
                    contents.push({
                        role: 'function',
                        parts: [{ functionResponse: { name: 'update_memory', response: result ? { success: true } : { success: false, error: "Failed to update memory" } } }]
                    });
                    continue;
                } else if (call.name === 'delete_memory') {

                    const key = call.args && call.args.key;

                    if (showAskLogs) console.log(`[ASK 6] Executing tool`);
                    const result = await memoryService.deleteMemory(options.userId, options.guildId, key);
                    if (showAskLogs) console.log(`[ASK 7] Tool completed`);

                    contents.push({
                        role: 'model',
                        parts: [{ functionCall: { name: 'delete_memory', args: { key } } }]
                    });
                    contents.push({
                        role: 'function',
                        parts: [{ functionResponse: { name: 'delete_memory', response: { success: result } } }]
                    });
                    continue;
                } else if (['send_message', 'create_channel', 'edit_message', 'delete_message', 'add_reaction', 'assign_role', 'remove_role', 'get_server_info', 'get_member_info', 'moderate_message', 'fetch_messages', 'bulk_delete_messages'].includes(call.name)) {
                    if (showAskLogs) console.log(`[ASK 6] Executing tool ${call.name}`);
                    console.log(`[AGENT] Tool selected: ${call.name}`);
                    
                    let result;
                    if (!options.interaction) {
                        result = { success: false, error: "No Discord interaction context available to execute this action." };
                    } else {
                        const args = call.args || {};
                        let params = [];
                        switch (call.name) {
                            case 'send_message': params = [options.interaction, args.channelId, args.message]; break;
                            case 'create_channel': params = [options.interaction, args.name, args.type]; break;
                            case 'edit_message': params = [options.interaction, args.messageId, args.content]; break;
                            case 'delete_message': params = [options.interaction, args.messageId]; break;
                            case 'add_reaction': params = [options.interaction, args.messageId, args.emoji]; break;
                            case 'assign_role': params = [options.interaction, args.userId, args.roleId]; break;
                            case 'remove_role': params = [options.interaction, args.userId, args.roleId]; break;
                            case 'get_server_info': params = [options.interaction]; break;
                            case 'get_member_info': params = [options.interaction, args.userId]; break;
                            case 'moderate_message': params = [options.interaction, args.content]; break;
                            case 'fetch_messages': params = [options.interaction, args.channelId, args.limit]; break;
                            case 'bulk_delete_messages': params = [options.interaction, args.messageIds]; break;
                        }
                        try {
                            result = await discordActions[call.name](...params);
                        } catch (err) {
                            console.error(`[DISCORD] Tool execution failed: ${err.message}`);
                            result = { success: false, error: err.message };
                        }
                    }
                    if (showAskLogs) console.log(`[ASK 7] Tool completed`);
                    
                    contents.push({
                        role: 'model',
                        parts: [{ functionCall: call }]
                    });
                    
                    contents.push({
                        role: 'function',
                        parts: [{ functionResponse: { name: call.name, response: result } }]
                    });
                    continue;
                } else {
                    // Safe explicit routing block for arbitrary function calls
                    console.warn(`[Gemini] Blocked arbitrary tool call attempt: ${call.name}`);
                    
                    contents.push({
                        role: 'model',
                        parts: [{ functionCall: call }]
                    });
                    
                    contents.push({
                        role: 'function',
                        parts: [{
                            functionResponse: {
                                name: call.name,
                                response: { error: `Unsupported tool name: ${call.name}` }
                            }
                        }]
                    });
                    
                    continue;
                }
            }

            // If it returns text content
            if (part.text) {
                if (showAskLogs) {
                    console.log(`[ASK 9] Final Gemini response received`);
                } else {
                    console.log(`[Gemini] Generating final response`);
                }
                return part.text;
            }

            throw new Error("Received an unexpected content response structure (neither text nor functionCall).");
        }

        console.warn("[Gemini] Tool loop limit exceeded.");
        return "I'm sorry, I could not complete your request within the maximum number of steps. Please try simplifying your question.";
    }

    /**
     * Generate content from a text prompt using Groq.
     */
    async generateContentGroq(prompt, history = [], options = {}) {
        console.log(`[Groq] Processing request`);

        let systemInstruction = `You are a helpful AI assistant in Discord.`;
        if (!options.disableTools) {
            systemInstruction += ` You have tools for web search, current time, memory, and Discord Action Tools (like send_message). Only use webSearch for recent/live data. Only use getCurrentDateTime for time queries. Use Discord Action Tools when requested to perform server actions. For deleting multiple messages, ALWAYS use fetch_messages first, then pass the extracted IDs to bulk_delete_messages. Otherwise, answer directly. Do not claim to have completed an action unless the tool succeeds. Keep answers concise.`;
        } else {
            systemInstruction += ` Provide helpful responses directly.`;
        }

        const messages = [
            { role: 'system', content: systemInstruction }
        ];

        // Reduce history to last 4 messages to save tokens
        const recentHistory = history && history.length > 0 ? history.slice(-4) : [];
        if (recentHistory.length > 0) {
            for (const h of recentHistory) {
                const role = h.role === 'model' ? 'assistant' : (h.role === 'function' ? 'tool' : 'user');
                for (const part of h.parts) {
                    if (part.text) {
                        messages.push({ role, content: part.text });
                    } else if (part.functionCall) {
                        messages.push({
                            role: 'assistant',
                            tool_calls: [{
                                id: part.functionCall.id || `call_${Math.random().toString(36).substring(2, 11)}`,
                                type: 'function',
                                function: {
                                    name: part.functionCall.name,
                                    arguments: JSON.stringify(part.functionCall.args || {})
                                }
                            }]
                        });
                    } else if (part.functionResponse) {
                        messages.push({
                            role: 'tool',
                            tool_call_id: part.functionResponse.id || `call_${Math.random().toString(36).substring(2, 11)}`,
                            name: part.functionResponse.name,
                            content: typeof part.functionResponse.response === 'string' ? part.functionResponse.response : JSON.stringify(part.functionResponse.response)
                        });
                    }
                }
            }
        }

        // Add user prompt
        messages.push({ role: 'user', content: prompt });

        let loopCount = 0;
        const maxLoops = 3;
        let toolCallCount = 0;
        const showAskLogs = !options.disableTools;

        while (loopCount < maxLoops) {
            loopCount++;
            console.log(`[Groq] Processing request (Loop ${loopCount})`);
            const startCall = Date.now();
            
            let res;
            let data;
            let fetchAttempts = 0;
            let backoffMs = 1000;
            
            while (fetchAttempts < 3) {
                fetchAttempts++;
                try {
                    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
                        },
                        body: JSON.stringify({
                            model: 'groq/compound',
                            messages,
                            max_tokens: 300,
                            tools: options.disableTools ? undefined : [
                                { type: 'function', function: { name: 'webSearch', description: "Searches the live web.", parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
                                { type: 'function', function: { name: 'getCurrentDateTime', description: "Returns current date and time.", parameters: { type: 'object', properties: {} } } },
                                { type: 'function', function: { name: 'save_memory', description: "Always save any details the user mentions about their life, trips, plans, or preferences, even if casually mentioned.", parameters: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' }, category: { type: 'string' }, importance: { type: 'integer' } }, required: ['key', 'value'] } } },
                                { type: 'function', function: { name: 'search_memory', description: "Searches memories.", parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
                                { type: 'function', function: { name: 'update_memory', description: "Updates a memory.", parameters: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] } } },
                                { type: 'function', function: { name: 'delete_memory', description: "Deletes a memory.", parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } } },
                                { type: 'function', function: { name: 'send_message', description: "Sends a text message to a specific Discord channel.", parameters: { type: 'object', properties: { channelId: { type: 'string' }, message: { type: 'string' } }, required: ['channelId', 'message'] } } },
                                { type: 'function', function: { name: 'create_channel', description: "Creates a new Discord channel.", parameters: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' } }, required: ['name', 'type'] } } },
                                { type: 'function', function: { name: 'edit_message', description: "Edits an existing Discord message.", parameters: { type: 'object', properties: { messageId: { type: 'string' }, content: { type: 'string' } }, required: ['messageId', 'content'] } } },
                                { type: 'function', function: { name: 'delete_message', description: "Deletes a Discord message.", parameters: { type: 'object', properties: { messageId: { type: 'string' } }, required: ['messageId'] } } },
                                { type: 'function', function: { name: 'add_reaction', description: "Adds an emoji reaction to a message.", parameters: { type: 'object', properties: { messageId: { type: 'string' }, emoji: { type: 'string' } }, required: ['messageId', 'emoji'] } } },
                                { type: 'function', function: { name: 'assign_role', description: "Assigns a role to a server member.", parameters: { type: 'object', properties: { userId: { type: 'string' }, roleId: { type: 'string' } }, required: ['userId', 'roleId'] } } },
                                { type: 'function', function: { name: 'remove_role', description: "Removes a role from a server member.", parameters: { type: 'object', properties: { userId: { type: 'string' }, roleId: { type: 'string' } }, required: ['userId', 'roleId'] } } },
                                { type: 'function', function: { name: 'get_server_info', description: "Gets information about the current Discord server.", parameters: { type: 'object', properties: {} } } },
                                { type: 'function', function: { name: 'get_member_info', description: "Gets information about a specific server member.", parameters: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] } } },
                                { type: 'function', function: { name: 'moderate_message', description: "Analyzes a message for toxicity/spam.", parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } } },
                                { type: 'function', function: { name: 'fetch_messages', description: "Fetch recent messages from a Discord channel.", parameters: { type: 'object', properties: { channelId: { type: 'string' }, limit: { type: 'integer' } }, required: ['channelId', 'limit'] } } },
                                { type: 'function', function: { name: 'bulk_delete_messages', description: "Delete multiple messages securely. Cannot delete messages older than 14 days.", parameters: { type: 'object', properties: { messageIds: { type: 'array', items: { type: 'string' } } }, required: ['messageIds'] } } },
                            ],
                            tool_choice: options.disableTools ? undefined : 'auto'
                        }),
                        signal: AbortSignal.timeout(15000)
                    });

                    if (res.status === 429 || res.status >= 500) {
                        if (fetchAttempts >= 3) {
                            const errText = await res.text();
                            const apiErr = new Error(`Groq API error Status ${res.status}: ${errText}`);
                            apiErr.type = "GroqAPIError";
                            apiErr.status = res.status;
                            apiErr.apiResponse = errText;
                            throw apiErr;
                        }
                        const retryAfter = res.headers.get('retry-after') 
                            || res.headers.get('x-ratelimit-reset-requests')
                            || res.headers.get('x-ratelimit-reset-tokens');
                            
                        let delay = backoffMs;
                        if (retryAfter) {
                            const parsed = parseFloat(retryAfter);
                            if (!isNaN(parsed)) {
                                // Sometimes reset is in seconds, sometimes formatted weirdly. Assume seconds.
                                delay = Math.max(parsed * 1000, backoffMs);
                            }
                        } else {
                            try {
                                const errBody = await res.clone().json();
                                const message = errBody?.error?.message;
                                if (message) {
                                    const match = message.match(/retry in ([\d\.]+)s/i);
                                    if (match && match[1]) {
                                        delay = Math.max(parseFloat(match[1]) * 1000 + 100, backoffMs);
                                    }
                                }
                            } catch (e) {}
                        }
                        
                        console.warn(`[Groq] API Error ${res.status}. Retrying in ${delay}ms...`);
                        await new Promise(r => setTimeout(r, delay));
                        backoffMs *= 2;
                        continue;
                    }
                    
                    if (!res.ok) {
                        const errText = await res.text();
                        const apiErr = new Error(`Groq API error Status ${res.status}: ${errText}`);
                        apiErr.type = "GroqAPIError";
                        apiErr.status = res.status;
                        apiErr.apiResponse = errText;
                        throw apiErr;
                    }

                    data = await res.json();
                    break;
                } catch (err) {
                    if (fetchAttempts >= 3) throw err;
                    console.warn(`[Groq] Network error: ${err.message}. Retrying in ${backoffMs}ms...`);
                    await new Promise(r => setTimeout(r, backoffMs));
                    backoffMs *= 2;
                }
            }

            const message = data.choices[0].message;
            const duration = ((Date.now() - startCall) / 1000).toFixed(2);
            
            if (data.usage) {
                console.log(`[Groq] Token Usage - Prompt: ${data.usage.prompt_tokens}, Completion: ${data.usage.completion_tokens}, Total: ${data.usage.total_tokens}`);
            }
            console.log(`[Groq] Response received (took ${duration}s)`);

            // If Groq decides to call a tool
            if (message.tool_calls && message.tool_calls.length > 0) {
                toolCallCount++;
                if (toolCallCount > 4) {
                    console.warn("[Groq] Strict max tool call limit reached (4). Forcing text response.");
                    return "I couldn't process this fully. Please try again or be more specific.";
                }
                const toolCall = message.tool_calls[0];
                const callName = toolCall.function.name;
                const callArgs = JSON.parse(toolCall.function.arguments || '{}');

                if (showAskLogs) {
                    console.log(`[ASK 5] Tool requested: ${callName}`);
                }

                // Add assistant message requesting tool calls
                messages.push(message);

                let result;
                if (callName === 'webSearch') {
                    const query = callArgs.query;
                    if (!query || typeof query !== 'string' || query.trim() === '') {
                        result = { error: "Invalid or missing 'query' argument." };
                    } else {
                        if (showAskLogs) console.log(`[ASK 6] Executing tool`);
                        try {
                            result = await searchService.search(query);
                            if (showAskLogs) console.log(`[ASK 7] Tool completed`);
                        } catch (err) {
                            console.error(`[WebSearch] Error:`, err.message);
                            result = { error: `Search failed: ${err.message}` };
                            if (showAskLogs) console.log(`[ASK 7] Tool completed`);
                        }
                    }
                } else if (callName === 'getCurrentDateTime') {
                    if (showAskLogs) console.log(`[ASK 6] Executing tool`);
                    try {
                        result = timeService.getCurrentDateTime();
                        if (showAskLogs) console.log(`[ASK 7] Tool completed`);
                    } catch (err) {
                        console.error(`[Tool] Error:`, err.message);
                        result = { error: `Time retrieval failed: ${err.message}` };
                        if (showAskLogs) console.log(`[ASK 7] Tool completed`);
                    }
                } else if (callName === 'save_memory') {
                    const key = callArgs.key;
                    const value = callArgs.value;
                    const category = callArgs.category || 'other';
                    const importance = callArgs.importance || 5;

                    if (showAskLogs) console.log(`[ASK 6] Executing tool`);
                    const res = await memoryService.saveMemory(options.userId, options.guildId, key, value, category, importance);
                    if (showAskLogs) console.log(`[ASK 7] Tool completed`);
                    result = res ? { success: true } : { success: false, error: "Failed to save memory" };
                } else if (callName === 'search_memory') {
                    const query = callArgs.query;
                    if (showAskLogs) console.log(`[ASK 6] Executing tool`);
                    const memories = await memoryService.searchMemories(options.userId, options.guildId, query);
                    if (showAskLogs) console.log(`[ASK 7] Tool completed`);
                    result = { results: memories };
                } else if (callName === 'update_memory') {
                    const key = callArgs.key;
                    const value = callArgs.value;

                    if (showAskLogs) console.log(`[ASK 6] Executing tool`);
                    const res = await memoryService.updateMemory(options.userId, options.guildId, key, value);
                    if (showAskLogs) console.log(`[ASK 7] Tool completed`);
                    result = res ? { success: true } : { success: false, error: "Failed to update memory" };
                } else if (callName === 'delete_memory') {
                    const key = callArgs.key;

                    if (showAskLogs) console.log(`[ASK 6] Executing tool`);
                    const res = await memoryService.deleteMemory(options.userId, options.guildId, key);
                    if (showAskLogs) console.log(`[ASK 7] Tool completed`);
                    result = { success: res };
                } else if (['send_message', 'create_channel', 'edit_message', 'delete_message', 'add_reaction', 'assign_role', 'remove_role', 'get_server_info', 'get_member_info', 'moderate_message', 'fetch_messages', 'bulk_delete_messages'].includes(callName)) {
                    if (showAskLogs) console.log(`[ASK 6] Executing tool ${callName}`);
                    console.log(`[AGENT] Tool selected: ${callName}`);
                    
                    if (!options.interaction) {
                        result = { success: false, error: "No Discord interaction context available to execute this action." };
                    } else {
                        let params = [];
                        switch (callName) {
                            case 'send_message': params = [options.interaction, callArgs.channelId, callArgs.message]; break;
                            case 'create_channel': params = [options.interaction, callArgs.name, callArgs.type]; break;
                            case 'edit_message': params = [options.interaction, callArgs.messageId, callArgs.content]; break;
                            case 'delete_message': params = [options.interaction, callArgs.messageId]; break;
                            case 'add_reaction': params = [options.interaction, callArgs.messageId, callArgs.emoji]; break;
                            case 'assign_role': params = [options.interaction, callArgs.userId, callArgs.roleId]; break;
                            case 'remove_role': params = [options.interaction, callArgs.userId, callArgs.roleId]; break;
                            case 'get_server_info': params = [options.interaction]; break;
                            case 'get_member_info': params = [options.interaction, callArgs.userId]; break;
                            case 'moderate_message': params = [options.interaction, callArgs.content]; break;
                            case 'fetch_messages': params = [options.interaction, callArgs.channelId, callArgs.limit]; break;
                            case 'bulk_delete_messages': params = [options.interaction, callArgs.messageIds]; break;
                        }
                        try {
                            result = await discordActions[callName](...params);
                        } catch (err) {
                            console.error(`[DISCORD] Tool execution failed: ${err.message}`);
                            result = { success: false, error: err.message };
                        }
                    }
                    if (showAskLogs) console.log(`[ASK 7] Tool completed`);
                } else {
                    result = { error: `Unsupported tool name: ${callName}` };
                }

                // Add tool result to messages
                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    name: callName,
                    content: JSON.stringify(result)
                });

                continue;
            }

            if (message.content) {
                if (showAskLogs) {
                    console.log(`[ASK 9] Final Gemini response received`);
                }
                return message.content;
            }
        }

        console.warn("[Groq] Tool loop limit exceeded.");
        return "I'm sorry, I could not complete your request within the maximum number of steps. Please try simplifying your question.";
    }

    /**
     * Generate an image from a text prompt using Imagen 3.
     * @param {string} prompt The description of the image to generate
     * @param {object} options Additional settings such as aspectRatio
     * @returns {Promise<Buffer>} The image data buffer
     */
    async generateImage(prompt, options = {}) {
        if (!this.apiKey || this.apiKey === 'your_gemini_api_key_here') {
            throw new Error("AI feature is not configured. Please add a valid `GEMINI_API_KEY` to your `.env` file.");
        }

        const model = 'imagen-4.0-generate-001';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${this.apiKey}`;

        const payload = {
            instances: [
                { prompt: prompt }
            ],
            parameters: {
                sampleCount: 1,
                aspectRatio: options.aspectRatio || "1:1",
                outputMimeType: "image/png"
            }
        };

        let attempts = 0;
        const maxAttempts = 3;
        let backoffMs = 1000;

        while (attempts < maxAttempts) {
            attempts++;
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload),
                    signal: AbortSignal.timeout(15000) // 15 second timeout
                });

                // If Service Unavailable (503), retry with exponential backoff
                if (response.status === 503 && attempts < maxAttempts) {
                    console.warn(`Gemini API returned 503. Retrying attempt ${attempts} in ${backoffMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                    backoffMs *= 2;
                    continue;
                }

                if (!response.ok) {
                    const errData = await response.json().catch(() => ({}));
                    console.error('Gemini API image generation error status:', response.status, errData);
                    
                    if (errData.error && errData.error.message && errData.error.message.includes("paid plans")) {
                        throw new Error("Image generation is only available on paid plans in Google AI Studio. Please upgrade your Google AI Studio project to enable billing.");
                    }
                    
                    if (response.status === 429) {
                        throw new Error("Rate limit exceeded (Too Many Requests). Please wait a moment before trying again.");
                    } else if (response.status === 503) {
                        throw new Error("The AI service is temporarily overloaded or unavailable (503). Please try again shortly.");
                    } else {
                        throw new Error(`Error from Gemini API: Status ${response.status}. Please check your API key and connection.`);
                    }
                }

                const data = await response.json();
                
                if (
                    data &&
                    data.predictions &&
                    data.predictions[0] &&
                    data.predictions[0].bytesBase64Encoded
                ) {
                    return Buffer.from(data.predictions[0].bytesBase64Encoded, 'base64');
                }

                throw new Error("Received an empty or unexpected response format from the AI image generation service.");
            } catch (error) {
                // If it is our custom error or we reached max attempts, throw it
                if (attempts >= maxAttempts || error.message.includes("Rate limit") || error.message.includes("temporarily overloaded")) {
                    console.error('AIService generateImage Error:', error);
                    throw error;
                }
                
                // For connection-level network errors, retry
                console.warn(`Network error on attempt ${attempts}. Retrying in ${backoffMs}ms...`, error);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
                backoffMs *= 2;
            }
        }
    }
}

module.exports = new AIService();
