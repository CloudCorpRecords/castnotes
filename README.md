# castnotes

Some of the most useful business thinking never reaches a page you can search — it sits inside podcast audio and course lessons. castnotes is a small local bridge to Dom Kozak's hosted knowledge MCP service: it searches the transcripts of the *Built for MENA* podcast and explains concepts from his pDOOH 101 and 201 lessons, returning short passages with quotes, timestamps and source links.

Nothing is stored or computed on your own machine. This package answers `tools/list` locally from the captured tool definitions and forwards every `tools/call` to the hosted service over a streamable-HTTP JSON-RPC session, returning whatever the service sends back unchanged. The full captured surface is built — all five tools, no omissions.

## The tools

- **`search_podcast`** — Full-text search over *Built for MENA* episode transcripts. Give it a `query`; an optional `limit` (default 5, max 10) caps the passages returned. Each passage is about 120 words and carries the episode number, title, guest, timestamp in the published audio, episode link and speaker where the voice match is certain.
- **`list_episodes`** — Every published *Built for MENA* episode (trailer excluded), newest first, with number, title, guest, company, release date, length, link and whether its transcript is searchable yet. Takes no arguments.
- **`get_episode`** — One episode by number (for example `"10"`), or `"special"` for The Story So Far: title, guest, company, date, length, link and up to five key passages in order. Never the full transcript — use `search_podcast` for specific quotes.
- **`explain_pdooh`** — Plain-English explanations of programmatic digital out of home (pDOOH) from the released pDOOH 101 and 201 lessons. Give it a `topic`; an optional `limit` (default 3, max 10) caps the passages. Each result names the series, episode, lesson title, hook, air date, the relevant lesson text and the lesson URL.
- **`list_lessons`** — The released pDOOH 101 and 201 lessons in order, with series, episode, title, hook, air date and URL. Takes no arguments.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/castnotes mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "castnotes": {
      "command": "npx",
      "args": ["-y", "@reneturcios/castnotes", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/castnotes
docker run --rm ghcr.io/cloudcorprecords/castnotes search_podcast '{"query":"pricing"}'
```

## CLI

One binary serves both the command line and the MCP server. Each tool is a subcommand taking a single JSON string with that tool's arguments:

```bash
castnotes search_podcast '{"query":"distribution","limit":3}'
castnotes list_episodes '{}'
castnotes get_episode '{"episode":"10"}'
castnotes explain_pdooh '{"topic":"frequency capping"}'
castnotes list_lessons '{}'
castnotes --version
```

Exit codes: `0` when the forwarded call succeeds, `1` when the upstream result is an error, and `2` for usage problems such as an unknown subcommand or a malformed JSON argument.

## Configuration

- `DOMKOZAK_MCP_URL` — Overrides the upstream endpoint. The default is the pinned hosted endpoint, `https://mcp.domkozak.com/mcp`. (The override variable is a reconstruction added by this rebuild.)

No credentials are involved: the upstream's registry record declares no auth headers and the tool surface was captured keyless, so castnotes never sends an `Authorization` or `X-API-Key` header upstream.

Upstream failures — a JSON-RPC error from the service, a non-2xx response, an unreadable body, or a request that fails outright — are reported to the caller as an error result whose text starts with `castnotes error:`.

## How forwarding works

The first forwarded call opens a session: an `initialize` request (protocol version `2025-03-26`), followed by a `notifications/initialized` notification, then the `tools/call` itself. If the service answers the initialize request with an `Mcp-Session-Id` header, that value is carried on every later request, and the open session is reused for the rest of the process. Replies are accepted either as plain JSON or as server-sent events. Successful results pass through verbatim, including any `isError` flag and any extra fields the service includes.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The test suite checks the served tool list against the captured surface (all five tools, deep-equal, in order — including the two tools whose schemas carry no `required` key), exercises the session handshake and its reuse, verifies the endpoint override, asserts that no auth header is ever sent, and confirms that arguments go upstream untouched and results come back untouched.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
