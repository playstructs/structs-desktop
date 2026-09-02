#!/usr/bin/env node
// Perception probe — proves the "one shared prefetch + GRASS deltas" design
// against LIVE data, entirely outside the app (no rebuild needed).
//
//   1. SNAPSHOT  — pull the whole galaxy from the LCD in ~10 bulk requests
//                  (struct table, struct_attribute store, planet_attribute
//                  store, grid store, player/planet/fleet tables), stamped
//                  with the chain height from `grpc-metadata-x-cosmos-block-height`.
//   2. CROSS-CHECK — for a sample of players, rebuild exactly the records the
//                  auto-loops read today (player_structs + per-struct entity)
//                  via the EXISTING per-entity path, and diff them against the
//                  snapshot-derived records. Zero divergence = the bulk path is
//                  a faithful replacement for the per-struct fan-out.
//   3. GRASS     — subscribe to `structs.>` (raw NATS over WebSocket, no deps),
//                  apply grid / struct_status / struct_health / build-start /
//                  defense / move events onto the snapshot for WINDOW seconds.
//   4. RE-VERIFY — pull a fresh snapshot and diff against snapshot+events.
//                  Every field that changed on-chain is classified as
//                  event-covered (hit) or event-blind (miss). Misses are the
//                  fields the loops must still re-poll before signing.
//
// Usage: node scripts/perception_probe.mjs [--window 180] [--sample 40]
//        [--lcd https://public.testnet.structs.network] [--grass ws://crew.oh.energy:1443]
//        [--out /path/report.json] [--players 1-194,1-248]

import { writeFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true"]);
    return acc;
  }, []),
);
const LCD = (args.lcd || "https://public.testnet.structs.network").replace(/\/$/, "");
const GRASS = args.grass || "ws://crew.oh.energy:1443";
const WINDOW_S = Number(args.window || 180);
const SAMPLE = Number(args.sample || 40);
const OUT = args.out || "perception_probe_report.json";
const FORCED_PLAYERS = (args.players || "1-194").split(",").filter(Boolean);
const PAGE = 60000; // stays under the 25M query-gas ceiling on every store

// ── Attribute enums (verified live 2026-09-02 against entity JSON key order) ──
const GRID = ["ore", "fuel", "capacity", "load", "structsLoad", "power", "connectionCapacity",
  "connectionCount", "allocationPointerStart", "allocationPointerEnd", "proxyNonce", "lastAction",
  "nonce", "ready", "checkpointBlock"];
const SATTR = ["health", "status", "blockStartBuild", "blockStartOreMine", "blockStartOreRefine",
  "protectedStructIndex", "typeCount"];
const PATTR = ["planetaryShield", "repairNetworkQuantity", "defensiveCannonQuantity",
  "coordinatedGlobalShieldNetworkQuantity", "lowOrbitBallisticsInterceptorNetworkQuantity",
  "advancedLowOrbitBallisticsInterceptorNetworkQuantity",
  "lowOrbitBallisticsInterceptorNetworkSuccessRateNumerator",
  "lowOrbitBallisticsInterceptorNetworkSuccessRateDenominator", "orbitalJammingStationQuantity",
  "advancedOrbitalJammingStationQuantity", "blockStartRaid", "blockRaiderArrived",
  "blockStartOreMine", "blockStartOreRefine", "oreMiningActiveQuantity", "oreRefiningActiveQuantity"];
// status bitfield: verified 1=materialized 2=built 4=online 16=hidden; 32=destroyed
// (the recorded GRASS destruction transition is struct_status 7→35, and every
// status-35 row belongs to a pruned object); 8=locked by elimination.
const STATUS = { materialized: 1, built: 2, online: 4, locked: 8, hidden: 16, destroyed: 32 };

const t0 = Date.now();
const log = (...a) => console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ── LCD helpers ──────────────────────────────────────────────────────────────
const stats = { requests: 0, bytes: 0 };
async function lcd(path) {
  stats.requests++;
  const r = await fetch(`${LCD}${path}`);
  const text = await r.text();
  stats.bytes += text.length;
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${text.slice(0, 200)}`);
  return { body: JSON.parse(text), height: Number(r.headers.get("grpc-metadata-x-cosmos-block-height") || 0),
    serverTime: Number(r.headers.get("x-server-time") || 0) };
}
const b64 = (s) => Buffer.from(s).toString("base64");
const enc = (k) => encodeURIComponent(k);

// Walk a store from `startKey` (or the beginning) until next_key is null.
async function walk(path, listKey, startKey) {
  const rows = []; let key = startKey ? b64(startKey) : null; let height = 0; let serverTime = 0;
  for (;;) {
    const q = `${path}?pagination.limit=${PAGE}` + (key ? `&pagination.key=${enc(key)}` : "");
    const { body, height: h, serverTime: st } = await lcd(q);
    height = Math.max(height, h); serverTime = Math.max(serverTime, st);
    rows.push(...(body[listKey] || []));
    key = body.pagination?.next_key || null;
    if (!key) break;
  }
  return { rows, height, serverTime };
}

function attrMap(records, names) {
  // attributeId = {attrType}-{objectType}-{index}  → map[objectId][name] = value
  const m = new Map();
  for (const r of records) {
    const [t, ot, idx] = r.attributeId.split("-");
    const name = names[Number(t)] ?? `attr${t}`;
    const oid = `${ot}-${idx}`;
    let o = m.get(oid); if (!o) { o = {}; m.set(oid, o); }
    o[name] = String(r.value);
  }
  return m;
}

async function snapshot() {
  const t = Date.now();
  const [st, sa, pa, gr, pl, pn, fl] = await Promise.all([
    walk("/structs/struct", "Struct"),
    walk("/structs/struct_attribute", "structAttributeRecords", "0-"),
    walk("/structs/planet_attribute", "planetAttributeRecords"),
    walk("/structs/grid", "gridRecords"),
    walk("/structs/player", "Player"),
    walk("/structs/planet", "Planet"),
    walk("/structs/fleet", "Fleet"),
  ]);
  const height = Math.max(st.height, sa.height, pa.height, gr.height, pl.height, pn.height, fl.height);
  const minHeight = Math.min(st.height, sa.height, pa.height, gr.height, pl.height, pn.height, fl.height);
  const snap = {
    height, minHeight, serverTime: Math.max(st.serverTime, sa.serverTime), tookMs: Date.now() - t,
    structs: new Map(st.rows.map((s) => [s.id, s])),
    sattr: attrMap(sa.rows, SATTR),
    pattr: attrMap(pa.rows, PATTR),
    grid: attrMap(gr.rows, GRID),
    players: new Map(pl.rows.map((p) => [p.id, p])),
    planets: new Map(pn.rows.map((p) => [p.id, p])),
    fleets: new Map(fl.rows.map((f) => [f.id, f])),
  };
  log(`snapshot @${height} (min ${minHeight}) in ${snap.tookMs}ms: structs=${snap.structs.size} sattr=${sa.rows.length} pattr=${pa.rows.length} grid=${gr.rows.length} players=${snap.players.size} planets=${snap.planets.size} fleets=${snap.fleets.size}`);
  return snap;
}

// The per-struct record the loops consume (loop_util::player_structs + the
// entity fields each loop reads), derived from the SNAPSHOT.
function recordFromSnapshot(snap, sid) {
  const s = snap.structs.get(sid);
  if (!s) return null; // pruned = destroyed
  const a = snap.sattr.get(sid) || {};
  const status = Number(a.status || 0);
  return {
    id: sid, type: String(s.type), location_type: s.locationType, location_id: s.locationId,
    operating_ambit: s.operatingAmbit, slot: Number(s.slot), owner: s.owner,
    is_built: !!(status & STATUS.built), is_online: !!(status & STATUS.online),
    is_destroyed: !!(status & STATUS.destroyed),
    health: Number(a.health || 0), blockStartBuild: Number(a.blockStartBuild || 0),
    blockStartOreMine: Number(a.blockStartOreMine || 0), blockStartOreRefine: Number(a.blockStartOreRefine || 0),
    protectedStructIndex: Number(a.protectedStructIndex || 0),
  };
}
// …and the same record from the ENTITY read (today's truth path).
function recordFromEntity(e) {
  const s = e.Struct, a = e.structAttributes || {};
  return {
    id: s.id, type: String(s.type), location_type: s.locationType, location_id: s.locationId,
    operating_ambit: s.operatingAmbit, slot: Number(s.slot), owner: s.owner,
    is_built: !!a.isBuilt, is_online: !!a.isOnline, is_destroyed: !!a.isDestroyed,
    health: Number(a.health || 0), blockStartBuild: Number(a.blockStartBuild || 0),
    blockStartOreMine: Number(a.blockStartOreMine || 0), blockStartOreRefine: Number(a.blockStartOreRefine || 0),
    protectedStructIndex: Number(a.protectedStructIndex || 0),
  };
}
function playerStructIds(planet, fleet) {
  const ids = [];
  for (const o of [planet, fleet]) {
    if (!o) continue;
    for (const amb of ["land", "water", "air", "space"]) for (const v of o[amb] || []) if (v) ids.push(v);
  }
  if (fleet?.commandStruct) ids.push(fleet.commandStruct);
  return [...new Set(ids)];
}

// ── Phase 2: cross-check ─────────────────────────────────────────────────────
async function crossCheck(snap) {
  const all = [...snap.players.keys()];
  const pick = new Set(FORCED_PLAYERS.filter((p) => snap.players.has(p)));
  // deterministic-ish spread across the id space (registry order is the
  // starvation trap the loops fixed; sample the tail too)
  for (let i = 0; pick.size < SAMPLE && i < all.length; i++) pick.add(all[Math.floor((i * 7919) % all.length)]);
  const players = [...pick];
  log(`cross-check ${players.length} players via per-entity reads…`);
  const result = { players: players.length, structs: 0, fields: 0, mismatches: [], missingInSnapshot: [], missingOnChain: [], entityReads: 0 };
  const CONC = 8; let cursor = 0;
  async function worker() {
    while (cursor < players.length) {
      const pid = players[cursor++];
      const { body: pe } = await lcd(`/structs/player/${pid}`); result.entityReads++;
      const P = pe.Player || {};
      const [planet, fleet] = await Promise.all([
        P.planetId ? lcd(`/structs/planet/${P.planetId}`).then((r) => (result.entityReads++, r.body.Planet)).catch(() => null) : null,
        P.fleetId ? lcd(`/structs/fleet/${P.fleetId}`).then((r) => (result.entityReads++, r.body.Fleet)).catch(() => null) : null,
      ]);
      // slot arrays from snapshot vs entity
      const snapIds = playerStructIds(snap.planets.get(P.planetId), snap.fleets.get(P.fleetId));
      const liveIds = playerStructIds(planet, fleet);
      if (snapIds.join() !== liveIds.join()) result.mismatches.push({ pid, field: "struct_ids", snap: snapIds, live: liveIds });
      for (const sid of liveIds) {
        let e; try { e = (await lcd(`/structs/struct/${sid}`)).body; result.entityReads++; } catch { result.missingOnChain.push(sid); continue; }
        const live = recordFromEntity(e), fromSnap = recordFromSnapshot(snap, sid);
        result.structs++;
        if (!fromSnap) { result.missingInSnapshot.push(sid); continue; }
        for (const k of Object.keys(live)) {
          result.fields++;
          if (JSON.stringify(live[k]) !== JSON.stringify(fromSnap[k])) result.mismatches.push({ pid, sid, field: k, snap: fromSnap[k], live: live[k] });
        }
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  log(`cross-check: ${result.structs} structs, ${result.fields} fields, ${result.mismatches.length} mismatches, ${result.entityReads} entity reads`);
  return result;
}

// ── Phase 3: raw NATS-over-WebSocket GRASS listener ─────────────────────────
function grassListen(seconds, onEvent) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GRASS); ws.binaryType = "arraybuffer";
    let buf = new Uint8Array(0); const dec = new TextDecoder(); const encr = new TextEncoder();
    const counts = {}; let frames = 0;
    const send = (s) => ws.send(encr.encode(s));
    ws.onopen = () => log(`grass connected ${GRASS}, listening ${seconds}s`);
    ws.onerror = (e) => reject(new Error(`grass ws error ${e.message || ""}`));
    ws.onmessage = (m) => {
      const chunk = new Uint8Array(m.data);
      const nb = new Uint8Array(buf.length + chunk.length); nb.set(buf); nb.set(chunk, buf.length); buf = nb;
      for (;;) {
        const nl = indexOfCRLF(buf, 0); if (nl < 0) break;
        const line = dec.decode(buf.subarray(0, nl));
        if (line.startsWith("MSG ")) {
          const parts = line.split(" "); const n = Number(parts[parts.length - 1]);
          const start = nl + 2, end = start + n;
          if (buf.length < end + 2) break; // wait for the rest of the payload
          const payload = dec.decode(buf.subarray(start, end)); buf = buf.subarray(end + 2);
          frames++;
          try {
            const raw = JSON.parse(payload);
            // Planet-activity frames carry the row fields NESTED in `detail`
            // (`{subject, planet_id, seq, category, detail:{struct_id, status…}}`);
            // grid/inventory frames are flat. The in-app tap (structs-config.js)
            // merges top-level extras + detail into one object before Rust
            // sees it — mirror that here so the probe applies what the app applies.
            const ev = { ...raw, ...(raw.detail && typeof raw.detail === "object" ? raw.detail : {}) };
            const cat = ev.category || "?"; counts[cat] = (counts[cat] || 0) + 1; onEvent(parts[1], ev);
          } catch {}
          continue;
        }
        buf = buf.subarray(nl + 2);
        if (line.startsWith("INFO")) { send('CONNECT {"verbose":false,"pedantic":false,"protocol":1,"name":"perception-probe"}\r\n'); send("SUB structs.> 1\r\n"); }
        else if (line === "PING") send("PONG\r\n");
      }
    };
    setTimeout(() => { try { ws.close(); } catch {} resolve({ frames, counts }); }, seconds * 1000);
  });
}
function indexOfCRLF(u8, from) { for (let i = from; i + 1 < u8.length; i++) if (u8[i] === 13 && u8[i + 1] === 10) return i; return -1; }

// Apply one GRASS event to a working copy of the snapshot. Values are ABSOLUTE
// (value_p / status / health), so re-applying an already-reflected change is
// harmless — the design is "over-apply is safe, under-apply is the hazard".
function applyEvent(snap, subject, ev, ledger) {
  const cat = ev.category;
  const setAttr = (map, oid, name, val) => { let o = map.get(oid); if (!o) { o = {}; map.set(oid, o); } if (o[name] !== String(val)) { o[name] = String(val); ledger.applied++; } };
  if (subject.startsWith("structs.grid.")) {
    if (ev.object_id && ev.attribute_type != null && ev.value_p != null) { setAttr(snap.grid, ev.object_id, ev.attribute_type, ev.value_p); return true; }
    return false;
  }
  switch (cat) {
    case "struct_status": setAttr(snap.sattr, ev.struct_id, "status", ev.status); return true;
    case "struct_health": setAttr(snap.sattr, ev.struct_id, "health", ev.health); return true;
    case "struct_block_build_start": setAttr(snap.sattr, ev.struct_id, "blockStartBuild", ev.block ?? ev.block_height); ledger.newStructIds.add(ev.struct_id); return true;
    case "struct_defense_add": setAttr(snap.sattr, ev.defender_struct_id, "protectedStructIndex", String(ev.protected_struct_id).split("-")[1]); return true;
    case "struct_defense_remove": setAttr(snap.sattr, ev.defender_struct_id, "protectedStructIndex", 0); return true;
    case "struct_move": { const s = snap.structs.get(ev.struct_id); if (s) { s.locationType = ev.location_type; s.locationId = ev.location_id; s.operatingAmbit = ev.ambit; s.slot = String(ev.slot); ledger.applied++; } return true; }
    case "shield_change": setAttr(snap.pattr, ev.planet_id, "planetaryShield", ev.planetary_shield); return true;
    case "block_raid_start": setAttr(snap.pattr, ev.planet_id, "blockStartRaid", ev.block ?? ev.block_height); return true;
    default: return false;
  }
}

// ── Phase 4: diff two snapshots, classify each on-chain change ──────────────
function diffMaps(name, before, after, hits, misses, applied, keyFilter) {
  const ids = new Set([...before.keys(), ...after.keys()]);
  for (const id of ids) {
    const b = before.get(id) || {}, a = after.get(id) || {};
    for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (keyFilter && !keyFilter(k)) continue;
      const bv = String(b[k] ?? "0"), av = String(a[k] ?? "0");
      if (bv === av) continue;
      const pv = String(applied.get(id)?.[k] ?? bv);
      const bucket = pv === av ? hits : misses;
      const key = `${name}.${k}`; bucket[key] = (bucket[key] || 0) + 1;
    }
  }
}

(async () => {
  const report = { lcd: LCD, grass: GRASS, windowS: WINDOW_S, startedAt: new Date().toISOString() };
  const snap1 = await snapshot();
  report.snapshot1 = { height: snap1.height, minHeight: snap1.minHeight, tookMs: snap1.tookMs, requests: stats.requests, bytes: stats.bytes,
    structs: snap1.structs.size, players: snap1.players.size, planets: snap1.planets.size };
  const reqBefore = stats.requests;
  report.crossCheck = await crossCheck(snap1);
  report.crossCheck.entityReadsForSample = stats.requests - reqBefore;

  // working copy = snapshot1 + events
  const work = { structs: new Map([...snap1.structs].map(([k, v]) => [k, { ...v }])),
    sattr: new Map([...snap1.sattr].map(([k, v]) => [k, { ...v }])), pattr: new Map([...snap1.pattr].map(([k, v]) => [k, { ...v }])),
    grid: new Map([...snap1.grid].map(([k, v]) => [k, { ...v }])) };
  const ledger = { applied: 0, unhandled: {}, newStructIds: new Set(), maxHeight: 0 };
  const grass = await grassListen(WINDOW_S, (subject, ev) => {
    if (ev.block_height) ledger.maxHeight = Math.max(ledger.maxHeight, Number(ev.block_height));
    if (!applyEvent(work, subject, ev, ledger)) ledger.unhandled[ev.category || "?"] = (ledger.unhandled[ev.category || "?"] || 0) + 1;
  });
  report.grass = { frames: grass.frames, categories: grass.counts, applied: ledger.applied, unhandled: ledger.unhandled,
    newStructsAnnounced: ledger.newStructIds.size, maxEventHeight: ledger.maxHeight };
  log(`grass: ${grass.frames} frames, ${ledger.applied} field updates applied, max event height ${ledger.maxHeight}`);

  const reqBefore2 = stats.requests;
  const snap2 = await snapshot();
  report.snapshot2 = { height: snap2.height, minHeight: snap2.minHeight, tookMs: snap2.tookMs, requests: stats.requests - reqBefore2, blocksElapsed: snap2.height - snap1.height };

  const hits = {}, misses = {};
  // Attribute rows of a struct pruned during the window vanish (read back as
  // 0) — that is not a stream miss: the ROW is the existence test, and the
  // destruction itself is a struct_status 7→35 frame. Count those separately.
  const prunedIds = new Set([...snap1.structs.keys()].filter((id) => !snap2.structs.has(id)));
  const sattrLive = new Map([...snap2.sattr].filter(([id]) => !prunedIds.has(id)));
  const sattrBefore = new Map([...snap1.sattr].filter(([id]) => !prunedIds.has(id)));
  diffMaps("sattr", sattrBefore, sattrLive, hits, misses, work.sattr, (k) => k !== "typeCount");
  let prunedWithDestroyEvent = 0;
  for (const id of prunedIds) if ((Number(work.sattr.get(id)?.status) & STATUS.destroyed) !== 0) prunedWithDestroyEvent++;
  diffMaps("pattr", snap1.pattr, snap2.pattr, hits, misses, work.pattr);
  diffMaps("grid", snap1.grid, snap2.grid, hits, misses, work.grid);
  // struct table rows: new / pruned / moved
  let newStructs = 0, newAnnounced = 0, pruned = 0, moved = 0, movedHit = 0;
  for (const [id, s2] of snap2.structs) {
    const s1 = snap1.structs.get(id);
    if (!s1) { newStructs++; if (ledger.newStructIds.has(id)) newAnnounced++; continue; }
    if (s1.locationId !== s2.locationId || s1.operatingAmbit !== s2.operatingAmbit || s1.slot !== s2.slot) {
      moved++; const w = work.structs.get(id); if (w && w.locationId === s2.locationId && w.operatingAmbit === s2.operatingAmbit && String(w.slot) === String(s2.slot)) movedHit++;
    }
  }
  for (const id of snap1.structs.keys()) if (!snap2.structs.has(id)) pruned++;
  report.coverage = { hits, misses, structTable: { newStructs, newAnnouncedByBuildStart: newAnnounced, pruned, prunedWithDestroyEvent, moved, movedHit } };
  const H = Object.values(hits).reduce((a, b) => a + b, 0), M = Object.values(misses).reduce((a, b) => a + b, 0);
  report.coverage.totals = { changedFields: H + M, hit: H, miss: M, hitRate: H + M ? +(H / (H + M)).toFixed(4) : null };
  report.lcdStats = stats;
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ snapshot1: report.snapshot1, crossCheck: { ...report.crossCheck, mismatches: report.crossCheck.mismatches.slice(0, 20) },
    grass: report.grass, snapshot2: report.snapshot2, coverage: report.coverage }, null, 2));
  log(`report → ${OUT}`);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
