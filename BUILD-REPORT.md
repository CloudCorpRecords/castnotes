# BUILD REPORT — castnotes

Clean-room rebuild of `com.domkozak/knowledge` v1.0.0 (remote-only MCP
server at `https://mcp.domkozak.com/mcp`), built 2026-10-28 as a
forwarding client. Package: `@reneturcios/castnotes` 0.1.0,
registry name `io.github.CloudCorpRecords/castnotes`.

## Surface built

FULL surface: **all 5 captured tools built, 0 omitted**.

| Tool | Required fields as served |
|------|-----------------------------|
| `search_podcast` | `query` |
| `list_episodes` | *(no `required` key in the capture — served verbatim)* |
| `get_episode` | `episode` |
| `explain_pdooh` | `topic` |
| `list_lessons` | *(no `required` key in the capture — served verbatim)* |

Each served tool carries exactly the keys `name`, `title`,
`description`, `inputSchema`, exactly as captured. The tool literals
were generated programmatically from
`harness/fixtures/domkozak-tools-original.json` by the script at
`/tmp/b42-castnotes-scratch/gen_tooldefs.py` (parse + re-serialise in
fixture key order, placeholder substitution into `src/forward.ts`) —
never retyped — and a post-generation check confirmed the served
literals deep-equal the fixture's 5 tool objects. Tools are registered
via the MCP SDK low-level Server API (`ListToolsRequestSchema` /
`CallToolRequestSchema` handlers), not McpServer+zod.

## Fixture conflicts

**None.** The spec and the fixture agree on all 5 tool names, titles,
descriptions, required fields (`query` / none / `episode` / `topic` /
none) and property shapes.

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned: `https://mcp.domkozak.com/mcp`.
- Env override `DOMKOZAK_MCP_URL` — labelled reconstruction.
- The registry record declares NO auth headers and the capture was
  taken keyless: this client sends no key header on any request.
  Tests assert that no `Authorization` or `X-API-Key` header is ever
  sent, that the only headers sent are `Content-Type`, `Accept` and
  (when issued) `Mcp-Session-Id`, and that credential-looking env
  vars are ignored.
- Error rendering `castnotes error:` text for upstream failures —
  labelled reconstruction.
- Upstream results pass through verbatim, including `isError` and
  extra fields. tools/call is forwarded as streamable-HTTP JSON-RPC:
  initialize (protocolVersion `2025-03-26`) →
  notifications/initialized → tools/call, honouring `Mcp-Session-Id`
  when issued; plain-JSON and SSE replies are both parsed. The
  forwarding core takes an injectable fetch; tests stub the
  upstream — no live network calls in tests.

## Deviations

None.

## Lockfile

- Route: generated clean from birth in the build dir with no
  `node_modules` and no pre-existing lockfile:
  `npm install --package-lock-only --ignore-scripts --offline`.
- Parses as JSON; `name` == `@reneturcios/castnotes`.
- Package entries: **128**.
- sha256: `2afa81c0ef83bea33183d59512864c815e039731c5de9f87cd0a59298fe8226b`
  (re-verified unchanged after the subsequent offline `npm install`).

## server.json

- Description exactly: "Search a business podcast and course lessons,
  with quotes, episodes and source links." — **85 characters**.
- npm package entry carries `"version": "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/castnotes:0.1.0`) carries **no** `version`
  field. Both entries carry packageArguments
  `[{type: positional, value: mcp}]` and transport stdio. Dockerfile
  (node:20-alpine, both stages) carries the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/castnotes"`.
  Container workflow `IMAGE` is `ghcr.io/cloudcorprecords/castnotes`
  and its smoke test asserts the server name `castnotes`.

## Verification (all run 2026-10-28)

1. `npx tsc --noEmit` → exit 0.
2. `npm run build` → exit 0; real `dist/` produced (cli, forward,
   index, mcp, types — .js, .d.ts, .js.map each).
3. `node dist/cli.js --version` → `0.1.0`.
4. `npm test` → **55 tests, 55 pass, 0 fail** (registration-integrity
   suite deep-equals the served tools/list against the fixture's 5
   tools in order, including the verbatim no-`required` schemas of
   `list_episodes` and `list_lessons`; plus session
   establishment/reuse, env override, the no-auth-header assertions,
   verbatim argument forwarding for all 5 tools and result
   pass-through including upstream isError, SSE parsing, error
   rendering, MCP-layer validation, and CLI behaviour).
5. Parity: `python3 /home/hatch/workspace/mcp-rebuild-100/harness/parity.py --original /home/hatch/workspace/mcp-rebuild-100/harness/fixtures/domkozak-tools-original.json --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/castnotes/dist/cli.js mcp" --out /home/hatch/workspace/mcp-rebuild-100/builds/castnotes/parity-out` → **verdict PASS, parity 100.0**
   (5/5 identical, 0 missing, 0 extra, no schema diffs). Output in
   `parity-out/`.
