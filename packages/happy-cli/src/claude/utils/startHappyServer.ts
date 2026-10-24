/**
 * Happy MCP server
 * Provides Happy CLI specific tools including chat session title management
 *
 * Uses stateless StreamableHTTP: each request gets a fresh McpServer + transport.
 * This is required by MCP SDK >=1.27 which rejects reuse of an already-connected transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { randomUUID } from "node:crypto";
import { HumanInterventionInputSchema } from '@slopus/happy-wire';
import type { PushNotificationClient } from '@/api/pushNotifications';
import { HumanInterventionHandler } from './humanIntervention';

function createMcpServer(handler: (title: string) => Promise<{ success: boolean; error?: string }>, intervention: HumanInterventionHandler): McpServer {
    const mcp = new McpServer({
        name: "Happy MCP",
        version: "1.0.0",
    });

    mcp.registerTool('change_title', {
        description: 'Change the title of the current chat session',
        title: 'Change Chat Title',
        inputSchema: {
            title: z.string().describe('The new title for the chat session'),
        },
    }, async (args) => {
        const response = await handler(args.title);
        logger.debug('[happyMCP] Response:', response);

        if (response.success) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Successfully changed chat title to: "${args.title}"`,
                    },
                ],
                isError: false,
            };
        } else {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to change chat title: ${response.error || 'Unknown error'}`,
                    },
                ],
                isError: true,
            };
        }
    });

    mcp.registerTool('request_human_intervention', {
        description: 'Notify the user that work is blocked by a confirmed local OS action (sudo password, Windows UAC, or another manual step). Do not include passwords or secrets. After calling, end the turn and wait for the user follow-up.',
        inputSchema: HumanInterventionInputSchema.shape,
    }, async (args) => {
        try {
            return { content: [{ type: 'text' as const, text: JSON.stringify(await intervention.request(args)) }] };
        } catch (error) {
            return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
        }
    });

    return mcp;
}

export async function startHappyServer(client: ApiSessionClient, push?: Pick<PushNotificationClient, 'sendSessionNotification'>) {
    logger.debug(`[happyMCP] server:start sessionId=${client.sessionId}`);

    const handler = async (title: string) => {
        logger.debug('[happyMCP] Changing title to:', title);
        try {
            client.sendClaudeSessionMessage({
                type: 'summary',
                summary: title,
                leafUuid: randomUUID()
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    };

    const intervention = new HumanInterventionHandler(client, push);
    const server = createServer(async (req, res) => {
        const mcp = createMcpServer(handler, intervention);
        try {
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined
            });
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
            res.on('close', () => {
                transport.close();
                mcp.close();
            });
        } catch (error) {
            logger.debug("Error handling request:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
            mcp.close();
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    logger.debug(`[happyMCP] server:ready sessionId=${client.sessionId} url=${baseUrl.toString()}`);

    return {
        url: baseUrl.toString(),
        toolNames: ['change_title', 'request_human_intervention'],
        stop: () => {
            logger.debug(`[happyMCP] server:stop sessionId=${client.sessionId}`);
            intervention.dispose();
            server.close();
        }
    }
}
