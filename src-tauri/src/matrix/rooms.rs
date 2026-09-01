//! A room for an OBJECT, not for an encounter.
//!
//! A raid is an event; a planet is a place and a fleet is a thing. Both of
//! those have a conversation that outlives any one engagement — "we have lost
//! this planet twice this month", "this fleet is short a water hull" — so the
//! room belongs to the object, and a raid is simply the busiest that room ever
//! gets. Both sides of a contested planet end up in its room by joining it,
//! which is why there is no notion of "sides" anywhere in here.
//!
//! Two decisions are encoded, and both were the player's:
//!
//! * **One room per object, permanently.** Planets are raided again and again,
//!   so the scrollback becomes that planet's history rather than a fragment of
//!   one afternoon.
//! * **Hosted by the OWNER's guild.** The defender's guild keeps the record of
//!   its own planet, and the room outlives whoever happens to be attacking it.

/// The object types that get a room.
///
/// Not structs (a struct is a component of a fleet, and its conversation is
/// the fleet's), not providers or guilds (they already have owners and
/// channels), and not players — a player has a DM.
pub fn has_room(kind: u8) -> bool {
    matches!(kind, 2 | 9)
}

/// `2-15361` → `planet-2-15361`, `9-61` → `fleet-9-61`.
///
/// The type is spelled out rather than left as a number so the alias reads as
/// something in a channel list: `#planet-2-15361` says what it is, `#2-15361`
/// does not. The id is kept whole — never a prefix of it — because a truncated
/// chain id is the oldest bug in this codebase.
pub fn alias_localpart(object_id: &str) -> Option<String> {
    let (kind, _) = super::refs::parse_id(object_id)?;
    if !has_room(kind) {
        return None;
    }
    let word = match kind {
        2 => "planet",
        9 => "fleet",
        _ => return None,
    };
    Some(format!("{word}-{object_id}"))
}

/// The full alias, given the server that hosts it.
///
/// Split from [`alias_localpart`] so the naming can be tested without a chain
/// or a homeserver, which is most of what there is to get wrong here.
pub fn alias_on(object_id: &str, server: &str) -> Option<String> {
    let local = alias_localpart(object_id)?;
    let server = server.trim();
    if server.is_empty() {
        return None;
    }
    Some(format!("#{local}:{server}"))
}

/// Who owns this object, and therefore whose guild hosts its room.
///
/// The chain is the authority. Reading the owner from a card the window
/// already holds would be faster and wrong: a planet changes hands, and the
/// room has to follow the CURRENT owner rather than whoever was named in a
/// message somebody sent last week.
async fn owner_of(object_id: &str) -> Option<String> {
    let (kind, _) = super::refs::parse_id(object_id)?;
    let entity = match kind {
        2 => "planet",
        9 => "fleet",
        _ => return None,
    };
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    let v = client.query_entity(entity, object_id).await.ok()?;
    // The chain wraps the record in its type name — `{ "Planet": { … } }`.
    let record = v.get(match kind {
        2 => "Planet",
        _ => "Fleet",
    })?;
    let owner = record.get("owner")?.as_str()?.trim().to_string();
    if owner.is_empty() {
        None
    } else {
        Some(owner)
    }
}

/// The alias this object's room lives at, resolved through its owner.
///
/// `None` rather than an error for every ordinary miss — an id with no room,
/// an owner the directory has not seen, a guild that publishes no homeserver.
/// A caller that cannot find the room simply does not offer one, which is the
/// right behaviour for a rail beside a map.
pub async fn alias_for(object_id: &str) -> Option<String> {
    alias_localpart(object_id)?;                 // reject early: not a room type
    let owner = owner_of(object_id).await?;
    super::directory::ensure_fresh().await;
    let ident = super::directory::get(&owner)?;
    let server = super::directory::server_name_for_guild(&ident.guild_id)?;
    alias_on(object_id, &server)
}

/// The homeserver an alias lives on.
pub fn server_of(alias: &str) -> Option<&str> {
    // An alias is `#localpart:server`. Split from the RIGHT so a localpart
    // that somehow contains a colon cannot steal the server.
    alias.rsplit_once(':').map(|(_, s)| s).filter(|s| !s.is_empty())
}

/// May WE create the room at this alias?
///
/// A client can only claim an alias in its own homeserver's namespace, so this
/// decides whether a missing room is ours to make or somebody else's to wait
/// for. Whole-server equality, never a substring test: `oh.energy` is a
/// suffix of `matrix.oh.energy` and a prefix of `oh.energy.example.com`, and
/// treating either as a match would have us try to create rooms on a server
/// that will refuse us — the same shape as the id prefix-collision bug this
/// codebase has already been bitten by.
pub fn ours_to_create(alias: &str, own_server: &str) -> bool {
    !own_server.is_empty() && server_of(alias) == Some(own_server)
}

/// Which address this object's room has, and whether it is ours to make.
///
/// Split out of `matrix_object_room` because it is the part that has been wrong
/// twice and the part a network call cannot be pointed at. Inputs are what four
/// lookups answered; the output is the decision.
///
/// * `owner` — the owner's guild's alias, or None when the owner cannot be
///   resolved to a guild with a known Matrix server. **This is the common
///   case**, not an edge: most of the galaxy is guilds we hold no config for.
/// * `owner_room` — whether a room exists at that alias.
/// * `mine` — the same object's alias on OUR homeserver.
/// * `mine_room` — whether a room exists at THAT alias.
///
/// Returns `(alias, room_id, can_create)`.
pub fn resolve(
    owner: Option<String>,
    owner_room: Option<String>,
    mine: Option<String>,
    mine_room: Option<String>,
    own_server: &str,
) -> (Option<String>, Option<String>, bool) {
    // The owner's room wins ONLY if it actually exists — joining theirs is what
    // keeps one conversation in one place.
    if let (Some(a), Some(id)) = (&owner, &owner_room) {
        return (Some(a.clone()), Some(id.clone()), false);
    }
    // Otherwise ours, and this must not depend on the owner resolving at all.
    // That dependency was the bug: it left `can_create` false, and a rail with
    // no room has no name, no topic and no composer — unable to START a
    // conversation, only to read one that already existed.
    match mine {
        Some(m) => {
            let can = mine_room.is_none() && ours_to_create(&m, own_server);
            (Some(m), mine_room, can)
        }
        None => (owner, None, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_places_and_things_get_a_room() {
        // A planet is a place; a fleet is a thing. Both outlive a raid.
        assert!(has_room(2));
        assert!(has_room(9));
        // A struct's conversation is its fleet's, a player's is a DM, and a
        // provider or guild already has somewhere to be talked about.
        for kind in [0, 1, 4, 5, 10] {
            assert!(!has_room(kind), "kind {kind} should not get a room");
        }
    }

    #[test]
    fn an_alias_says_what_the_thing_is() {
        assert_eq!(alias_localpart("2-15361").unwrap(), "planet-2-15361");
        assert_eq!(alias_localpart("9-61").unwrap(), "fleet-9-61");
        // Not every id is a room.
        assert!(alias_localpart("5-2184").is_none()); // a struct
        assert!(alias_localpart("1-194").is_none()); // a player
        // Nor is every string an id.
        assert!(alias_localpart("").is_none());
        assert!(alias_localpart("planet").is_none());
        assert!(alias_localpart("2-").is_none());
    }

    #[test]
    fn the_whole_id_survives_into_the_alias() {
        // `2-1` is a prefix of `2-15361`. Two planets must never share a room,
        // and a truncated chain id is the oldest bug in this codebase.
        let a = alias_localpart("2-1").unwrap();
        let b = alias_localpart("2-15361").unwrap();
        assert_ne!(a, b);
        assert!(b.ends_with("-2-15361"));
        assert!(a.ends_with("-2-1"));
    }

    #[test]
    fn the_owners_guild_hosts_it() {
        assert_eq!(
            alias_on("2-15361", "matrix.crew.oh.energy").unwrap(),
            "#planet-2-15361:matrix.crew.oh.energy",
        );
        // The same planet on a different guild's server is a different alias —
        // which is the point: the room follows the OWNER.
        assert_ne!(
            alias_on("2-15361", "matrix.crew.oh.energy"),
            alias_on("2-15361", "matrix.beta.playstructs.com"),
        );
        // No server, no alias: better to have no room than one addressed at
        // nowhere.
        assert!(alias_on("2-15361", "").is_none());
        assert!(alias_on("2-15361", "   ").is_none());
    }

    #[test]
    fn only_our_own_server_is_ours_to_create_on() {
        let mine = alias_on("2-15361", "matrix.oh.energy").unwrap();
        assert!(ours_to_create(&mine, "matrix.oh.energy"));
        // Another guild's planet: theirs to create, ours to wait for.
        assert!(!ours_to_create(&mine, "matrix.beta.playstructs.com"));

        // The collision class. A substring test would call all three of these
        // ours, and each would be a create request the server refuses.
        assert!(!ours_to_create(&mine, "oh.energy"));
        assert!(!ours_to_create(&mine, "matrix.oh.energy.example.com"));
        assert!(!ours_to_create(&alias_on("2-1", "oh.energy").unwrap(), "matrix.oh.energy"));

        // No server on either side is not a match — it is "we do not know",
        // and guessing yes means trying to create somebody else's room.
        assert!(!ours_to_create(&mine, ""));
        assert!(!ours_to_create("#planet-2-1", "matrix.oh.energy"));
        assert!(!ours_to_create("", ""));
    }

    const MINE: &str = "matrix.oh.energy";
    fn s(x: &str) -> Option<String> { Some(x.to_string()) }

    #[test]
    fn an_owner_room_that_exists_is_the_one() {
        // Joining theirs is what keeps one conversation in one place.
        let (alias, room, can) = resolve(
            s("#planet-2-1:their.server"), s("!theirs"),
            s("#planet-2-1:matrix.oh.energy"), None, MINE);
        assert_eq!(alias.as_deref(), Some("#planet-2-1:their.server"));
        assert_eq!(room.as_deref(), Some("!theirs"));
        assert!(!can, "we never create in somebody else's namespace");
    }

    #[test]
    fn an_unresolvable_owner_still_gets_a_room() {
        /* THE BUG, twice over.
         *
         * `alias_for` answers None whenever the owner cannot be resolved to a
         * guild with a known Matrix server — most of the galaxy. That used to
         * end with `can_create: false`, and a rail with no room has no name, no
         * topic and no composer: it could not START a conversation about a
         * planet, only read one that already existed. That is the state every
         * raid window opens in.
         */
        let (alias, room, can) = resolve(
            None, None, s("#planet-2-1:matrix.oh.energy"), None, MINE);
        assert_eq!(alias.as_deref(), Some("#planet-2-1:matrix.oh.energy"));
        assert_eq!(room, None);
        assert!(can, "our own server's alias is always ours to create");
    }

    #[test]
    fn an_owner_with_no_room_yet_falls_back_to_ours() {
        // The owner's guild is known but nobody there has made the room.
        let (alias, _room, can) = resolve(
            s("#planet-2-1:their.server"), None,
            s("#planet-2-1:matrix.oh.energy"), None, MINE);
        assert_eq!(alias.as_deref(), Some("#planet-2-1:matrix.oh.energy"));
        assert!(can);
    }

    #[test]
    fn our_existing_room_is_joined_not_recreated() {
        let (alias, room, can) = resolve(
            None, None, s("#planet-2-1:matrix.oh.energy"), s("!ours"), MINE);
        assert_eq!(alias.as_deref(), Some("#planet-2-1:matrix.oh.energy"));
        assert_eq!(room.as_deref(), Some("!ours"));
        assert!(!can, "it already exists");
    }

    #[test]
    fn it_never_claims_another_servers_namespace() {
        /* `resolve` takes `mine` as a parameter, so it must hold for any input
         * and not merely for the one its caller happens to build. A client can
         * only claim an alias on its OWN homeserver; answering `can_create` for
         * anything else is a create request the server will refuse — and,
         * worse, a composer offered for a room that can never appear.
         */
        let (alias, _room, can) = resolve(
            None, None, s("#planet-2-1:somebody.else"), None, MINE);
        assert_eq!(alias.as_deref(), Some("#planet-2-1:somebody.else"));
        assert!(!can, "not our namespace");
    }

    #[test]
    fn with_no_address_at_all_there_is_nothing_to_create() {
        // No object alias anywhere — a type that gets no room, or no server
        // name known even for us. Must not claim it is creatable.
        let (alias, room, can) = resolve(None, None, None, None, MINE);
        assert_eq!(alias, None);
        assert_eq!(room, None);
        assert!(!can);
    }

    #[test]
    fn the_server_is_taken_from_the_right() {
        assert_eq!(server_of("#planet-2-1:matrix.oh.energy"), Some("matrix.oh.energy"));
        // A colon in the localpart must not become the server.
        assert_eq!(server_of("#odd:name:matrix.oh.energy"), Some("matrix.oh.energy"));
        assert_eq!(server_of("#planet-2-1:"), None);
        assert_eq!(server_of("no-colon"), None);
    }
}
