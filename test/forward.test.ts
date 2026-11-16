import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  CastnotesClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real domkozak endpoint is
 * never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/domkozak-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/** Recursively strip `description` fields (tool- and parameter-level).
 * Ruling 1 (2026-11-04): the served tools carry parameter descriptions
 * added over the original capture; everything else must match exactly. */
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k !== "description") out[k] = stripDescriptions(v);
    }
    return out;
  }
  return value;
}
/**
 * Publish-survival guard (Wave 25 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const SEARCH = "search_podcast";
const EPISODES = "list_episodes";
const EPISODE = "get_episode";
const PDOOH = "explain_pdooh";
const LESSONS = "list_lessons";
const ALL_TOOLS = [SEARCH, EPISODES, EPISODE, PDOOH, LESSONS];

const SAMPLE_RESULT = {
  content: [
    {
      type: "text",
      text: "{\"episode\":10,\"passages\":[{\"speaker\":\"Dom Kozak\",\"text\":\"distribution beats product\"}]}",
    },
  ],
  structuredContent: { episode: 10, passages: 1 },
};

const SAMPLE_ARGS = { query: "distribution", limit: 3 };

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-abc" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "domkozak-knowledge", version: "1.0.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new CastnotesClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

function toolByName(name: string): ToolDef {
  const tool = TOOL_DEFS.find((t) => t.name === name);
  assert.ok(tool !== undefined, `tool ${name} served`);
  return tool;
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 5 tools, deep-equal, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 5);
    assert.deepEqual(stripDescriptions(TOOL_DEFS), stripDescriptions(fixture.tools));
  });

  it("serves the 5 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, ALL_TOOLS);
  });

  it("carries exactly the fixture's keys on every tool", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
    }
  });

  it("carries every fixture title verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(toolByName(SEARCH).title, "Search the Built for MENA podcast");
    assert.equal(toolByName(EPISODES).title, "List Built for MENA episodes");
    assert.equal(toolByName(EPISODE).title, "Get one Built for MENA episode");
    assert.equal(
      toolByName(PDOOH).title,
      "Explain a pDOOH concept from Dom Kozak's lessons",
    );
    assert.equal(toolByName(LESSONS).title, "List Dom Kozak's pDOOH lessons");
    for (let i = 0; i < ALL_TOOLS.length; i += 1) {
      assert.equal(TOOL_DEFS[i].title, fixture.tools[i].title);
      assert.equal(TOOL_DEFS[i].description, fixture.tools[i].description);
    }
  });

  it("requires exactly query on search_podcast", () => {
    assert.deepEqual(schemaOf(toolByName(SEARCH)).required, ["query"]);
  });

  it("requires exactly episode on get_episode", () => {
    assert.deepEqual(schemaOf(toolByName(EPISODE)).required, ["episode"]);
  });

  it("requires exactly topic on explain_pdooh", () => {
    assert.deepEqual(schemaOf(toolByName(PDOOH)).required, ["topic"]);
  });

  it("list_episodes carries NO required key, served verbatim", () => {
    const schema = schemaOf(toolByName(EPISODES));
    assert.equal("required" in schema, false);
    assert.equal(schema.required, undefined);
    assert.deepEqual(schema.properties, {});
  });

  it("list_lessons carries NO required key, served verbatim", () => {
    const schema = schemaOf(toolByName(LESSONS));
    assert.equal("required" in schema, false);
    assert.equal(schema.required, undefined);
    assert.deepEqual(schema.properties, {});
  });

  it("carries object type and the fixture's schema titles", () => {
    for (const tool of TOOL_DEFS) {
      const schema = schemaOf(tool);
      assert.equal(schema.type, "object");
      assert.equal("$schema" in schema, false);
    }
    assert.equal(schemaOf(toolByName(SEARCH)).title, "search_podcastArguments");
    assert.equal(schemaOf(toolByName(EPISODES)).title, "list_episodesArguments");
    assert.equal(schemaOf(toolByName(EPISODE)).title, "get_episodeArguments");
    assert.equal(schemaOf(toolByName(PDOOH)).title, "explain_pdoohArguments");
    assert.equal(schemaOf(toolByName(LESSONS)).title, "list_lessonsArguments");
  });

  it("carries every fixture property, in order, for each tool", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < ALL_TOOLS.length; i += 1) {
      const served = Object.keys(schemaOf(TOOL_DEFS[i]).properties);
      const expected = Object.keys(schemaOf(fixture.tools[i]).properties);
      assert.deepEqual(served, expected);
    }
    assert.deepEqual(
      Object.keys(schemaOf(toolByName(SEARCH)).properties),
      ["query", "limit"],
    );
    assert.deepEqual(
      Object.keys(schemaOf(toolByName(PDOOH)).properties),
      ["topic", "limit"],
    );
  });

  it("carries the argument shapes and defaults verbatim", () => {
    const search = schemaOf(toolByName(SEARCH)).properties;
    assert.equal(search.query.type, "string");
    assert.equal(search.limit.type, "integer");
    assert.equal(search.limit.default, 5);
    const pdooh = schemaOf(toolByName(PDOOH)).properties;
    assert.equal(pdooh.topic.type, "string");
    assert.equal(pdooh.limit.type, "integer");
    assert.equal(pdooh.limit.default, 3);
    const episode = schemaOf(toolByName(EPISODE)).properties;
    assert.equal(episode.episode.type, "string");
  });

  it("isKnownTool recognises all 5 built tools and rejects others", () => {
    for (const name of ALL_TOOLS) assert.equal(isKnownTool(name), true);
    assert.equal(isKnownTool("search"), false);
    assert.equal(isKnownTool("get_transcript"), false);
    assert.equal(isKnownTool(""), false);
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://mcp.domkozak.com/mcp");
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-abc");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-abc");
  });

  it("sends clientInfo name castnotes and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(SEARCH, SAMPLE_ARGS);
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "castnotes", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(SEARCH, SAMPLE_ARGS);
    await c.callTool(EPISODES, {});
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-abc");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the DOMKOZAK_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new CastnotesClient({
      fetchFn: upstream.fetchFn,
      env: { DOMKOZAK_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { DOMKOZAK_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new CastnotesClient({
      fetchFn: upstream.fetchFn,
      env: { DOMKOZAK_MCP_URL: "   " },
    });
    await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

/* ------------------------------------------------------------------ */

describe("no auth header is ever sent", () => {
  it("sends no Authorization or X-API-Key header on any request", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
    assert.ok(calls.every((call) => call.headers["X-API-Key"] === undefined));
  });

  it("sends only Content-Type, Accept and (when issued) Mcp-Session-Id headers", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.deepEqual(Object.keys(calls[0].headers).sort(), [
      "Accept",
      "Content-Type",
    ]);
    assert.deepEqual(Object.keys(calls[2].headers).sort(), [
      "Accept",
      "Content-Type",
      "Mcp-Session-Id",
    ]);
  });

  it("ignores credential-looking env vars: still no auth header", async () => {
    const upstream = makeUpstream();
    const c = new CastnotesClient({
      fetchFn: upstream.fetchFn,
      env: { DOMKOZAK_API_KEY: "should-not-be-sent", API_KEY: "nope" },
    });
    await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
    assert.ok(
      upstream.calls.every((call) => call.headers["X-API-Key"] === undefined),
    );
    assert.ok(
      upstream.calls.every(
        (call) =>
          !Object.values(call.headers).some((v) => v.includes("should-not-be-sent")),
      ),
    );
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards a search_podcast call verbatim", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(SEARCH, SAMPLE_ARGS);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, SEARCH);
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("forwards each of the 5 tools under its own name with untouched arguments", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      [SEARCH, { query: "pricing" }],
      [EPISODES, {}],
      [EPISODE, { episode: "10" }],
      [PDOOH, { topic: "programmatic guaranteed", limit: 2 }],
      [LESSONS, {}],
    ];
    for (const [name, args] of cases) {
      const { client: c, calls } = stubClient();
      const out = await c.callTool(name, args);
      assert.equal(out.isError, undefined);
      const params = calls[2].body.params as Record<string, unknown>;
      assert.equal(params.name, name);
      assert.deepEqual(params.arguments, args);
    }
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "no matching passages" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(SEARCH, { query: "zzz-no-match" });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      PDOOH,
      { topic: "frequency capping" },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, PDOOH);
    assert.deepEqual(params.arguments, { topic: "frequency capping" });
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as castnotes error text", () => {
  it("maps a JSON-RPC error to `castnotes error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "search failed upstream" },
    });
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "castnotes error: search failed upstream");
  });

  it("maps an initialize JSON-RPC error to castnotes error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "castnotes error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "castnotes error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "castnotes error: malformed response");
  });

  it("maps a non-2xx upstream status to castnotes error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "castnotes error: HTTP 500");
  });

  it("maps a throwing fetch to castnotes error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^castnotes error: /);
  });

  it("maps a throwing initialize fetch to castnotes error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "castnotes error: socket hang up");
  });

  it("maps a timed-out call to castnotes error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(SEARCH, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^castnotes error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, SEARCH, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, SEARCH, "query=pricing"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid search_podcast call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, SEARCH, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, EPISODES, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("the usage line names all 5 tool subcommands", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    for (const name of ALL_TOOLS) assert.match(res.stderr, new RegExp(name));
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([SEARCH, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([SEARCH, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });
});
