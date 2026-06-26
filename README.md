# Structs Desktop

A native desktop app for [Structs](https://structs.ai) — wraps the [structs-webapp](https://github.com/playstructs/structs-webapp) game client in a Tauri shell with GPU-accelerated proof-of-work hashing, native OS notifications, an embedded MCP server for AI agents, and CORS-free API access.

**WARNING**: This software is untested, unsafe, unreasonable, unstable and should not be run. Do so at your own risk. 

## Structs
In the distant future the species of the galaxy are embroiled in a race for Alpha Matter, the rare and dangerous substance that fuels galactic civilization. Players take command of Structs, a race of sentient machines, and must forge alliances, conquer enemies and expand their influence to control Alpha Matter and the fate of the galaxy.

[Structs](https://playstructs.com) is a decentralized game in the Cosmos ecosystem, operated and governed by our community of players--ensuring Structs remains online as long as there are players to play it.


## Features

- **GPU Hashing** — Multi-threaded CPU + GPU SHA256 proof-of-work at ~200M hashes/sec via wgpu
- **MCP Server** — AI agents can play Structs through the Model Context Protocol (9 tools, 6 prompts, compendium resources)
- **Perception Layer** — Recon, combat results, a weapon-matrix ruleset, and a damage simulator so agents can see the battlefield and plan attacks without raw DB access
- **Agent-Driven UI** — Agents can drive the human's screen (menus, map previews, HUD badges, prompts) for human+agent co-op play
- **Event Feed** — Long-poll stream of game events (raids, attacks, completions) so agents react instead of polling
- **Native Notifications** — Desktop alerts for raids, fleet movements, mining completion, etc.
- **Policy Engine** — Standing orders with delta tracking (auto-refine, power alerts, combat mode, agent-driven UI toggle)
- **Guild Configuration** — Connect to any guild's infrastructure with stored configs
- **CORS Proxy** — All API calls routed through Rust to bypass browser CORS restrictions
- **Pixel-Perfect Rendering** — CSS `zoom` replaces `transform: scale()` for crisp pixel art in WKWebView
- **Background Operation** — App stays active when minimized (no App Nap throttling)
- **Debug Tab** — In-app diagnostics showing player identity, infrastructure endpoints, MCP status, hash engine, and policies

## Quick Start

```bash
git clone --recursive https://github.com/playstructs/structs-universe.git
cd structs-universe
npm install
make sync      # Pull latest webapp, patch, webpack build, sync compendium
make build     # Production build + code sign
make launch    # Open the .app bundle
```

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) (18+)
- Xcode Command Line Tools: `xcode-select --install`

### Make Targets

```
make dev            Launch in development mode (hot reload, devtools)
make build          Production build + code sign
make sync           Pull latest structs-webapp + rebuild frontend + sync compendium
make release        Full rebuild from latest submodule
make clean          Remove build artifacts
make sign           Re-sign existing .app bundle
make launch         Open the signed release bundle
make launch-debug   Launch from terminal (shows stderr logs)
make check          Check Rust compilation without building
make test           Run Rust tests
make tag v=X.Y.Z    Create a release tag (triggers CI builds)
make help           Show all targets
```

### Multi-Platform Releases

Tag a version to trigger GitHub Actions CI builds for all platforms:

```bash
make tag v=0.2.0
git push origin v0.2.0
# Builds .app (macOS), .exe/.msi (Windows), .deb/.AppImage (Linux)
```

## Architecture

```
structs-universe/
├── structs-webapp/           # Git submodule (upstream game UI)
├── scripts/
│   ├── sync.sh               # Full build pipeline + compendium sync
│   ├── build-frontend.sh     # Conditional build gate
│   ├── apply-patches.sh      # Endpoint + renderer patches
│   └── sign.sh               # macOS code signing
├── frontend/                 # Built output served by Tauri
│   ├── index.html            # Static HTML (converted from Twig)
│   └── structs-config.js     # Config injection, notifications, Worker shim, sync, debug tab, agent-UI renderer, force-resync
├── src-tauri/
│   ├── tauri.conf.json
│   ├── Cargo.toml
│   ├── Info.plist             # macOS ATS exception for HTTP connections
│   └── src/
│       ├── main.rs           # App entry, init scripts, fetch proxy, pixel rendering
│       ├── guild_config.rs   # Multi-guild config storage
│       ├── http_proxy.rs     # CORS bypass via reqwest with cookie persistence
│       ├── notifications.rs  # Native OS notifications (UNUserNotificationCenter / notify-rust)
│       ├── game_state.rs     # JS→Rust gameState sync, charge tracking, combat mode sync interval
│       ├── hasher/           # GPU/CPU SHA256 proof-of-work engine
│       │   ├── mod.rs        # Task management, GPU init, Tauri commands
│       │   ├── cpu.rs        # Multi-threaded rayon hasher
│       │   ├── gpu.rs        # wgpu compute shader dispatch
│       │   ├── sha256.wgsl   # WGSL SHA256 compute shader
│       │   ├── difficulty.rs # Difficulty calculation + check
│       │   └── types.rs      # TaskParams, TaskRegistry, snapshots
│       └── mcp/              # Embedded MCP server
│           ├── server.rs     # HTTP server (rmcp + axum) with bearer token auth
│           ├── handler.rs    # Tool/resource/prompt routing + ServerHandler impl
│           ├── config.rs     # MCP config persistence (port, token)
│           ├── cosmos_client.rs  # Typed Cosmos REST API client
│           ├── guild_api.rs  # Guild REST API client (recon, activity, defenders, stats)
│           ├── event_buffer.rs   # NATS event ring buffer (1000 events)
│           ├── policy.rs     # Standing orders / automation engine with delta tracking
│           ├── tx_queue.rs   # Transaction signing bridge (Rust ↔ JS CosmJS)
│           ├── ui_bridge.rs  # Agent-driven UI directive bridge (Rust → JS, prompt round-trip)
│           ├── combat.rs     # Pure combat math for the attack simulator
│           ├── error_translator.rs  # Chain error → human message
│           ├── prompts.rs    # 6 built-in agent workflow prompts
│           ├── resources.rs  # Compendium file serving (structs-ai docs)
│           └── tools/
│               ├── dashboard.rs  # Player situational awareness (charge, HP, slots)
│               ├── query.rs      # Entity lookup with enrichment
│               ├── hasher.rs     # Hash task management with ETAs
│               ├── action.rs     # Game actions with preflight checks
│               ├── intel.rs      # Strategic intelligence + recon/ruleset/simulate
│               ├── events.rs     # Event feed (long-poll over the NATS buffer)
│               ├── sequence.rs   # Guarded autonomous action chains
│               ├── ui.rs         # structs_ui tool (drive the human's screen)
│               ├── policy.rs     # Standing order management
│               └── format.rs     # Shared formatting utilities
├── .mcp.json                 # Claude Code MCP server config
├── .github/workflows/        # CI/CD
│   ├── ci.yml                # Build check on push/PR (macOS, Windows, Linux)
│   └── release.yml           # Multi-platform release on version tags
└── Makefile                  # Build system
```

## MCP Server

The app runs an MCP server on `localhost:8420` with bearer token authentication. AI agents interact with the game through 9 tools, 6 prompts, and compendium resources.

### Tools

| Tool | Purpose |
|------|---------|
| `structs_dashboard` | Full player overview: power, charge (with per-action readiness), resources, structs + HP, hash tasks, recent events |
| `structs_query` | Query any game entity with enriched output (resolved names, decoded flags, 25-bit permission decode, formatted units) |
| `structs_hash` | Manage proof-of-work tasks with ETAs (list, start, stop, progress) + tune the engine (`config`: enable/disable, GPU/CPU, `DIFFICULTY_START`, `MAX_CONCURRENT_PROCESSES`) |
| `structs_action` | Execute game actions with preflight checks (explore, build, mine, attack, defend, raid, resync, etc.) |
| `structs_intel` | Strategic intelligence + perception: `whoami`, `scout`, `valid_targets`, `battle_log`, `ruleset`, `simulate`, `slot_map`, `is_active`, `intents`, power forecast, economy, timeline |
| `structs_policy` | Standing orders (auto_refine, power_alert, agent_ui, combat orders) |
| `structs_ui` | Drive the human's screen for co-op play (menus, map previews, HUD badges, prompts) — display/elicitation only, never signs |
| `structs_events` | Long-poll event feed (raids, attacks, fleet moves, completions) so agents react instead of polling |
| `structs_sequence` | Guarded autonomous action chains, paced to the charge cooldown, with abort predicates (e.g. CMD-ship HP floor) |

### Prompts

| Prompt | Purpose |
|--------|---------|
| `structs_first_session` | Orientation for new agents — check dashboard, identify priorities |
| `structs_game_loop` | One tick: dashboard → assess → plan → execute → verify |
| `structs_state_assessment` | Deep analysis with risk ratings: power, threats, economy, operations |
| `structs_combat_planning` | Scout, simulate, recommend attack/wait/abort |
| `structs_threat_check` | Assess hostile activity using planet history + valid targets |
| `structs_market_check` | Survey the power-rental market |

### Resources

The [structs-ai](https://github.com/playstructs/structs-ai) compendium is bundled as MCP resources (synced during `make sync`). Agents can read game documentation on demand:

- `structs://knowledge/mechanics/combat.md` — Combat system
- `structs://knowledge/mechanics/power.md` — Energy system
- `structs://playbooks/phases/early-game.md` — Strategy guides
- `structs://QUICKSTART.md` — Getting started

### Connecting Claude Code

The MCP connection details are shown in the app's **Debug tab** and browser console. Copy the `.mcp.json` config from the Debug tab, or add manually:

```json
{
  "mcpServers": {
    "structs-game": {
      "type": "http",
      "url": "http://127.0.0.1:8420/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN_HERE"
      }
    }
  }
}
```

The bearer token is generated on first launch and stored in `~/Library/Application Support/structs-app/mcp_config.json` (macOS). Find it in the Debug tab or browser console.

### Security

The MCP server requires a bearer token on every request. Without it, requests return `400 Bad Request`. This prevents unauthorized access from other processes or websites on the same machine.

## GPU Hashing

The app replaces the webapp's JavaScript WebWorker hasher with a Rust-native implementation:

- **CPU**: Multi-threaded via rayon with hardware SHA256 instructions (~3M h/s)
- **GPU**: wgpu compute shader dispatching 1M nonces per batch (~200M h/s)
- **Auto-selection**: GPU used when available, falls back to CPU. Agents can override at runtime via `structs_hash {command:"config", engine:"cpu"|"gpu"|"auto"}`, and tune `difficulty_start` (when a worker starts grinding) and `max_concurrent` (the task manager's concurrent-job cap)
- **Worker shim**: Transparently intercepts `new Worker()` calls for TaskWorker.js, routing to Rust while maintaining the existing TaskManager.js interface
- **ETA estimates**: Each task shows percent complete, current difficulty, hashrate, and estimated time remaining

### How It Works

1. `structs-config.js` installs a `Proxy` on `window.Worker`
2. When TaskWorker.js is requested, a real Worker is created (for instanceof checks) but `postMessage` is overridden
3. `postMessage([state])` extracts TaskState fields and calls `start_hash_task` Rust command
4. Rust starts hashing on GPU/CPU, emits `hash_progress`/`hash_complete` Tauri events
5. Events are forwarded back through `onmessage` to TaskManager.js
6. TaskManager submits the completion transaction to the chain

## Notifications

Native OS notifications fire for game events via NATS WebSocket interception. Events are filtered by player context — you only get notified about events relevant to your planet and fleet.

| Event | When |
|-------|------|
| Raid Alert | Your planet is raided (with status: initiated, retreated, successful, etc.) |
| Structs Under Attack | Your structs take damage |
| Enemy Fleet Incoming/Departed | Enemy fleet arrives at or leaves your planet |
| Your Fleet Moved | Your fleet arrives or departs |
| Mining/Refining/Build Started | PoW task initiated on your structs |
| Struct Status Changed | Build complete, went offline, destroyed |
| Alpha Matter Transfer | Sent or received |
| Power Alert | Load exceeds capacity threshold |

### Platform

| Platform | API | Notes |
|----------|-----|-------|
| macOS | UNUserNotificationCenter (objc2) | Requires .app bundle + code signing |
| Windows | notify-rust (WinRT) | Works out of the box |
| Linux | notify-rust (D-Bus) | Works out of the box |

## Build Pipeline

`make sync` runs `scripts/sync.sh`:

1. Updates `structs-webapp` git submodule to latest
2. Copies source to temp build directory
3. Applies endpoint/renderer patches via `apply-patches.sh`:
   - GuildAPI.js → configurable API URL
   - index.js (GrassManager) → configurable NATS WebSocket URL
   - SigningClientManager.js → configurable RPC WebSocket URL
   - Defeat/Victory banner ViewModels → canvas renderer for crisp pixel art
   - index.js → expose gameState to window for Tauri sync
   - GrassManager.js → resume-check reconnect + heartbeat (auto-reconnect a stale NATS stream on foreground)
4. Runs `npm install` + `webpack --mode=production`
5. Copies webpack output + static assets to `frontend/`
6. Syncs structs-ai compendium to `~/.config/structs-app/compendium/`

### Code Signing

macOS notifications require a signed `.app` bundle. The build automatically signs:

```bash
codesign --force --deep -s "Slow Ninja Inc" Structs.app
```

## Policy Engine

Standing orders that run automatically on game state transitions:

| Policy | Default | Behavior |
|--------|---------|----------|
| `auto_refine` | ON | Auto-start refine when mining completes |
| `power_alert` | ON (80%) | Warn when power utilization crosses threshold |
| `agent_ui` | ON | Master toggle for agent-driven UI (`structs_ui`); off = directives dropped |
| `auto_counterattack` | OFF | Standing order: counter an incoming attacker |
| `auto_retreat_if_cmd_below` | OFF (HP 4) | Standing order: retreat when Command Ship HP drops below threshold |
| `auto_rebuild_losses` | OFF | Standing order: rebuild destroyed structs |
| `rules_of_engagement` | OFF | Human→agent posture / pinned target, read via `structs_intel {query:"intents"}` |

`auto_refine` / `power_alert` use delta tracking — they compare previous vs current state snapshots to detect transitions (not just current conditions), preventing double-triggers and missed events. The combat orders and `rules_of_engagement` are **agent-honored standing orders**: the agent reads them via `intents` and acts through `structs_action`/`structs_sequence` — the engine never auto-signs on the player's behalf.

### Combat Mode

The policy engine auto-detects combat events (raids, attacks, fleet arrivals) and switches the gameState sync interval from 10s to 3s for faster response. Drops back to 10s after 30 blocks (~3 min) of quiet.

## Transaction Signing Bridge

Game actions submitted through MCP flow through a Rust ↔ JS bridge:

1. MCP `structs_action` tool validates preconditions (charge, power, entity state)
2. Rust emits `mcp_transaction_request` Tauri event to the webview
3. JS listener in `structs-config.js` routes to the correct `SigningClientManager.queueMsg*()` method
4. CosmJS signs and broadcasts the transaction
5. JS responds back via `mcp_transaction_response` Tauri command
6. MCP tool returns the result to the agent

## Agent-Driven UI

For human+agent co-op play, the `structs_ui` tool lets an agent render on the human's screen, mirroring the transaction bridge:

1. Agent calls `structs_ui` with a declarative component spec (`menu`, `dialogue`, `panel`, `info`, `map_preview`, `hud_badge`, `toast`, `open_menu`, `raw_html`)
2. Rust emits `mcp_ui_directive` to the webview; the renderer in `structs-config.js` builds the surface using the game's own SUI styles
3. **notify** mode shows-and-returns; **prompt** mode blocks until the human chooses, returning the selection via `mcp_ui_response` (same oneshot pattern as the tx bridge)

Guardrails: every agent-drawn surface carries an "⚡ Agent" marker, the `agent_ui` policy is a master off-switch, and UI directives are **display/elicitation only — they cannot sign**. Any action the human picks still flows through the approval-gated transaction bridge. A `structs_action {action:"resync"}` emits `structs:force-resync` to refresh a stale game state or reconnect the event stream.

## Debug Tab

The app adds a "Debug" tab to the game UI (alongside Fleet, Guild, Account) showing:

- **Identity**: Player ID, address (click to copy), guild, substation, fleet, planet, block height
- **Infrastructure**: Guild API, Reactor API, Client WS, NATS WS endpoints
- **MCP Server**: URL, status, bearer token (click to copy), config (click to copy full .mcp.json)
- **Hash Engine**: GPU availability, active tasks with status and hashrate
- **Policies**: All standing orders with ON/OFF status

## Guild Configuration

Players join guilds that provide infrastructure. Configs stored at `~/Library/Application Support/structs-app/guild_configs.json` (macOS):

| Field | Purpose |
|-------|---------|
| `guildApi` | REST API for game data |
| `reactorApi` | Cosmos REST endpoint |
| `clientWs` | Tendermint RPC WebSocket |
| `grassNatsWs` | NATS event stream |

A default config ships for new players. The app supports multiple guild configs with one active at a time.

## Design Decisions

**Why not fork structs-webapp?** Active upstream development. Sed patches at build time are more resilient than maintaining a fork.

**Why proxy fetch through Rust?** Guild APIs don't set CORS headers. Rust's reqwest makes requests server-side where CORS doesn't apply. A persistent cookie jar maintains session state across requests.

**Why custom notifications instead of tauri-plugin-notification?** The plugin uses deprecated NSUserNotification on macOS. We use UNUserNotificationCenter directly via objc2 bindings.

**Why zoom instead of transform: scale()?** WKWebView applies bilinear interpolation to CSS transforms, blurring pixel art and text. CSS `zoom` uses nearest-neighbor scaling.

**Why embed an MCP server?** AI agents need a standardized way to play the game. One connection gives full situational awareness, action execution, and automation — the MCP is a "competent first officer" that handles plumbing so agents can focus on strategy.

**Why bearer token auth on localhost?** Any website in a browser can make HTTP requests to localhost. Without authentication, a malicious page could control the game. The bearer token prevents unauthorized access.

**Why 400 instead of 401 for auth failures?** Claude Code interprets 401 responses as "needs OAuth" and triggers an OAuth flow instead of using the configured bearer token. Returning 400 avoids this while still rejecting unauthorized requests.

## Learn more

- [PlayStructs.com](https://playstructs.com)
- [Structs Wiki](https://watt.wiki)
- [@PlayStructs Twitter](https://twitter.com/playstructs)
- [/structs Farcaster Channel](https://warpcast.com/~/channel/structs)

## License

Copyright 2026 [Slow Ninja Inc](https://slow.ninja).

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

[http://www.apache.org/licenses/LICENSE-2.0](http://www.apache.org/licenses/LICENSE-2.0)

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.