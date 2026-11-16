/**
 * castnotes core: a forwarding client for the hosted Dom
 * Kozak knowledge MCP server.
 *
 * No podcast or lesson data lives on this machine.
 * tools/list is answered from the literal definitions
 * below, which reproduce a live capture of the upstream
 * server word for word (name, title, description and
 * inputSchema exactly as captured, including the two
 * tools whose inputSchema carries no `required` key). A
 * tools/call travels upstream over a streamable-HTTP
 * JSON-RPC session: an initialize POST, a
 * notifications/initialized POST, then the tools/call
 * POST, carrying the Mcp-Session-Id response header on
 * later requests when the upstream issues one. The
 * session opens lazily on the first forwarded call and
 * is reused for the client's lifetime.
 *
 * The endpoint is pinned to https://mcp.domkozak.com/mcp
 * and may be replaced with the DOMKOZAK_MCP_URL
 * environment variable (that override is a labelled
 * reconstruction). The registry record declares no auth
 * headers for the upstream and the capture was taken
 * keyless, so this client never sends an Authorization
 * or X-API-Key header.
 *
 * A successful upstream result is returned exactly as
 * received, isError flag and extra fields included.
 * Failures — an upstream JSON-RPC error, a non-2xx
 * status, a body that cannot be parsed, or a fetch
 * that throws or times out — become an isError result
 * whose text begins with `castnotes error:` (that
 * rendering is a labelled reconstruction). Replies may
 * be plain JSON or SSE (`data:` lines); the JSON-RPC
 * message whose id matches the request wins.
 */
import type {
  FetchFn,
  FetchResponseLike,
  ForwardDeps,
  ToolArgs,
  ToolDef,
  ToolResult,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_ENDPOINT_URL = "https://mcp.domkozak.com/mcp";

export const DEFAULT_TIMEOUT_MS = 30000;

export const PROTOCOL_VERSION = "2025-03-26";

/* ------------------------------------------------------------------ */
/* Tool definitions (tools/list literals, verbatim from the live       */
/* capture in harness/fixtures/domkozak-tools-original.json;           */
/* generated programmatically by parsing and re-serialising the        */
/* fixture JSON, never retyped)                                        */
/* ------------------------------------------------------------------ */

export const TOOL_DEFS: ToolDef[] = [
  {
    "name": "search_podcast",
    "title": "Search the Built for MENA podcast",
    "description": "Full-text search over Built for MENA episode transcripts. Returns up to `limit` (max 10)\npassages of about 120 words, each with episode number, title, guest, timestamp (mm:ss in the\npublished audio), episode link and speaker. Speaker is named only when the voice match is certain;\notherwise it is \"\" and speaker_note says \"speaker not confirmed: Dom Kozak (host) or <guest>\".",
    "inputSchema": {
      "properties": {
        "query": {
          "description": "Search text matched against episode transcripts",
          "title": "Query",
          "type": "string"
        },
        "limit": {
          "description": "Maximum number of passages to return",
          "default": 5,
          "title": "Limit",
          "type": "integer"
        }
      },
      "required": [
        "query"
      ],
      "type": "object",
      "title": "search_podcastArguments"
    }
  },
  {
    "name": "list_episodes",
    "title": "List Built for MENA episodes",
    "description": "Every published Built for MENA episode (trailer excluded), newest first, with number, title,\nguest, company, release date, length, link and whether its transcript is searchable yet.",
    "inputSchema": {
      "properties": {},
      "type": "object",
      "title": "list_episodesArguments"
    }
  },
  {
    "name": "get_episode",
    "title": "Get one Built for MENA episode",
    "description": "One Built for MENA episode by number (e.g. \"10\") or \"special\" for The Story So Far: title, guest,\ncompany, date, length, link, and up to 5 key passages (about 120 words each) in order. Never the full\ntranscript: use search_podcast to find specific quotes.",
    "inputSchema": {
      "properties": {
        "episode": {
          "description": "Episode number, or \"special\" for The Story So Far",
          "title": "Episode",
          "type": "string"
        }
      },
      "required": [
        "episode"
      ],
      "type": "object",
      "title": "get_episodeArguments"
    }
  },
  {
    "name": "explain_pdooh",
    "title": "Explain a pDOOH concept from Dom Kozak's lessons",
    "description": "Plain-English explanations of programmatic digital out of home (pDOOH) from Dom Kozak's released\npDOOH 101 and 201 lessons. Returns up to `limit` (max 10) passages with series (101/201), episode,\nlesson title, hook, airDate, the relevant lesson text and the lesson URL on domkozak.com.",
    "inputSchema": {
      "properties": {
        "topic": {
          "description": "pDOOH topic to explain",
          "title": "Topic",
          "type": "string"
        },
        "limit": {
          "description": "Maximum number of passages to return",
          "default": 3,
          "title": "Limit",
          "type": "integer"
        }
      },
      "required": [
        "topic"
      ],
      "type": "object",
      "title": "explain_pdoohArguments"
    }
  },
  {
    "name": "list_lessons",
    "title": "List Dom Kozak's pDOOH lessons",
    "description": "Released pDOOH 101 and 201 lessons, in order, with series, episode, title, hook, airDate and URL.",
    "inputSchema": {
      "properties": {},
      "type": "object",
      "title": "list_lessonsArguments"
    }
  }
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

/** Whether `name` belongs to the captured surface. */
export function isKnownTool(name: string): boolean {
  return TOOL_NAMES.includes(name);
}

/* ------------------------------------------------------------------ */
/* Forwarding client                                                   */
/* ------------------------------------------------------------------ */

function errorResult(detail: string): ToolResult {
  return {
    content: [{ type: "text", text: `castnotes error: ${detail}` }],
    isError: true,
  };
}

function rpcErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * Read a JSON-RPC response body, tolerating SSE framing.
 * Returns the message whose id matches `expectedId` when
 * present, otherwise the last parseable message, otherwise
 * null when nothing in the body parses.
 */
export function parseRpcBody(
  text: string,
  expectedId?: number,
): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const candidates: Record<string, unknown>[] = [];
  const tryPush = (payload: string): void => {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not a JSON payload; skip this candidate.
    }
  };
  if (trimmed.includes("data:")) {
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice("data:".length).trim();
      if (payload !== "" && payload !== "[DONE]") tryPush(payload);
    }
  } else {
    tryPush(trimmed);
  }
  if (candidates.length === 0) return null;
  if (expectedId !== undefined) {
    const match = candidates.find((c) => c.id === expectedId);
    if (match !== undefined) return match;
  }
  return candidates[candidates.length - 1];
}

async function defaultFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<FetchResponseLike> {
  return fetch(url, init) as unknown as FetchResponseLike;
}

/**
 * A forwarding client holding a single upstream session,
 * opened lazily on first use and reused from then on
 * (for the process lifetime in the MCP server, or for a
 * single invocation in the CLI).
 */
export class CastnotesClient {
  private readonly deps: ForwardDeps;
  private sessionId: string | null = null;
  private ready = false;
  private sessionPromise: Promise<void> | null = null;
  private idCounter = 0;

  constructor(deps: ForwardDeps = {}) {
    this.deps = deps;
  }

  private fetchFn(): FetchFn {
    return this.deps.fetchFn ?? defaultFetch;
  }

  private endpointUrl(): string {
    if (this.deps.url && this.deps.url.trim() !== "") return this.deps.url.trim();
    const raw = (this.deps.env ?? process.env).DOMKOZAK_MCP_URL;
    if (raw && raw.trim() !== "") return raw.trim();
    return DEFAULT_ENDPOINT_URL;
  }

  private timeoutMs(): number {
    if (typeof this.deps.timeoutMs === "number" && this.deps.timeoutMs > 0) {
      return this.deps.timeoutMs;
    }
    return DEFAULT_TIMEOUT_MS;
  }

  private nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  private async post(
    body: unknown,
    withSession: boolean,
  ): Promise<FetchResponseLike> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (withSession && this.sessionId !== null) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      return await this.fetchFn()(this.endpointUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.ready) return;
    if (this.sessionPromise === null) {
      this.sessionPromise = (async () => {
        const initId = this.nextId();
        const initRes = await this.post(
          {
            jsonrpc: "2.0",
            id: initId,
            method: "initialize",
            params: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "castnotes", version: VERSION },
            },
          },
          false,
        );
        const sessionId = initRes.headers.get("mcp-session-id");
        if (sessionId) this.sessionId = sessionId;
        const initText = await initRes.text();
        const initParsed = parseRpcBody(initText, initId);
        if (initParsed !== null && initParsed.error) {
          throw new Error(rpcErrorMessage(initParsed.error));
        }
        if (initRes.status < 200 || initRes.status >= 300) {
          throw new Error(`HTTP ${initRes.status}`);
        }
        if (initParsed === null && initText.trim() !== "") {
          throw new Error("malformed response");
        }
        const initializedRes = await this.post(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          true,
        );
        try {
          await initializedRes.text();
        } catch {
          // Nothing needed from the notification response body.
        }
        this.ready = true;
      })();
    }
    try {
      await this.sessionPromise;
    } catch (err) {
      this.sessionPromise = null;
      this.sessionId = null;
      throw err;
    }
  }

  /** Forward one tool call; upstream failures come back as isError results. */
  async callTool(name: string, args: ToolArgs): Promise<ToolResult> {
    try {
      await this.ensureSession();
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }

    const callId = this.nextId();
    let callRes: FetchResponseLike;
    try {
      callRes = await this.post(
        {
          jsonrpc: "2.0",
          id: callId,
          method: "tools/call",
          params: { name, arguments: args ?? {} },
        },
        true,
      );
    } catch (err) {
      return errorResult(
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = parseRpcBody(await callRes.text(), callId);
    if (parsed !== null && parsed.error) {
      return errorResult(rpcErrorMessage(parsed.error));
    }
    if (callRes.status < 200 || callRes.status >= 300) {
      return errorResult(`HTTP ${callRes.status}`);
    }
    if (parsed === null) return errorResult("malformed response");
    const result = parsed.result as ToolResult | undefined;
    if (result === undefined || result === null || typeof result !== "object") {
      return errorResult("malformed response");
    }
    // Hand the upstream result back exactly as received.
    return result;
  }
}

/** Build a forwarding client; tests inject a fake fetch and env through deps. */
export function createClient(deps: ForwardDeps = {}): CastnotesClient {
  return new CastnotesClient(deps);
}

/** One-shot helper: a fresh client for a single call (the CLI path). */
export async function callTool(
  name: string,
  args: ToolArgs,
  deps: ForwardDeps = {},
): Promise<ToolResult> {
  return new CastnotesClient(deps).callTool(name, args);
}
