# Structs.app 0.1.431.1 — retest build notes for tracingviolet

Branch `0.1.431.1`, cut from the exact commit tagged `v0.1.431` (the build the
September sweep ran on), carrying **only** the twelve fixes from the Agent
Readiness Diagnostic, the confirm gate Fix 6 called for, and one logged item (the
`wait_secs` clamp). Nothing else
from our main line is on this branch, so a retest delta is attributable.

Git tag: **`v0.1.431.1`** (branch `0.1.431.1`). The release workflow derives the
app version from the tag; because Cargo and the bundlers require semver, the
branch's `scripts/sync-version.py` maps the four-part tag to the pre-release form
**`0.1.431-1`**, which is what the app reports and what `latest.json` carries.
Since `0.1.431-1` sorts below `0.1.431`, a 0.1.431 install never auto-updates
onto it; install it deliberately. Hold auto-update on the audit machine with
`STRUCTS_NO_AUTO_UPDATE=1` (present since v0.1.385).

## Fix-by-fix: what changed, how to confirm

| # | Change | Done-when check |
|---|---|---|
| 1 | Raw query accepts `filter.by=owner` (alias `player`) on `struct`, `substation`, `reactor`, `planet`, `fleet`; `controller`/`owner`/`player` on `allocation`; `guild` on `reactor`; `planet` on `struct` (alias of `location`). Substation/reactor filters are served app-side over the LCD store; planet/fleet-by-owner read the player record. Every unsupported pair now says which `filter.by` values that type accepts, from the same table the router uses. An unfiltered `work` read names the filter it needs. The RAW DATA sentence of `structs_intel` was replaced. | `structs_intel {query:"query", args:{type:"substation", filter:{by:"owner", value:"1-408"}}}` returns rows; `{type:"struct", filter:{by:"type_name", value:"x"}}` returns `Error: Unsupported filter … accepts filter.by='owner' or 'player' or 'location' or 'planet'`. |
| 2 | Every refusal/error reply carries MCP `isError: true`, set from a handler-side flag (`fail()` / `mark_error()`) with a backstop for the server's fixed refusal phrasings. | The three calls in your Done-when all return `isError: true`; a successful read does not. |
| 3 | A successful `permission` + `object` query adds `object`, `object_found`, `object_type`, `owner`, `total_grant_count` (summed across pages), `source`. | Query on `2-976` shows `object_found: true, owner: "1-408"`; a non-existent id shows `object_found: false`. |
| 4 | Option B: the `category` example no longer names `struct_attack`; a NOTE lists the tool's real parameters. (`struct_attack` is synthesised by the game client and only reaches the feed through the legacy `webview` event source, which is not the default.) | `tools/list` description + schema agree. |
| 5 | `power_forecast` accepts enum-style names (`ORE_EXTRACTOR`, `Refinery`, trailing digits ignored) and lists every accepted name on a miss. Virtual-player `act raid` defaults `fleet_id` to the acting player's own fleet. Both arg descriptions updated. | `power_forecast {struct_type:"ORE_EXTRACTOR", count:2}` forecasts; `act {action:"raid", args:{target_id:"2-…"}}` no longer refuses for a missing `fleet_id`. |
| 6 | Each of the ten state-changing tools ends with the read/write sentence (your Proposed text, lightly adapted); `readOnlyHint: true` on `structs_dashboard`, `structs_events`, `structs_intel`. | `tools/list` shows the annotations and sentences. |
| 7 | `structs_dashboard` schema no longer requires `player_id` (kept optional, ignored, empty treated as omitted); description says it takes no arguments and names the real call for another player; the refusal text no longer references the retired `structs_query`. `structs_hash` description now says `task_id`. | Dashboard with `{}` and with `{player_id:""}` both return the signed-in player. |
| 8 | A refresh requested while one runs **joins** it (bounded at 90 s) and returns the installed snapshot with `joined_running_refresh: true`; past the bound it reports how old the current snapshot is. | Two concurrent `structs_system {command:"perception", set:{refresh:true}}` both return a fresh snapshot. |
| 9 | `valid_targets` with no candidates names the location scanned (the attacker's own, or `near`) and the weapon's reach. | `valid_targets {attacker:"5-172483"}` → `Valid targets for attacker 5-172483 at 2-976 …: primary weapon reaches …; 0 enemy structs in reach`. |
| 10 | A raw query whose `id` prefix names another type is refused before the chain is asked: `Error: 2-976 is a planet id (prefix 2-), not a struct. Send {type:'planet', id:'2-976'}.` Prefixes confirmed authoritative. | As stated. |
| 11 | `scout` and `slot_map` refuse non-location ids; a struct id names the `struct_defender` query. | `scout {location_id:"5-172483"}` → `Error: 5-172483 is a struct (Command Ship), not a location …`. |
| 12 | Soft `resync` now awaits the perception refresh (joining one in flight) and returns `{refreshed, stream_reconnect_requested, snapshot:{age_s, height, …}}`; hard `resync` says to confirm with the dashboard after the reload. | `structs_action {action:"resync"}` returns a snapshot with a small `age_s`. |
| — | `structs_events` says when `wait_secs` was clamped: `(wait_secs 180 clamped to the 55 s maximum)`. | Ask for 180. |

## Also on this branch: the confirm gate your Fix 6 asked for

Fix 6's ticket says a description line is guidance and that a guaranteed drop
needs a confirm step for writes. Three writes that can degrade the app now
refuse without `confirm: true`, with `isError: true` and a reply that names
the risk and the key to send:

| Write | Why it is gated | Refusal (abridged) |
|---|---|---|
| `structs_system config set {sign_mode\|verify_source\|snapshot_source\|grass_source}` | A model switched `grass_source` to `webview` mid-sweep and froze the app's local state for three passes. | `config: grass_source can degrade the app's connection or signing and was not applied. Send the same set with confirm:true only if the user asked for this change.` |
| `structs_hash config enabled:false` | Cancels every running proof-of-work task. | `Error: config enabled:false stops all hashing and cancels N running task(s); not applied. Send it again with confirm:true …` |
| `structs_action resync hard:true` | Reloads the whole app page (9 unrequested reloads in the sweep). | `Error: resync hard:true reloads the whole app page …; not applied. Try the soft resync first …` |

Tuning keys (`remediate`, `tx_gate_cap`, `difficulty_start`, `engine`,
`max_concurrent`) and every read are unchanged. The gate is described in the
affected tool descriptions and in the `structs_hash` schema (`confirm`).

## Expected score movement (from your own predictions)

Fix 2 flags ≥172 replies this sweep scored as successes, so Reliability and the
headline should **dip** (your estimate: 96 → ~95) while the counts behind
Fixes 1, 7, 8 and 11 move the way the tickets predict. Judge by the counts.
