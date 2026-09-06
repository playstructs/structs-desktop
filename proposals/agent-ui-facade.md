# Proposal: `window.__STRUCTS_AGENT_UI__` façade for agent-driven UI

**Target file (upstream, not edited here):**
- `structs-webapp/src/js/index.js` (one small block at the end of bootstrap)

**Status:** proposed — surfaced for the webapp owner, NOT applied to the submodule.
The desktop side (Rust `structs_ui` tool + bridge, and the `frontend/structs-config.js`
renderer) is already shipped and works **without** this façade for most directive
kinds. This façade only unlocks the two kinds that need module-scoped singletons.

---

## Why

The agent-driven UI feature (MCP `structs_ui` tool → `mcp_ui_directive` event →
renderer in `frontend/structs-config.js`) renders most directive kinds itself by
building body-appended overlays with the global SUI CSS classes: `toast`,
`hud_badge`, `panel`, `menu`, `dialogue`, `info`, `raw_html`, `dismiss`. These need
no webapp cooperation.

Two kinds, however, must drive **module-scoped** singletons that the webapp does
**not** currently expose on `window` (only `gameState`, `guildAPI`, `walletManager`,
`signingClientManager`, `taskManager`, `destroyedStructManager` are exposed via
`global.*`):

- `open_menu` → needs `MenuPage.router.goto(...)` + `MenuPage.open()`.
- `map_preview` → needs `MapManager.configurePreviewMap(...)` + `gameState.previewMap.render()` + `MapManager.showMap(MAP_CONTAINER_IDS.PREVIEW)`.

The renderer already calls `window.__STRUCTS_AGENT_UI__.openMenu(spec)` /
`.showPreview(spec)` when present, and degrades gracefully (logs + returns
`cancelled` to a waiting prompt) when absent. This façade simply exposes those
two capabilities through a small, stable, intentional surface — rather than the
glue reaching into bundle internals.

## Proposed change — append to `structs-webapp/src/js/index.js` (after the managers/MenuPage are constructed)

```js
// Agent-driven UI façade: a small, intentional surface the desktop glue
// (frontend/structs-config.js) calls for directive kinds that need
// module-scoped singletons. Display/elicitation only — never signs.
global.__STRUCTS_AGENT_UI__ = {
  // spec: { controller, page, options? }
  openMenu(spec) {
    if (!spec || !spec.controller) return;
    MenuPage.router.goto(spec.controller, spec.page || 'index', spec.options || {});
    MenuPage.open();
  },

  // spec: { planet_id, defender_id?, attacker_id? }
  // Renders another player's planet into the existing preview map.
  async showPreview(spec) {
    if (!spec || !spec.planet_id) return;
    const planet = await guildAPI.getPlanetById(spec.planet_id);            // adjust to the real API method
    const defender = spec.defender_id ? await guildAPI.getPlayer(spec.defender_id) : null;
    const attacker = spec.attacker_id ? await guildAPI.getPlayer(spec.attacker_id)
                                      : gameState.keyPlayers?.[1]?.player ?? null;
    mapManager.configurePreviewMap(new Planet(planet), defender, attacker, null, null);
    gameState.previewMap.render();
    mapManager.showMap(MAP_CONTAINER_IDS.PREVIEW);
  },
};
```

Notes for the implementer:
- Use whatever the real Guild API accessors are for planet/player (`getPlanetById`,
  `getPlayer`, or their actual names) and the correct `Planet` model import.
- `mapManager`, `MenuPage`, `MAP_CONTAINER_IDS`, `Planet` are already in scope in
  `index.js`; this block just re-exposes two narrow operations.
- Keep it display-only. It must never call `signingClientManager` — actions remain
  the agent's job through the MCP tx bridge (which has its own approval gate).

## After applying
- `structs_ui {mode:'notify', component:{kind:'open_menu', controller:'Fleet', page:'index'}}`
  jumps the human to the Fleet screen.
- `structs_ui {mode:'notify', component:{kind:'map_preview', planet_id:'2-7'}}`
  renders planet 2-7 in the preview map.
- No desktop-side change is needed — the renderer already detects the façade.
