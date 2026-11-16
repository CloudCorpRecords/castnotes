# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted Dom Kozak knowledge MCP server. All 5 captured tools are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: `search_podcast`, `list_episodes`, `get_episode`, `explain_pdooh`, `list_lessons` — the full captured surface, with no omissions. `list_episodes` and `list_lessons` carry no `required` key in the capture and are served verbatim that way.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `castnotes error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `DOMKOZAK_MCP_URL`. The registry record declares no auth headers and the surface was captured keyless, so no key header is ever sent upstream.
