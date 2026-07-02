//! Guild power-infrastructure resolver — the reactor + entry substation that
//! actually gate the whole fleet's power. Salvaged from the old `structs-bash-bot`
//! growth heuristic (`capacity / (connections + 1)`), which live data confirms:
//! the entry substation's `connectionCapacity` == `capacity / connectionCount`,
//! so every new connection dilutes everyone's per-player share.
//!
//! Used by the Team Ops board (telemetry) and the vplayer-create power guard.
//! All chain numerics arrive as JSON strings (see [[structs_data_shape_gotchas]]),
//! and the power fields live in a `gridAttributes` sub-object, not the entity
//! wrapper.

use crate::mcp::cosmos_client::CosmosClient;
use serde_json::Value;

/// Floor estimate of how much capacity one connected player consumes, used to
/// translate substation capacity into "how many players can we still power".
/// Chain power is in MILLIWATTS (keeper `PlayerPassiveDraw = 25000` mW = 25 W;
/// 1 kW = 1,000,000 mW). A fully-built productive player draws ~1,075,000 mW
/// (≈1.075 kW: base 25k + Command Ship 50k + Ore Extractor 500k + Refinery 500k);
/// our defended vplayers observe ~1,400,000 mW (≈1.4 kW) with defenders/PDC/OSG.
/// All `guild_power` values are raw chain mW; divide by 1e6 for kW.
pub const MIN_PLAYER_DRAW_MW: f64 = 1_400_000.0;

#[derive(Debug, Clone, Default)]
pub struct GuildPower {
    pub guild_id: String,
    pub reactor_id: String,
    pub substation_id: String,
    /// On-chain owner ids (player ids) of the reactor / entry substation, so
    /// callers can decide — for ANY operator, not just this guild — whether the
    /// flywheel can close the loop (we own the substation) or only grows the
    /// infuser's personal capacity (someone else owns it). Empty if unresolved.
    pub reactor_owner: String,
    pub substation_owner: String,
    /// The reactor's validator operator address — infusing = delegating to it.
    pub reactor_validator: String,
    // Reactor
    pub reactor_fuel: f64,
    pub reactor_capacity: f64,
    pub reactor_load: f64,
    pub reactor_commission: f64,
    // Entry substation
    pub sub_capacity: f64,
    pub sub_connection_capacity: f64,
    pub sub_connection_count: u64,
    pub sub_load: f64,
    /// Derived: per-connection share if one more player connects, matching the
    /// keeper's `connectionCapacity = (capacity - load) / connectionCount`
    /// (grid_context.go) — i.e. AVAILABLE capacity over count+1.
    pub share_if_one_more: f64,
    /// Derived: how many MORE players the substation can power at `MIN_PLAYER_DRAW_MW`
    /// each (guild-wide; can be negative if already oversubscribed).
    pub supportable_more: i64,
}

/// The growth heuristic, matching the chain keeper exactly: the entry
/// substation's per-connection share is `connectionCapacity = available /
/// connectionCount` where `available = capacity - load` (grid_context.go), so
/// adding one more connection dilutes everyone to `available / (count + 1)`.
/// Pass `available_capacity` (already net of substation load). Returns
/// `(share_if_one_more, supportable_more)` — the latter is how many additional
/// players fit at `min_draw` each (guild-wide; may be negative).
pub fn derive_headroom(available_capacity: f64, connection_count: u64, min_draw: f64) -> (f64, i64) {
    let available = available_capacity.max(0.0);
    let share_if_one_more = if connection_count > 0 {
        available / (connection_count as f64 + 1.0)
    } else {
        available
    };
    let supportable_more = if min_draw > 0.0 {
        (available / min_draw).floor() as i64 - connection_count as i64
    } else {
        0
    };
    (share_if_one_more, supportable_more)
}

/// Computed amounts for the hybrid "owned hub" infrastructure plan: infuse some
/// alpha, keep enough personal capacity to expand, donate the rest into a shared
/// substation. 1 ualpha → 1 mW of capacity (minus the reactor's commission).
/// NB the `_mw` fields below hold raw chain milliwatts; divide by 1e6 for kW.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct InfraPlan {
    pub infuse_ualpha: f64,
    pub gained_capacity_mw: f64, // to the infuser's personal capacity
    pub commission_mw: f64,      // to the reactor (lost to the infuser)
    pub keep_mw: f64,            // kept as personal capacity for own expansion
    pub donate_mw: f64,          // routed out to the shared substation
    pub own_share_gain_mw: f64,  // what feeding the shared pool returns to YOUR connection (donate / connections)
}

/// Plan the infra amounts. `infuse_ualpha`/`keep_w` override the defaults
/// (infuse half your alpha; keep 2× your current struct draw so you can expand).
pub fn plan_infra(
    available_ualpha: f64,
    structs_load_mw: f64,
    commission: f64,
    connection_count: u64,
    infuse_ualpha: Option<f64>,
    keep_w: Option<f64>,
) -> InfraPlan {
    let infuse = infuse_ualpha.unwrap_or(available_ualpha / 2.0).clamp(0.0, available_ualpha);
    let gained = infuse * (1.0 - commission);
    let commission_mw = infuse * commission;
    let keep = keep_w.unwrap_or(structs_load_mw * 2.0).clamp(0.0, gained);
    let donate = (gained - keep).max(0.0);
    let own_share_gain_mw = if connection_count > 0 {
        donate / connection_count as f64
    } else {
        donate
    };
    InfraPlan {
        infuse_ualpha: infuse,
        gained_capacity_mw: gained,
        commission_mw,
        keep_mw: keep,
        donate_mw: donate,
        own_share_gain_mw,
    }
}

use crate::mcp::loop_util::parse_f64 as num;

/// Resolve the guild's reactor + entry substation into one power picture.
pub async fn resolve_guild_power(
    client: &CosmosClient,
    guild_id: &str,
) -> Result<GuildPower, String> {
    let guild = client.query_entity("guild", guild_id).await?;
    let g = guild.get("Guild").ok_or("guild entity missing 'Guild'")?;
    let substation_id = g
        .get("entrySubstationId")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let reactor_id = g
        .get("primaryReactorId")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();

    let mut out = GuildPower {
        guild_id: guild_id.to_string(),
        reactor_id: reactor_id.clone(),
        substation_id: substation_id.clone(),
        ..Default::default()
    };

    let owner_of = |entity: &Value, wrapper: &str| -> String {
        entity
            .get(wrapper)
            .and_then(|x| x.get("owner"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string()
    };

    // ── Entry substation (the pool every connected player draws from) ──
    if !substation_id.is_empty() {
        if let Ok(sub) = client.query_entity("substation", &substation_id).await {
            let ga = sub.get("gridAttributes");
            out.sub_capacity = num(ga.and_then(|x| x.get("capacity")));
            out.sub_connection_capacity = num(ga.and_then(|x| x.get("connectionCapacity")));
            out.sub_connection_count =
                num(ga.and_then(|x| x.get("connectionCount"))) as u64;
            out.sub_load = num(ga.and_then(|x| x.get("load")));
            out.substation_owner = owner_of(&sub, "Substation");
        }
    }

    // ── Primary reactor (fuel + commission) ──
    if !reactor_id.is_empty() {
        if let Ok(reactor) = client.query_entity("reactor", &reactor_id).await {
            let ga = reactor.get("gridAttributes");
            out.reactor_fuel = num(ga.and_then(|x| x.get("fuel")));
            out.reactor_capacity = num(ga.and_then(|x| x.get("capacity")));
            out.reactor_load = num(ga.and_then(|x| x.get("load")));
            out.reactor_commission =
                num(reactor.get("Reactor").and_then(|x| x.get("defaultCommission")));
            out.reactor_owner = owner_of(&reactor, "Reactor");
            out.reactor_validator = reactor
                .get("Reactor")
                .and_then(|x| x.get("validator"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
        }
    }

    // ── Derived growth headroom ── (available = capacity − load, per keeper)
    let available = (out.sub_capacity - out.sub_load).max(0.0);
    let (share, more) = derive_headroom(available, out.sub_connection_count, MIN_PLAYER_DRAW_MW);
    out.share_if_one_more = share;
    out.supportable_more = more;

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headroom_matches_live_substation() {
        // Live substation 4-1: capacity 1,512,960,000, load 0, 220 connections →
        // connectionCapacity (1.512B-0)/220 ≈ 6.877M, matching the chain value.
        let (share, more) = derive_headroom(1_512_960_000.0, 220, MIN_PLAYER_DRAW_MW);
        // One more connection dilutes the per-connection share slightly.
        assert!((share - 1_512_960_000.0 / 221.0).abs() < 1.0);
        assert!(share < 6_877_091.0 && share > 6_800_000.0);
        // At ~1.4M each the 1.5B pool supports ~1080 connections → ~860 more.
        assert_eq!(more, (1_512_960_000.0 / MIN_PLAYER_DRAW_MW).floor() as i64 - 220);
        assert!(more > 800);
    }

    #[test]
    fn headroom_zero_connections_uses_full_capacity() {
        let (share, more) = derive_headroom(6_000_000.0, 0, 1_400_000.0);
        assert_eq!(share, 6_000_000.0);
        assert_eq!(more, 4); // floor(6M / 1.4M) - 0
    }

    #[test]
    fn infra_plan_defaults_and_dilution() {
        // Live-ish: 56M ualpha, structsLoad 6.49M, 4% commission, 220 connections.
        let p = plan_infra(56_000_000.0, 6_490_000.0, 0.04, 220, None, None);
        assert_eq!(p.infuse_ualpha, 28_000_000.0); // half
        assert!((p.gained_capacity_mw - 28_000_000.0 * 0.96).abs() < 1.0); // 26.88M
        assert!((p.commission_mw - 28_000_000.0 * 0.04).abs() < 1.0); // 1.12M
        assert_eq!(p.keep_mw, 12_980_000.0); // 2× struct draw
        assert!((p.donate_mw - (26_880_000.0 - 12_980_000.0)).abs() < 1.0); // 13.9M
        // Dilution: donating 13.9M across 220 connections returns only ~63k to us.
        assert!((p.own_share_gain_mw - p.donate_mw / 220.0).abs() < 1.0);
        assert!(p.own_share_gain_mw < 64_000.0);
    }

    #[test]
    fn infra_plan_keep_clamped_to_gained() {
        // If keep exceeds what you gained, donate is zero (not negative).
        let p = plan_infra(1_000_000.0, 0.0, 0.04, 10, Some(1_000_000.0), Some(5_000_000.0));
        assert_eq!(p.donate_mw, 0.0);
        assert_eq!(p.keep_mw, p.gained_capacity_mw);
    }
}
