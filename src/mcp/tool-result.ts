/**
 * Shared result shape for MCP tool handlers.
 *
 * Every tool returns both a JSON text block (for clients that only render
 * text) and `structuredContent` (validated against the tool's outputSchema).
 */
export interface ToolResult {
  // Index signature required by the SDK's CallToolResult contract.
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function okResult(payload: object): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    // Boundary cast: the MCP SDK wants an index-signature object; our payloads
    // are strongly-typed domain results.
    structuredContent: payload as Record<string, unknown>,
  };
}
