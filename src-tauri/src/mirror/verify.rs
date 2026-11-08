//! Verified state: a CometBFT light client and ICS-23 state proofs, so a fact
//! that decides an action can be PROVEN against the chain rather than taken
//! from whichever endpoint answered.
//!
//! Two independent checks, both pure given their inputs:
//!
//! * **Headers.** A header is trusted only when validators holding more than
//!   the trust threshold (1/3) of a set we already trust signed it
//!   (`tendermint-light-client-verifier`, skipping verification), within the
//!   trusting period (3 days; the chain unbonds in 4). The first trusted
//!   header is an ANCHOR: pinned by the caller, or taken on first use — and
//!   then labelled as such, never presented as stronger than it is.
//! * **Values.** The node's `abci_query … prove=true` answer carries two
//!   proof ops: IAVL from the key to the `structs` store root, then a simple
//!   Merkle step from the store root to the app hash. State after block H is
//!   committed by header H+1's `app_hash`, so a value read at H is checked
//!   against the verified header H+1. An absent key carries a non-membership
//!   proof — absence is proven too, never assumed.
//!
//! The Structs module stores every attribute as 8-byte big-endian under
//! `Grid/attribute/`, `Planet/attribute/` or `Struct/attribute/` + the
//! attribute id `<type index>-<object id>` (x/structs/types/keys.go,
//! keeper/grid.go `GetGridAttributeIDByObjectId`).

use serde::Serialize;
use serde_json::Value;

use tendermint::block::signed_header::SignedHeader;
use tendermint::validator::{Info as ValidatorInfo, Set as ValidatorSet};
use tendermint_light_client_verifier::options::Options as LcOptions;
use tendermint_light_client_verifier::types::{TrustThreshold, TrustedBlockState, UntrustedBlockState};
use tendermint_light_client_verifier::{ProdVerifier, Verdict, Verifier};

/// The chain's unbonding period is 4 days; trust a validator set for 3.
pub const TRUSTING_PERIOD_SECS: u64 = 3 * 24 * 3600;
const CLOCK_DRIFT_SECS: u64 = 10;
/// The multistore key of the Structs module.
pub const STORE: &[u8] = b"structs";

// ── Store keys ───────────────────────────────────────────────────────────────

/// Which attribute store a value lives in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
pub enum Store {
    Grid,
    Planet,
    Struct,
}

impl Store {
    fn prefix(self) -> &'static str {
        match self {
            Store::Grid => "Grid/attribute/",
            Store::Planet => "Planet/attribute/",
            Store::Struct => "Struct/attribute/",
        }
    }
    /// The attribute names in enum order — the index is the id prefix.
    fn names(self) -> &'static [&'static str] {
        match self {
            Store::Grid => &crate::mcp::perception::GRID_ATTRS,
            Store::Planet => &crate::mcp::perception::PLANET_ATTRS,
            Store::Struct => &crate::mcp::perception::STRUCT_ATTRS,
        }
    }
}

/// The raw store key of `attribute` of `object`, e.g. grid lastAction of
/// player 1-194 → `Grid/attribute/11-1-194`.
pub fn attribute_key(store: Store, attribute: &str, object: &str) -> Option<Vec<u8>> {
    let index = store.names().iter().position(|n| *n == attribute)?;
    Some(format!("{}{index}-{object}", store.prefix()).into_bytes())
}

// ── Value proofs ─────────────────────────────────────────────────────────────

/// One `proofOps.ops[]` entry from the RPC answer.
#[derive(Clone, Debug)]
pub struct ProofOp {
    pub kind: String,
    pub key: Vec<u8>,
    pub data: Vec<u8>,
}

fn b64(v: &Value) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    match v {
        Value::Null => Ok(Vec::new()),
        Value::String(s) => base64::engine::general_purpose::STANDARD.decode(s).map_err(|e| format!("base64: {e}")),
        _ => Err("expected a base64 string".into()),
    }
}

/// A proven read, as the RPC returned it.
#[derive(Clone, Debug)]
pub struct ProvenRead {
    pub key: Vec<u8>,
    /// `None` = the key is absent at this height.
    pub value: Option<Vec<u8>>,
    pub height: u64,
    pub ops: Vec<ProofOp>,
}

/// Parse `result.response` of `/abci_query?…&prove=true`.
pub fn parse_abci_query(resp: &Value) -> Result<ProvenRead, String> {
    let r = resp.get("result").and_then(|x| x.get("response")).unwrap_or(resp);
    if r.get("code").and_then(|c| c.as_u64()).unwrap_or(0) != 0 {
        return Err(format!("abci_query refused: {}", r.get("log").and_then(|l| l.as_str()).unwrap_or("")));
    }
    let height = crate::mcp::types::numeric_u64(r.get("height")).ok_or("abci_query: no height")?;
    let value = b64(r.get("value").unwrap_or(&Value::Null))?;
    let ops = r
        .get("proofOps")
        .and_then(|p| p.get("ops"))
        .and_then(|o| o.as_array())
        .ok_or("abci_query: no proof ops (was prove=true honoured?)")?
        .iter()
        .map(|op| {
            Ok(ProofOp {
                kind: op.get("type").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                key: b64(op.get("key").unwrap_or(&Value::Null))?,
                data: b64(op.get("data").unwrap_or(&Value::Null))?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(ProvenRead { key: b64(r.get("key").unwrap_or(&Value::Null))?, value: (!value.is_empty()).then_some(value), height, ops })
}

fn decode_proof(data: &[u8]) -> Result<ics23::CommitmentProof, String> {
    use prost013::Message as _;
    ics23::CommitmentProof::decode(data).map_err(|e| format!("proof decode: {e}"))
}

/// The root an existence (or the neighbour of a non-existence) proof commits to.
fn proof_root(p: &ics23::CommitmentProof) -> Result<Vec<u8>, String> {
    use ics23::commitment_proof::Proof;
    let exist = match &p.proof {
        Some(Proof::Exist(e)) => e.clone(),
        Some(Proof::Nonexist(n)) => n.left.clone().or_else(|| n.right.clone()).ok_or("non-existence proof with no neighbours")?,
        _ => return Err("unsupported proof shape".into()),
    };
    ics23::calculate_existence_root::<ics23::HostFunctionsManager>(&exist).map_err(|e| format!("root: {e}"))
}

/// Check a proven read against an app hash: `key` → (`value` | absent) in
/// the Structs store, the store root → `app_hash`. Pure.
pub fn verify_read(read: &ProvenRead, app_hash: &[u8]) -> Result<(), String> {
    let [iavl, simple] = read.ops.as_slice() else {
        return Err(format!("expected 2 proof ops, got {}", read.ops.len()));
    };
    if iavl.kind != "ics23:iavl" || simple.kind != "ics23:simple" {
        return Err(format!("unexpected proof ops {} / {}", iavl.kind, simple.kind));
    }
    if iavl.key != read.key || simple.key != STORE {
        return Err("proof ops are for a different key or store".into());
    }
    let store_proof = decode_proof(&iavl.data)?;
    let store_root = proof_root(&store_proof)?;
    let spec = ics23::iavl_spec();
    let ok = match &read.value {
        Some(v) => ics23::verify_membership::<ics23::HostFunctionsManager>(&store_proof, &spec, &store_root, &read.key, v),
        None => ics23::verify_non_membership::<ics23::HostFunctionsManager>(&store_proof, &spec, &store_root, &read.key),
    };
    if !ok {
        return Err("the value does not match its store proof".into());
    }
    let root_proof = decode_proof(&simple.data)?;
    let app: Vec<u8> = app_hash.to_vec();
    if !ics23::verify_membership::<ics23::HostFunctionsManager>(&root_proof, &ics23::tendermint_spec(), &app, STORE, &store_root) {
        return Err("the store root does not match the app hash".into());
    }
    Ok(())
}

/// A proven u64 attribute: 0 when the key is (provably) absent.
pub fn read_u64(read: &ProvenRead) -> Result<u64, String> {
    match &read.value {
        None => Ok(0),
        Some(v) if v.len() == 8 => Ok(u64::from_be_bytes(v[..].try_into().unwrap())),
        Some(v) => Err(format!("attribute value is {} bytes, not 8", v.len())),
    }
}

// ── Light client ─────────────────────────────────────────────────────────────

/// How the trust anchor was established.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Anchor {
    /// The caller pinned this header's hash from a source it trusts.
    Pinned,
    /// Taken on first use from the node: everything after it is verified,
    /// the anchor itself is only as trustworthy as that first answer.
    FirstUse,
}

/// A header the client trusts, and the next validator set it commits to.
#[derive(Clone, Debug)]
pub struct Trusted {
    pub signed_header: SignedHeader,
    pub next_validators: ValidatorSet,
    pub anchor: Anchor,
}

impl Trusted {
    pub fn height(&self) -> u64 {
        self.signed_header.header.height.value()
    }
    pub fn app_hash(&self) -> Vec<u8> {
        self.signed_header.header.app_hash.as_bytes().to_vec()
    }
}

/// Parse `/commit` → SignedHeader.
pub fn parse_commit(v: &Value) -> Result<SignedHeader, String> {
    let sh = v.get("result").and_then(|r| r.get("signed_header")).ok_or("commit: no signed_header")?;
    serde_json::from_value(sh.clone()).map_err(|e| format!("commit: {e}"))
}

/// Parse a complete `/validators` answer (all pages concatenated by the caller).
pub fn parse_validators(rows: &[Value]) -> Result<ValidatorSet, String> {
    let infos: Vec<ValidatorInfo> = rows
        .iter()
        .map(|r| serde_json::from_value(r.clone()).map_err(|e| format!("validator: {e}")))
        .collect::<Result<_, _>>()?;
    Ok(ValidatorSet::without_proposer(infos))
}

fn now_tm() -> tendermint::Time {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    tendermint::Time::from_unix_timestamp(d.as_secs() as i64, d.subsec_nanos()).expect("clock within range")
}

fn options() -> LcOptions {
    LcOptions {
        trust_threshold: TrustThreshold::ONE_THIRD,
        trusting_period: std::time::Duration::from_secs(TRUSTING_PERIOD_SECS),
        clock_drift: std::time::Duration::from_secs(CLOCK_DRIFT_SECS),
    }
}

/// The outcome of verifying an untrusted header against a trusted one.
#[derive(Debug, PartialEq)]
pub enum Step {
    Verified,
    /// Too little of the trusted set signed: verify a header in between first.
    NeedsBisection,
    Invalid(String),
}

/// Verify `untrusted` (with its validator sets) against `trusted`. Pure but
/// for the clock.
pub fn verify_header(trusted: &Trusted, untrusted: &SignedHeader, validators: &ValidatorSet, next_validators: &ValidatorSet) -> Step {
    let chain_id = trusted.signed_header.header.chain_id.clone();
    let t = TrustedBlockState {
        chain_id: &chain_id,
        header_time: trusted.signed_header.header.time,
        height: trusted.signed_header.header.height,
        next_validators: &trusted.next_validators,
        next_validators_hash: trusted.signed_header.header.next_validators_hash,
    };
    let u = UntrustedBlockState { signed_header: untrusted, validators, next_validators: Some(next_validators) };
    match ProdVerifier::default().verify_update_header(u, t, &options(), now_tm()) {
        Verdict::Success => Step::Verified,
        Verdict::NotEnoughTrust(_) => Step::NeedsBisection,
        Verdict::Invalid(e) => Step::Invalid(format!("{e:?}")),
    }
}

// ── Talking to a node ────────────────────────────────────────────────────────

/// A CometBFT RPC endpoint (`https://host:26657`).
#[derive(Clone, Debug)]
pub struct Rpc {
    pub base: String,
}

impl Rpc {
    async fn get(&self, path: &str) -> Result<Value, String> {
        crate::mcp::cosmos_client::get_json(&format!("{}{}", self.base.trim_end_matches('/'), path)).await
    }

    pub async fn commit(&self, height: u64) -> Result<SignedHeader, String> {
        parse_commit(&self.get(&format!("/commit?height={height}")).await?)
    }

    pub async fn validators(&self, height: u64) -> Result<ValidatorSet, String> {
        let mut rows = Vec::new();
        for page in 1..=10u32 {
            let v = self.get(&format!("/validators?height={height}&page={page}&per_page=100")).await?;
            let r = v.get("result").ok_or("validators: no result")?;
            let total = crate::mcp::types::numeric_u64(r.get("total")).unwrap_or(0) as usize;
            rows.extend(r.get("validators").and_then(|x| x.as_array()).cloned().unwrap_or_default());
            if rows.len() >= total {
                break;
            }
        }
        parse_validators(&rows)
    }

    pub async fn latest_height(&self) -> Result<u64, String> {
        let v = self.get("/status").await?;
        v.get("result")
            .and_then(|r| r.get("sync_info"))
            .and_then(|s| crate::mcp::types::numeric_u64(s.get("latest_block_height")))
            .ok_or_else(|| "status: no latest_block_height".into())
    }

    /// A proven read of `key` in the Structs store at `height`.
    pub async fn query(&self, key: &[u8], height: Option<u64>) -> Result<ProvenRead, String> {
        let h = height.map(|h| format!("&height={h}")).unwrap_or_default();
        let v = self.get(&format!("/abci_query?path=%22/store/structs/key%22&data=0x{}&prove=true{h}", hex::encode(key))).await?;
        parse_abci_query(&v)
    }
}

/// A light client: one trusted header, advanced by verified skips.
pub struct LightClient {
    pub rpc: Rpc,
    pub trusted: Trusted,
}

impl LightClient {
    /// Anchor at `height`: pinned to `expected_hash` when given, else on
    /// first use.
    pub async fn anchor(rpc: Rpc, height: u64, expected_hash: Option<&str>) -> Result<Self, String> {
        let sh = rpc.commit(height).await?;
        let anchor = match expected_hash {
            Some(h) => {
                let got = sh.header.hash().to_string();
                if !got.eq_ignore_ascii_case(h) {
                    return Err(format!("header {height} hash {got} is not the pinned {h}"));
                }
                Anchor::Pinned
            }
            None => Anchor::FirstUse,
        };
        // The anchor's own commit must still be signed by its own set.
        let vals = rpc.validators(height).await?;
        if sh.header.validators_hash != vals.hash() {
            return Err("anchor validator set does not match its header".into());
        }
        let next_validators = rpc.validators(height + 1).await?;
        if sh.header.next_validators_hash != next_validators.hash() {
            return Err("anchor next validator set does not match its header".into());
        }
        Ok(LightClient { rpc, trusted: Trusted { signed_header: sh, next_validators, anchor } })
    }

    /// Advance trust to `target` (skipping, bisecting when a skip carries too
    /// little of the trusted set). Returns the verified header.
    pub async fn verify_to(&mut self, target: u64) -> Result<Trusted, String> {
        if target <= self.trusted.height() {
            return Err(format!("target {target} is not after the trusted {}", self.trusted.height()));
        }
        let mut goal = target;
        for _ in 0..64 {
            let sh = self.rpc.commit(goal).await?;
            let vals = self.rpc.validators(goal).await?;
            let next = self.rpc.validators(goal + 1).await?;
            match verify_header(&self.trusted, &sh, &vals, &next) {
                Step::Verified => {
                    self.trusted = Trusted { signed_header: sh, next_validators: next, anchor: self.trusted.anchor };
                    if goal == target {
                        return Ok(self.trusted.clone());
                    }
                    goal = target;
                }
                Step::NeedsBisection => {
                    let mid = self.trusted.height() + (goal - self.trusted.height()) / 2;
                    if mid == self.trusted.height() {
                        return Err("bisection exhausted".into());
                    }
                    goal = mid;
                }
                Step::Invalid(e) => return Err(format!("header {goal} failed verification: {e}")),
            }
        }
        Err("too many verification steps".into())
    }
}

/// A value proven against a verified header.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Proven {
    pub store: Store,
    pub attribute: String,
    pub object: String,
    pub value: u64,
    /// State after this block (the proof's height).
    pub height: u64,
    /// The verified header whose app hash commits that state (height + 1).
    pub header_height: u64,
    pub anchor: Anchor,
}

/// Blocks below the node's tip a proven read is taken at: its committing
/// header (height + 1) must exist and be final, and that header's next
/// validator set must be known.
pub const PROOF_LAG: u64 = 2;

/// Read and prove one attribute at the newest height whose committing header
/// can be verified (tip − [`PROOF_LAG`]).
pub async fn prove_attribute(lc: &mut LightClient, store: Store, attribute: &str, object: &str) -> Result<Proven, String> {
    let key = attribute_key(store, attribute, object).ok_or_else(|| format!("{attribute} is not a {store:?} attribute"))?;
    let tip = lc.rpc.latest_height().await?;
    let at = tip.saturating_sub(PROOF_LAG).max(lc.trusted.height());
    let read = lc.rpc.query(&key, Some(at)).await?;
    let header = if lc.trusted.height() == read.height + 1 {
        lc.trusted.clone()
    } else {
        lc.verify_to(read.height + 1).await?
    };
    verify_read(&read, &header.app_hash())?;
    Ok(Proven {
        store,
        attribute: attribute.to_string(),
        object: object.to_string(),
        value: read_u64(&read)?,
        height: read.height,
        header_height: header.height(),
        anchor: header.anchor,
    })
}

// ── The app's light client ───────────────────────────────────────────────────

/// What survives a restart: the last header the client verified, so trust
/// continues instead of re-anchoring on first use every launch.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
struct SavedTrust {
    chain_id: String,
    rpc: String,
    height: u64,
    hash: String,
    anchor: Anchor,
    /// Header time (unix s): past the trusting period the chain of trust is
    /// broken and the client re-anchors (and says so).
    header_unix: i64,
}

// Test builds keep their own files, so a live test never leaves a pin or a
// trust anchor behind for the real app.
#[cfg(not(test))]
const SAVED: &str = "light_client_trust";
#[cfg(test)]
const SAVED: &str = "light_client_trust_test";
#[cfg(not(test))]
const PIN: &str = "light_client_pin";
#[cfg(test)]
const PIN: &str = "light_client_pin_test";

/// A trust anchor the user pinned: a header hash from a source they trust
/// (their guild, a block explorer, a node they run). Checked before it is
/// accepted, and kept apart from the rolling trust so it survives it.
#[derive(Clone, Debug, Serialize, serde::Deserialize, PartialEq)]
pub struct Pin {
    pub rpc: String,
    pub chain_id: String,
    pub height: u64,
    pub hash: String,
    /// The pinned header's time (unix s): past the trusting period it can no
    /// longer anchor anything.
    pub header_unix: i64,
}

fn remove_cache(name: &str) {
    if let Some(p) = crate::mcp::cache_store::cache_path(name) {
        let _ = std::fs::remove_file(p);
    }
}

/// Whether a header of this time is still within the trusting period.
fn within_trust(header_unix: i64) -> bool {
    now_tm().unix_timestamp() - header_unix < TRUSTING_PERIOD_SECS as i64
}

static CLIENT: std::sync::LazyLock<tokio::sync::Mutex<Option<LightClient>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(None));

/// The CometBFT RPC from the active guild config (`client_ws` is the RPC
/// websocket; the same host serves HTTP JSON-RPC).
pub fn rpc_from_config() -> Option<Rpc> {
    let ws = crate::guild_config::get_active_guild_config()?.client_ws;
    let base = ws.replacen("wss://", "https://", 1).replacen("ws://", "http://", 1);
    let base = base.trim_end_matches("/websocket").trim_end_matches('/').to_string();
    (!base.is_empty()).then_some(Rpc { base })
}

fn save_trust(lc: &LightClient) {
    let h = &lc.trusted.signed_header.header;
    crate::mcp::cache_store::save(
        SAVED,
        &SavedTrust {
            chain_id: h.chain_id.to_string(),
            rpc: lc.rpc.base.clone(),
            height: h.height.value(),
            hash: h.hash().to_string(),
            anchor: lc.trusted.anchor,
            header_unix: h.time.unix_timestamp(),
        },
    );
}

async fn ensure_client(slot: &mut Option<LightClient>) -> Result<(), String> {
    let rpc = rpc_from_config().ok_or("no RPC endpoint in the guild config")?;
    if slot.as_ref().is_some_and(|lc| lc.rpc.base == rpc.base) {
        return Ok(());
    }
    // 1. Continue the chain of trust from the last verified header, keeping
    //    the label it already had.
    let saved: Option<SavedTrust> = crate::mcp::cache_store::load(SAVED);
    if let Some(t) = saved.filter(|t| t.rpc == rpc.base && within_trust(t.header_unix)) {
        if let Ok(mut lc) = LightClient::anchor(rpc.clone(), t.height, Some(&t.hash)).await {
            lc.trusted.anchor = t.anchor;
            *slot = Some(lc);
            return Ok(());
        }
    }
    // 2. Re-anchor at the pin, if one is set and still within the trusting
    //    period.
    let pin: Option<Pin> = crate::mcp::cache_store::load(PIN);
    if let Some(p) = pin.filter(|p| p.rpc == rpc.base) {
        if within_trust(p.header_unix) {
            let lc = LightClient::anchor(rpc.clone(), p.height, Some(&p.hash)).await?;
            save_trust(&lc);
            *slot = Some(lc);
            return Ok(());
        }
        crate::mcp::telemetry::tlog(
            "mirror",
            crate::mcp::telemetry::Sev::Warn,
            format!("pinned anchor at {} is past the {}-day trusting period — re-anchoring on first use; pin a recent header", p.height, TRUSTING_PERIOD_SECS / 86_400),
        );
    }
    // 3. First use: the node's own header, labelled as such.
    let tip = rpc.latest_height().await?;
    let lc = LightClient::anchor(rpc, tip.saturating_sub(PROOF_LAG + 1), None).await?;
    crate::mcp::telemetry::tlog(
        "mirror",
        crate::mcp::telemetry::Sev::Notice,
        format!("light client anchored on first use at {}", lc.trusted.height()),
    );
    save_trust(&lc);
    *slot = Some(lc);
    Ok(())
}

/// Pin the trust anchor to header `height` with hash `hash`. Refused unless
/// the node's header at that height has exactly that hash, its validator sets
/// match it, it is within the trusting period, AND the chain from it to the
/// current tip verifies by validator signatures. On success the light client
/// is re-anchored there and everything it verifies is labelled `pinned`.
pub async fn pin(height: u64, hash: &str) -> Result<TrustStatus, String> {
    let rpc = rpc_from_config().ok_or("no RPC endpoint in the guild config")?;
    let hash = hash.trim().trim_start_matches("0x").to_ascii_uppercase();
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("a header hash is 64 hex characters".into());
    }
    let mut lc = LightClient::anchor(rpc.clone(), height, Some(&hash)).await?;
    let header_unix = lc.trusted.signed_header.header.time.unix_timestamp();
    if !within_trust(header_unix) {
        return Err(format!("header {height} is older than the {}-day trusting period — pin a more recent one", TRUSTING_PERIOD_SECS / 86_400));
    }
    let tip = rpc.latest_height().await?;
    let target = tip.saturating_sub(PROOF_LAG) + 1;
    if target > height {
        lc.verify_to(target).await.map_err(|e| format!("the chain from the pin to the tip does not verify: {e}"))?;
    }
    let chain_id = lc.trusted.signed_header.header.chain_id.to_string();
    crate::mcp::cache_store::save(PIN, &Pin { rpc: rpc.base.clone(), chain_id, height, hash: hash.clone(), header_unix });
    save_trust(&lc);
    *CLIENT.lock().await = Some(lc);
    crate::mcp::telemetry::tlog("mirror", crate::mcp::telemetry::Sev::Notice, format!("light client anchor pinned at {height} ({hash})"));
    status().await
}

/// Drop the pin and the trust that grew from it; the next proof re-anchors
/// on first use.
pub async fn clear_pin() -> TrustStatus {
    remove_cache(PIN);
    remove_cache(SAVED);
    *CLIENT.lock().await = None;
    status().await.unwrap_or_else(|e| TrustStatus { error: Some(e), ..TrustStatus::default() })
}

/// What the light client trusts right now.
#[derive(Clone, Debug, Default, Serialize)]
pub struct TrustStatus {
    pub rpc: Option<String>,
    pub chain_id: Option<String>,
    /// `pinned` or `first_use`; `None` before the first proof.
    pub anchor: Option<Anchor>,
    pub trusted_height: Option<u64>,
    /// Compare this with a source you trust before pinning it.
    pub trusted_hash: Option<String>,
    pub trusted_age_s: Option<i64>,
    pub pin: Option<Pin>,
    pub pin_expired: bool,
    pub trusting_period_s: u64,
    pub error: Option<String>,
}

/// The light client's state, establishing trust if none yet.
pub async fn status() -> Result<TrustStatus, String> {
    let mut slot = CLIENT.lock().await;
    let ensured = ensure_client(&mut slot).await;
    let pin: Option<Pin> = crate::mcp::cache_store::load(PIN);
    let mut st = TrustStatus {
        rpc: rpc_from_config().map(|r| r.base),
        pin_expired: pin.as_ref().is_some_and(|p| !within_trust(p.header_unix)),
        pin,
        trusting_period_s: TRUSTING_PERIOD_SECS,
        error: ensured.err(),
        ..TrustStatus::default()
    };
    if let Some(lc) = slot.as_ref() {
        let h = &lc.trusted.signed_header.header;
        st.chain_id = Some(h.chain_id.to_string());
        st.anchor = Some(lc.trusted.anchor);
        st.trusted_height = Some(h.height.value());
        st.trusted_hash = Some(h.hash().to_string());
        st.trusted_age_s = Some(now_tm().unix_timestamp() - h.time.unix_timestamp());
    }
    Ok(st)
}

/// One fact to prove.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Fact {
    pub store: Store,
    pub attribute: &'static str,
    pub object: String,
}

/// Facts proven at one height against one verified header.
#[derive(Clone, Debug, Serialize)]
pub struct Batch {
    pub height: u64,
    pub header_height: u64,
    pub anchor: Anchor,
    pub values: Vec<Proven>,
    /// Facts whose read or proof failed, with why.
    pub failed: Vec<(String, String)>,
}

impl Batch {
    pub fn get(&self, store: Store, attribute: &str, object: &str) -> Option<u64> {
        self.values.iter().find(|p| p.store == store && p.attribute == attribute && p.object == object).map(|p| p.value)
    }
}

/// Prove `facts` at the newest verifiable height: ONE header verification,
/// then one proven query per fact (bounded concurrency). A fact that fails
/// is reported in `failed`, never returned as a value.
pub async fn prove_many(facts: &[Fact]) -> Result<Batch, String> {
    use futures_util::stream::{self, StreamExt};
    let mut slot = CLIENT.lock().await;
    ensure_client(&mut slot).await?;
    let lc = slot.as_mut().expect("ensured");
    let tip = lc.rpc.latest_height().await?;
    let at = tip.saturating_sub(PROOF_LAG).max(lc.trusted.height());
    let header = if lc.trusted.height() == at + 1 {
        lc.trusted.clone()
    } else {
        match lc.verify_to(at + 1).await {
            Ok(h) => h,
            Err(e) => {
                // A broken chain of trust is not patched over: drop the client
                // so the next call re-anchors, visibly.
                *slot = None;
                return Err(e);
            }
        }
    };
    save_trust(lc);
    let app_hash = header.app_hash();
    let rpc = lc.rpc.clone();
    let anchor = lc.trusted.anchor;
    drop(slot);
    let results: Vec<(Fact, Result<Proven, String>)> = stream::iter(facts.iter().cloned())
        .map(|f| {
            let rpc = rpc.clone();
            let app_hash = app_hash.clone();
            async move {
                let r = async {
                    let key = attribute_key(f.store, f.attribute, &f.object).ok_or("unknown attribute")?;
                    let read = rpc.query(&key, Some(at)).await?;
                    if read.height != at {
                        return Err(format!("read served at {} not {at}", read.height));
                    }
                    verify_read(&read, &app_hash)?;
                    Ok(Proven {
                        store: f.store,
                        attribute: f.attribute.to_string(),
                        object: f.object.clone(),
                        value: read_u64(&read)?,
                        height: at,
                        header_height: at + 1,
                        anchor,
                    })
                }
                .await;
                (f, r)
            }
        })
        .buffer_unordered(8)
        .collect()
        .await;
    let mut batch = Batch { height: at, header_height: at + 1, anchor, values: Vec::new(), failed: Vec::new() };
    for (f, r) in results {
        match r {
            Ok(p) => batch.values.push(p),
            Err(e) => batch.failed.push((format!("{:?} {} {}", f.store, f.attribute, f.object), e)),
        }
    }
    Ok(batch)
}

// ── Relay: proofs a teammate can check for themselves ────────────────────────

/// A proven read packaged for another machine. It carries everything the
/// receiver needs EXCEPT trust: the receiver checks it against a header its
/// own light client verified, so a relayer cannot make it believe anything.
#[derive(Clone, Debug, Serialize, serde::Deserialize, PartialEq)]
pub struct Bundle {
    pub chain_id: String,
    pub height: u64,
    pub key_b64: String,
    /// `None` = proven absent.
    pub value_b64: Option<String>,
    /// (type, key_b64, data_b64) for each proof op.
    pub ops: Vec<(String, String, String)>,
}

fn b64e(b: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn b64d(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(s).map_err(|e| format!("base64: {e}"))
}

/// Package one attribute, proven, for a teammate.
pub async fn relay_bundle(store: Store, attribute: &str, object: &str) -> Result<Bundle, String> {
    let key = attribute_key(store, attribute, object).ok_or_else(|| format!("{attribute} is not a {store:?} attribute"))?;
    let mut slot = CLIENT.lock().await;
    ensure_client(&mut slot).await?;
    let lc = slot.as_mut().expect("ensured");
    let tip = lc.rpc.latest_height().await?;
    let at = tip.saturating_sub(PROOF_LAG);
    let read = lc.rpc.query(&key, Some(at)).await?;
    // Relay only what this machine itself verified.
    let header = if lc.trusted.height() == read.height + 1 { lc.trusted.clone() } else { lc.verify_to(read.height + 1).await? };
    verify_read(&read, &header.app_hash())?;
    Ok(Bundle {
        chain_id: header.signed_header.header.chain_id.to_string(),
        height: read.height,
        key_b64: b64e(&read.key),
        value_b64: read.value.as_deref().map(b64e),
        ops: read.ops.iter().map(|o| (o.kind.clone(), b64e(&o.key), b64e(&o.data))).collect(),
    })
}

/// Check a bundle against `app_hash` — the app hash of header
/// `bundle.height + 1` as the RECEIVER's light client verified it. Pure.
pub fn check_bundle(b: &Bundle, app_hash: &[u8]) -> Result<Option<u64>, String> {
    let read = ProvenRead {
        key: b64d(&b.key_b64)?,
        value: b.value_b64.as_deref().map(b64d).transpose()?,
        height: b.height,
        ops: b
            .ops
            .iter()
            .map(|(k, key, data)| Ok(ProofOp { kind: k.clone(), key: b64d(key)?, data: b64d(data)? }))
            .collect::<Result<Vec<_>, String>>()?,
    };
    verify_read(&read, app_hash)?;
    read_u64(&read).map(|v| read.value.as_ref().map(|_| v))
}

/// Verify a bundle someone sent, with THIS machine's light client.
pub async fn verify_bundle(b: &Bundle) -> Result<(Option<u64>, Anchor), String> {
    let mut slot = CLIENT.lock().await;
    ensure_client(&mut slot).await?;
    let lc = slot.as_mut().expect("ensured");
    let chain = lc.trusted.signed_header.header.chain_id.to_string();
    if b.chain_id != chain {
        return Err(format!("the bundle is for {}, this client follows {chain}", b.chain_id));
    }
    let header = if lc.trusted.height() == b.height + 1 { lc.trusted.clone() } else { lc.verify_to(b.height + 1).await? };
    Ok((check_bundle(b, &header.app_hash())?, header.anchor))
}

/// [`prove_many`] for a loop: `None` (logged) when the light client cannot
/// verify right now, so the caller falls back to its ordinary read.
pub async fn prove_for(component: &'static str, facts: &[Fact]) -> Option<Batch> {
    if facts.is_empty() {
        return None;
    }
    match prove_many(facts).await {
        Ok(b) => {
            crate::mcp::telemetry::tlog(
                component,
                crate::mcp::telemetry::Sev::Debug,
                format!("proved {} of {} facts at {} (header {} verified, anchor {:?})", b.values.len(), facts.len(), b.height, b.header_height, b.anchor),
            );
            Some(b)
        }
        Err(e) => {
            crate::mcp::telemetry::tlog(component, crate::mcp::telemetry::Sev::Notice, format!("light client could not prove this scan's facts ({e}); using ordinary reads"));
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_the_keepers() {
        assert_eq!(attribute_key(Store::Grid, "lastAction", "1-194").unwrap(), b"Grid/attribute/11-1-194".to_vec());
        assert_eq!(attribute_key(Store::Grid, "ore", "2-223").unwrap(), b"Grid/attribute/0-2-223".to_vec());
        assert_eq!(attribute_key(Store::Planet, "blockStartOreMine", "2-223").unwrap(), b"Planet/attribute/12-2-223".to_vec());
        assert_eq!(attribute_key(Store::Struct, "status", "5-1").unwrap(), b"Struct/attribute/1-5-1".to_vec());
        assert!(attribute_key(Store::Grid, "nope", "1-1").is_none());
    }

    #[test]
    fn values_are_eight_byte_big_endian_and_absence_is_zero() {
        let r = |v: Option<Vec<u8>>| ProvenRead { key: vec![], value: v, height: 1, ops: vec![] };
        assert_eq!(read_u64(&r(Some(2_449_239u64.to_be_bytes().to_vec()))), Ok(2_449_239));
        assert_eq!(read_u64(&r(None)), Ok(0));
        assert!(read_u64(&r(Some(vec![1, 2]))).is_err());
    }

    /// End to end against the live testnet RPC: anchor on first use, read
    /// lastAction of 1-194 with a proof, verify the committing header by
    /// skipping, check the proof against its app hash — then tamper with the
    /// value and see it refused. Read-only.
    /// `cargo test mirror::verify::tests::live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let rpc = Rpc { base: std::env::var("MIRROR_RPC").unwrap_or_else(|_| "https://public.testnet.structs.network:26657".into()) };
            let tip = rpc.latest_height().await.unwrap();
            let mut lc = LightClient::anchor(rpc.clone(), tip - 2_000, None).await.unwrap();
            println!("anchored on first use at {}", lc.trusted.height());
            let p = prove_attribute(&mut lc, Store::Grid, "lastAction", "1-194").await.unwrap();
            println!("proven: {p:?}");
            let key = attribute_key(Store::Grid, "lastAction", "1-194").unwrap();
            let mut read = rpc.query(&key, Some(p.height)).await.unwrap();
            assert_eq!(verify_read(&read, &lc.trusted.app_hash()), Ok(()));
            read.value = Some(999u64.to_be_bytes().to_vec());
            assert!(verify_read(&read, &lc.trusted.app_hash()).is_err(), "a tampered value must fail");
            let absent = rpc.query(&attribute_key(Store::Grid, "lastAction", "1-999999999").unwrap(), Some(p.height)).await.unwrap();
            assert_eq!(absent.value, None);
            assert_eq!(verify_read(&absent, &lc.trusted.app_hash()), Ok(()), "absence is proven too");
            println!("tampered value refused; absent key proven absent");
        });
    }

    #[test]
    fn trust_expires_with_the_trusting_period() {
        let now = now_tm().unix_timestamp();
        assert!(within_trust(now - 3600));
        assert!(!within_trust(now - TRUSTING_PERIOD_SECS as i64 - 1));
    }

    /// Relay end to end: one machine packages a proven read; the bundle is
    /// checked against an independently verified header; a tampered value
    /// in transit is refused. Read-only.
    /// `cargo test mirror::verify::tests::live_relay -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_relay() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let b = relay_bundle(Store::Grid, "lastAction", "1-194").await.unwrap();
            println!("bundle at {} for {}: {} ops", b.height, b.chain_id, b.ops.len());
            let (v, anchor) = verify_bundle(&b).await.unwrap();
            println!("verified by this machine's light client ({anchor:?}): {v:?}");
            assert_eq!(v, Some(2_449_239));
            let mut bad = b.clone();
            bad.value_b64 = Some(b64e(&7u64.to_be_bytes()));
            assert!(verify_bundle(&bad).await.is_err(), "a value changed in transit is refused");
            println!("tampered bundle refused");
            remove_cache(SAVED);
        });
    }

    /// Pin against the live testnet: a wrong hash is refused, the real hash
    /// is accepted only after the chain from it to the tip verifies, proofs
    /// then carry the `pinned` label, and clearing drops it. Uses test-only
    /// cache files. Read-only on the chain.
    /// `cargo test mirror::verify::tests::live_pin -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_pin() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let rpc = rpc_from_config().expect("guild config has an RPC");
            let tip = rpc.latest_height().await.unwrap();
            let h = tip - 5_000;
            let real = rpc.commit(h).await.unwrap().header.hash().to_string();
            let wrong = format!("{}{}", if real.starts_with('0') { "1" } else { "0" }, &real[1..]);
            let e = pin(h, &wrong).await.unwrap_err();
            println!("wrong hash refused: {e}");
            assert!(e.contains("not the pinned"));
            assert!(pin(h, "abc").await.is_err(), "malformed hash");
            let st = pin(h, &real).await.unwrap();
            println!("pinned at {h}: anchor {:?}, trusted {:?}", st.anchor, st.trusted_height);
            assert_eq!(st.anchor, Some(Anchor::Pinned));
            assert!(st.trusted_height.unwrap() > h, "trust advanced from the pin to the tip");
            let b = prove_many(&[Fact { store: Store::Grid, attribute: "lastAction", object: "1-194".into() }]).await.unwrap();
            assert_eq!(b.anchor, Anchor::Pinned);
            println!("proof under the pin: {:?}", b.values);
            let cleared = clear_pin().await;
            assert_eq!(cleared.anchor, Some(Anchor::FirstUse));
            assert!(cleared.pin.is_none());
            println!("cleared: re-anchored on first use at {:?}", cleared.trusted_height);
            clear_pin().await;
            remove_cache(SAVED);
        });
    }

    /// The store keys are numbered by the chain's attribute enums; the
    /// mirror's attribute lists must be in exactly that order, or every
    /// proven read would prove the wrong attribute.
    #[test]
    fn attribute_order_is_the_chains_enum_order() {
        #[derive(serde::Deserialize)]
        struct G {
            enums: std::collections::BTreeMap<String, Vec<String>>,
        }
        let g: G = serde_json::from_str(include_str!("golden/difficulty.json")).unwrap();
        // The chain prefixes two planet clocks with "planet"; the feeds do not.
        let norm = |n: &str| n.strip_prefix("planet").filter(|r| r.starts_with(|c: char| c.is_ascii_uppercase())).map(|r| {
            let mut c = r.chars();
            c.next().map(|f| f.to_ascii_lowercase().to_string() + c.as_str()).unwrap_or_default()
        }).unwrap_or_else(|| n.to_string());
        for (enum_name, ours) in [
            ("GridAttributeType", &crate::mcp::perception::GRID_ATTRS[..]),
            ("PlanetAttributeType", &crate::mcp::perception::PLANET_ATTRS[..]),
            ("StructAttributeType", &crate::mcp::perception::STRUCT_ATTRS[..]),
        ] {
            let chain: Vec<String> = g.enums[enum_name].iter().map(|n| norm(n)).collect();
            assert_eq!(chain, ours.iter().map(|s| s.to_string()).collect::<Vec<_>>(), "{enum_name}");
        }
    }
}
