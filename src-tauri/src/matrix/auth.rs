//! Matrix sign-in, headless.
//!
//! The player already has a Cosmos key and already proves it to the guild
//! webapp every time they log in to play. structs-tel reuses exactly that: the
//! guild webapp is an OIDC provider, MAS is the Matrix auth service that
//! trusts it, and Synapse trusts MAS. So the chat credential is derived from
//! the SAME signature that authorises play — there is no chat password, and
//! no second identity.
//!
//! The chain, end to end:
//!
//! ```text
//!   guild.json services.matrix     → homeserver
//!   GET  {hs}/_matrix/client/v1/auth_metadata     → MAS (issuer, endpoints)
//!   POST {mas}/oauth2/registration                → our client_id (PKCE, public)
//!   GET  {mas}/authorize?…                        → 303s to the webapp, which
//!                                                    has no session yet and
//!                                                    parks us at /?oidc=<id>
//!   POST {guild_api}/auth/login  (wallet sig)     → webapp session cookie
//!   GET  {webapp}/oauth/resume?request_id=<id>    → 302s back through MAS to
//!                                                    our loopback with ?code=
//!   POST {mas}/oauth2/token      (code+verifier)  → Matrix access token
//!   GET  {hs}/_matrix/client/v3/account/whoami    → @1-42:matrix.example
//! ```
//!
//! Every hop runs in one cookie jar (MAS session + webapp PHP session both
//! live in it) and redirects are followed BY HAND, so the loopback hop can be
//! intercepted instead of connected to — nothing ever listens on that port.
//!
//! The only thing Rust cannot do here is sign: the mnemonic lives in the
//! webapp's JS and never leaves it. Step 5 therefore round-trips through
//! `vplayer_bridge` to a façade that signs the login message and hands back
//! only address / pubkey / signature.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;

use super::store::{self, Session};

/// Registered with MAS as a native client's loopback redirect. NOTHING binds
/// this port: the redirect is intercepted while following the chain by hand,
/// so the value only has to be stable, registered, and obviously ours.
const REDIRECT_URI: &str = "http://127.0.0.1:47411/structs/comms/callback";
const CLIENT_NAME: &str = "Structs Desktop — Comms";
const CLIENT_URI: &str = "https://github.com/playstructs/structs-universe";

/// Redirect chains here are 4-6 hops. 12 leaves room for a consent detour
/// without letting a misconfigured server spin us forever.
const MAX_HOPS: usize = 12;
const HTTP_TIMEOUT_SECS: u64 = 25;
/// The signing round-trip goes to the game webview; it is a single sha256 +
/// secp256k1 sign, so it is fast unless the bridge is wedged.
const SIGN_TIMEOUT_SECS: u64 = 30;

// ── The ladder ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct Step {
    pub key: &'static str,
    pub label: &'static str,
    pub state: &'static str, // "todo" | "active" | "done" | "failed"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// The chain's shape is fixed, so the UI can draw the whole ladder before any
/// of it has run — a failure then reads as "this hop broke", with the hops
/// after it visibly untried, instead of as a bare error string.
pub const STEP_DEFS: &[(&str, &str)] = &[
    ("service", "Guild comms service"),
    ("metadata", "Homeserver auth metadata"),
    ("client", "Client registration"),
    ("authorize", "Authorization request"),
    ("login", "Guild login (wallet signature)"),
    ("resume", "Authorization code"),
    ("token", "Access token"),
    ("whoami", "Matrix identity"),
];

pub struct Ladder {
    steps: Vec<Step>,
}

impl Ladder {
    pub fn new() -> Self {
        Ladder {
            steps: STEP_DEFS
                .iter()
                .map(|(key, label)| Step {
                    key,
                    label,
                    state: "todo",
                    detail: None,
                })
                .collect(),
        }
    }
    fn set(&mut self, key: &str, state: &'static str, detail: Option<String>) {
        if let Some(s) = self.steps.iter_mut().find(|s| s.key == key) {
            s.state = state;
            if detail.is_some() {
                s.detail = detail;
            }
        }
    }
    pub fn steps(&self) -> Vec<Step> {
        self.steps.clone()
    }
}

/// Marks `key` active, runs `f`, then marks it done (with `detail` from the
/// result) or failed (with the error). The error is returned unchanged so the
/// caller still gets it; the ladder just also remembers where it happened.
macro_rules! step {
    ($ladder:expr, $emit:expr, $key:expr, $detail:expr, $body:expr) => {{
        $ladder.set($key, "active", None);
        $emit($ladder);
        match $body {
            Ok(v) => {
                let d: Option<String> = $detail(&v);
                $ladder.set($key, "done", d);
                $emit($ladder);
                v
            }
            Err(e) => {
                let e: String = e;
                $ladder.set($key, "failed", Some(e.clone()));
                $emit($ladder);
                return Err(e);
            }
        }
    }};
}

// ── Discovery shapes ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct AuthMetadata {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(default)]
    pub registration_endpoint: Option<String>,
}

// ── PKCE ────────────────────────────────────────────────────────────────────

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_bytes(n: usize) -> Vec<u8> {
    use rand::RngCore;
    let mut buf = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut buf);
    buf
}

/// Matrix device ids are opaque; MAS carries ours inside the requested scope,
/// so it must survive as a single scope token — letters only, no padding.
fn new_device_id() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    random_bytes(10)
        .into_iter()
        .map(|b| ALPHABET[(b as usize) % ALPHABET.len()] as char)
        .collect()
}

// ── HTTP ────────────────────────────────────────────────────────────────────

/// One jar for the whole chain. MAS's session cookie and the webapp's PHP
/// session cookie are both required, on two different hosts, and the sign-in
/// only works because a single client carries both.
///
/// Redirects are NOT followed automatically: the chain ends at a loopback URL
/// that nothing serves, and reqwest would turn that into a connection error
/// instead of a result.
fn chain_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .cookie_store(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .user_agent("StructsDesktop/comms")
        .build()
        .map_err(|e| format!("http client: {}", e))
}

/// Where a hand-followed chain stopped.
enum Landing {
    /// The loopback redirect: `?code=…&state=…` (or `?error=…`).
    Callback(reqwest::Url),
    /// A normal page — the webapp SPA, a MAS consent form, anything.
    Page { url: reqwest::Url, body: String },
}

/// Follow `Location` headers by hand, stopping at the registered redirect URI
/// rather than trying to connect to it.
async fn follow(client: &reqwest::Client, start: reqwest::Url) -> Result<Landing, String> {
    let mut url = start;
    for _ in 0..MAX_HOPS {
        if url.as_str().starts_with(REDIRECT_URI) {
            return Ok(Landing::Callback(url));
        }
        let resp = client
            .get(url.clone())
            .send()
            .await
            .map_err(|e| format!("{}: {}", redact(&url), e))?;
        let status = resp.status();
        if status.is_redirection() {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| format!("{} redirected without a Location", status.as_u16()))?;
            // Relative Locations are normal here (MAS uses `/login?…`).
            url = url
                .join(loc)
                .map_err(|e| format!("bad redirect target '{}': {}", loc, e))?;
            continue;
        }
        if !status.is_success() {
            return Err(format!("{} at {}", status.as_u16(), redact(&url)));
        }
        let body = resp.text().await.unwrap_or_default();
        return Ok(Landing::Page { url, body });
    }
    Err(format!("redirect chain exceeded {} hops", MAX_HOPS))
}

/// URLs on this path carry auth codes and request ids. Anything logged or put
/// in an error message loses its query first.
fn redact(url: &reqwest::Url) -> String {
    let mut u = url.clone();
    u.set_query(None);
    u.to_string()
}

// ── Steps ───────────────────────────────────────────────────────────────────

/// `GET {hs}/_matrix/client/v1/auth_metadata`, falling back to the MSC2965
/// unstable path for a homeserver that predates the stable endpoint.
pub async fn fetch_auth_metadata(homeserver: &str) -> Result<AuthMetadata, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;
    let paths = [
        "/_matrix/client/v1/auth_metadata",
        "/_matrix/client/unstable/org.matrix.msc2965/auth_metadata",
    ];
    let mut last = String::from("no endpoint tried");
    for p in paths {
        let url = format!("{}{}", homeserver.trim_end_matches('/'), p);
        match client.get(&url).send().await {
            Ok(r) if r.status().is_success() => {
                return r
                    .json::<AuthMetadata>()
                    .await
                    .map_err(|e| format!("auth_metadata is not the documented shape: {}", e));
            }
            Ok(r) => last = format!("HTTP {} from {}", r.status().as_u16(), p),
            Err(e) => last = format!("{}: {}", p, e),
        }
    }
    // A homeserver without delegated auth is a homeserver this client cannot
    // sign in to — say that, rather than "login failed".
    Err(format!(
        "{} does not advertise delegated (MAS) authentication — {}",
        homeserver, last
    ))
}

/// Register once per homeserver and remember the id. MAS allows anonymous
/// dynamic registration for native clients; the client is public (no secret)
/// and relies on PKCE, which is the correct shape for a desktop app.
async fn register_client(meta: &AuthMetadata, homeserver: &str) -> Result<String, String> {
    if let Some(existing) = store::client_for(homeserver) {
        return Ok(existing);
    }
    let endpoint = meta
        .registration_endpoint
        .as_deref()
        .ok_or("this homeserver's auth service does not allow client registration")?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;
    let body = json!({
        "client_name": CLIENT_NAME,
        "client_uri": CLIENT_URI,
        "application_type": "native",
        "redirect_uris": [REDIRECT_URI],
        "response_types": ["code"],
        "grant_types": ["authorization_code", "refresh_token"],
        "token_endpoint_auth_method": "none",
    });
    let resp = client
        .post(endpoint)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("client registration: {}", e))?;
    let status = resp.status();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let msg = v
            .get("error_description")
            .and_then(|x| x.as_str())
            .or_else(|| v.get("error").and_then(|x| x.as_str()))
            .unwrap_or("no reason given");
        return Err(format!("client registration refused ({}): {}", status.as_u16(), msg));
    }
    let id = v
        .get("client_id")
        .and_then(|x| x.as_str())
        .ok_or("client registration returned no client_id")?
        .to_string();
    store::put_client(homeserver, &id);
    Ok(id)
}

/// The scope MSC2967 defines for a Matrix client: full CS API, plus the one
/// device this session will use.
fn matrix_scope(device_id: &str) -> String {
    format!(
        "urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:{}",
        device_id
    )
}

/// Extract `<input name value>` pairs and the action from the first form in a
/// document. MAS interposes a consent page the first time a client asks for
/// scope; it is an ordinary POST form with a CSRF field, and re-posting it is
/// the same "yes" a human would click. Only ever applied to a page served by
/// the MAS issuer we discovered from the homeserver.
fn parse_form(body: &str, base: &reqwest::Url) -> Option<(reqwest::Url, Vec<(String, String)>)> {
    let lower = body.to_lowercase();
    let form_at = lower.find("<form")?;
    let form_end = lower[form_at..].find("</form>").map(|e| form_at + e)?;
    let form = &body[form_at..form_end];

    let action = attr(&form[..form.find('>').unwrap_or(form.len())], "action")
        .unwrap_or_default();
    let url = if action.trim().is_empty() {
        base.clone()
    } else {
        base.join(action.trim()).ok()?
    };

    let mut fields = Vec::new();
    let flower = form.to_lowercase();
    let mut i = 0;
    while let Some(rel) = flower[i..].find("<input") {
        let start = i + rel;
        let end = form[start..].find('>').map(|e| start + e).unwrap_or(form.len());
        let tag = &form[start..end];
        if let Some(name) = attr(tag, "name") {
            fields.push((name, attr(tag, "value").unwrap_or_default()));
        }
        i = end.max(start + 6);
    }
    Some((url, fields))
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let key = format!("{}=\"", name);
    let at = lower.find(&key)? + key.len();
    let rest = &tag[at..];
    let end = rest.find('"')?;
    Some(decode_entities(&rest[..end]))
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

// ── The guild login hop ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct SignedLogin {
    address: String,
    pubkey: String,
    signature: String,
}

/// Ask the game webview to sign the guild's login message. The façade builds
/// the message itself from (guild_id, timestamp) — it deliberately does NOT
/// take an arbitrary string to sign, so this bridge can never be turned into a
/// generic signing oracle for chain payloads.
async fn sign_login(
    app: &tauri::AppHandle,
    guild_id: &str,
    timestamp: &str,
) -> Result<SignedLogin, String> {
    let v = crate::mcp::vplayer_bridge::call(
        app,
        "login_signature",
        json!({ "guild_id": guild_id, "timestamp": timestamp }),
        SIGN_TIMEOUT_SECS,
    )
    .await?;
    serde_json::from_value(v)
        .map_err(|e| format!("the signing bridge returned an unexpected shape: {}", e))
}

/// The webapp's timestamp, not ours: the login message expires 600s after the
/// value the SERVER believes, so a skewed local clock would fail every login
/// with a signature error that looks like a key problem.
async fn guild_timestamp(client: &reqwest::Client, guild_api: &str) -> Result<String, String> {
    let url = format!("{}/timestamp", guild_api.trim_end_matches('/'));
    let v: Value = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("guild timestamp: {}", e))?
        .json()
        .await
        .map_err(|e| format!("guild timestamp: {}", e))?;
    v.get("data")
        .and_then(|d| d.get("unix_timestamp"))
        .map(|t| match t {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .ok_or_else(|| "guild timestamp response had no unix_timestamp".to_string())
}

async fn guild_login(
    client: &reqwest::Client,
    guild_api: &str,
    guild_id: &str,
    signed: &SignedLogin,
    timestamp: &str,
) -> Result<(), String> {
    let url = format!("{}/auth/login", guild_api.trim_end_matches('/'));
    let body = json!({
        "address": signed.address,
        "signature": signed.signature,
        "pubkey": signed.pubkey,
        "guild_id": guild_id,
        "unix_timestamp": timestamp,
    });
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("guild login: {}", e))?;
    let status = resp.status();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if status.is_success() && v.get("success").and_then(|s| s.as_bool()) == Some(true) {
        return Ok(());
    }
    // The webapp reports failures as {errors: {key: message}}; surface the
    // key AND the message, because the key is the part that is searchable.
    let detail = v
        .get("errors")
        .and_then(|e| e.as_object())
        .map(|m| {
            m.iter()
                .map(|(k, val)| format!("{}: {}", k, val.as_str().unwrap_or_default()))
                .collect::<Vec<_>>()
                .join("; ")
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
    Err(detail)
}

// ── Full sign-in ────────────────────────────────────────────────────────────

pub struct Connected {
    /// The Matrix id this sign-in produced — `@1-194:matrix.crew.oh.energy`.
    /// Reported so the caller can say who it signed in as without going back
    /// to the store for it.
    pub user_id: String,
}

/// Run the whole chain. `emit` is called after every state change so the
/// window's ladder animates as it goes.
pub async fn connect<F>(
    app: &tauri::AppHandle,
    guild_id: &str,
    ladder: &mut Ladder,
    emit: F,
) -> Result<Connected, String>
where
    F: Fn(&Ladder),
{
    // 1 ── the guild's declared homeserver
    let (homeserver, guild_api) = step!(
        ladder,
        emit,
        "service",
        |v: &(String, String)| Some(v.0.clone()),
        {
            let cfg = crate::guild_config::get_guild_configs()
                .into_iter()
                .find(|c| c.guild_id == guild_id)
                .ok_or_else(|| format!("guild {} is not in the directory", guild_id))?;
            match cfg.matrix_url.clone() {
                Some(m) if !m.is_empty() => Ok((m, cfg.guild_api.clone())),
                _ => Err(format!(
                    "{} publishes no matrix service in its guild.json",
                    if cfg.name.is_empty() { guild_id.to_string() } else { cfg.name }
                )),
            }
        }
    );

    // 2 ── who authenticates for that homeserver
    let meta = step!(
        ladder,
        emit,
        "metadata",
        |m: &AuthMetadata| Some(m.issuer.clone()),
        fetch_auth_metadata(&homeserver).await
    );

    // 3 ── our OAuth client
    let client_id = step!(
        ladder,
        emit,
        "client",
        |id: &String| Some(id.clone()),
        register_client(&meta, &homeserver).await
    );

    let http = chain_client()?;
    let device_id = new_device_id();
    let verifier = b64url(&random_bytes(32));
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let state = b64url(&random_bytes(16));

    // 4 ── start the authorization. With a fresh jar this always parks at the
    //      guild SPA carrying an `oidc` request id — the webapp has no session
    //      for us yet. If a session somehow exists we land on the callback
    //      directly, and steps 5-6 are skipped.
    let landing = step!(ladder, emit, "authorize", |_: &Landing| None, {
        let mut url = reqwest::Url::parse(&meta.authorization_endpoint)
            .map_err(|e| format!("bad authorization endpoint: {}", e))?;
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", &client_id)
            .append_pair("redirect_uri", REDIRECT_URI)
            .append_pair("scope", &matrix_scope(&device_id))
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("response_mode", "query");
        follow(&http, url).await
    });

    // 5 + 6 ── prove who we are to the guild, then resume the parked request
    let callback = match landing {
        Landing::Callback(u) => {
            // Already authorised (a live MAS session). Nothing to sign.
            ladder.set("login", "done", Some("already signed in".into()));
            ladder.set("resume", "done", None);
            emit(ladder);
            u
        }
        Landing::Page { url, body } => {
            let request_id = oidc_request_id(&url, &body).ok_or_else(|| {
                let msg = format!(
                    "the guild's OIDC provider did not park an authorization request at {}",
                    redact(&url)
                );
                ladder.set("authorize", "failed", Some(msg.clone()));
                emit(ladder);
                msg
            })?;
            let webapp_origin = origin_of(&url);

            step!(
                ladder,
                emit,
                "login",
                |a: &String| Some(a.clone()),
                {
                    let ts = guild_timestamp(&http, &guild_api).await?;
                    let signed = sign_login(app, guild_id, &ts).await?;
                    guild_login(&http, &guild_api, guild_id, &signed, &ts).await?;
                    Ok::<String, String>(signed.address)
                }
            );

            step!(ladder, emit, "resume", |_: &reqwest::Url| None, {
                let resume = format!(
                    "{}/oauth/resume?request_id={}",
                    webapp_origin,
                    urlencode(&request_id)
                );
                let url = reqwest::Url::parse(&resume)
                    .map_err(|e| format!("bad resume URL: {}", e))?;
                match follow(&http, url).await? {
                    Landing::Callback(u) => Ok(u),
                    // MAS asks for consent the first time a client requests
                    // scope. Posting the form back is the same "yes" a human
                    // would click, and it only happens on a page served by the
                    // issuer this homeserver told us to trust.
                    Landing::Page { url, body } => consent(&http, &meta, url, body).await,
                }
            })
        }
    };

    // 7 ── redeem the code
    let (access_token, refresh_token, expires_at) = step!(
        ladder,
        emit,
        "token",
        |_: &(String, Option<String>, Option<u64>)| None,
        {
            let q: std::collections::HashMap<_, _> = callback.query_pairs().into_owned().collect();
            if let Some(err) = q.get("error") {
                return Err(format!(
                    "{}{}",
                    err,
                    q.get("error_description")
                        .map(|d| format!(": {}", d))
                        .unwrap_or_default()
                ));
            }
            // The state check is what stops a redirect we did not start from
            // being redeemed as though we had.
            match q.get("state") {
                Some(s) if *s == state => {}
                _ => return Err("authorization response did not carry our state".into()),
            }
            let code = q
                .get("code")
                .ok_or("authorization response carried no code")?;
            exchange_code(&meta, &client_id, code, &verifier).await
        }
    );

    // 8 ── who the homeserver thinks we are
    let user_id = step!(
        ladder,
        emit,
        "whoami",
        |u: &String| Some(u.clone()),
        whoami(&homeserver, &access_token).await
    );

    let session = Session {
        guild_id: guild_id.to_string(),
        homeserver: homeserver.trim_end_matches('/').to_string(),
        user_id,
        device_id,
        access_token,
        refresh_token,
        expires_at,
        client_id,
        token_endpoint: meta.token_endpoint.clone(),
    };
    let user_id = session.user_id.clone();
    store::put(session);
    Ok(Connected { user_id })
}

/// The SPA's continue hook: `/?oidc=<request_id>` (OidcContinueManager reads
/// exactly this). Also accepted from the body, for a provider that renders the
/// id rather than putting it in the query.
fn oidc_request_id(url: &reqwest::Url, body: &str) -> Option<String> {
    if let Some((_, v)) = url.query_pairs().find(|(k, _)| k == "oidc") {
        if !v.is_empty() {
            return Some(v.to_string());
        }
    }
    let needle = "oidcContinueRequestId";
    let at = body.find(needle)?;
    let rest = &body[at + needle.len()..];
    let start = rest.find(|c: char| c.is_ascii_alphanumeric())?;
    let end = rest[start..]
        .find(|c: char| !c.is_ascii_alphanumeric())
        .unwrap_or(rest.len() - start);
    let id = &rest[start..start + end];
    if id.len() >= 16 {
        Some(id.to_string())
    } else {
        None
    }
}

fn origin_of(url: &reqwest::Url) -> String {
    let mut u = url.clone();
    u.set_path("");
    u.set_query(None);
    u.set_fragment(None);
    u.to_string().trim_end_matches('/').to_string()
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{:02X}", b),
        })
        .collect()
}

/// Post a MAS consent form back and keep following. Refuses to post to
/// anywhere but the issuer the homeserver named, so a hijacked page cannot
/// turn this into a blind form submitter.
async fn consent(
    http: &reqwest::Client,
    meta: &AuthMetadata,
    url: reqwest::Url,
    body: String,
) -> Result<reqwest::Url, String> {
    let issuer = reqwest::Url::parse(&meta.issuer).map_err(|e| e.to_string())?;
    if url.host_str() != issuer.host_str() {
        return Err(format!(
            "the authorization chain stopped at {}, which is neither the callback nor the auth service",
            redact(&url)
        ));
    }
    let (action, fields) = parse_form(&body, &url)
        .ok_or_else(|| format!("{} needs a browser to continue", redact(&url)))?;
    if action.host_str() != issuer.host_str() {
        return Err(format!("consent form targets {}, not the auth service", redact(&action)));
    }
    let resp = http
        .post(action.clone())
        .form(&fields)
        .send()
        .await
        .map_err(|e| format!("consent: {}", e))?;
    let next = if resp.status().is_redirection() {
        let loc = resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or("consent redirected without a Location")?;
        action.join(loc).map_err(|e| e.to_string())?
    } else {
        return Err(format!(
            "consent returned {} instead of continuing",
            resp.status().as_u16()
        ));
    };
    match follow(http, next).await? {
        Landing::Callback(u) => Ok(u),
        Landing::Page { url, .. } => Err(format!(
            "the authorization chain stopped at {} instead of returning a code",
            redact(&url)
        )),
    }
}

async fn exchange_code(
    meta: &AuthMetadata,
    client_id: &str,
    code: &str,
    verifier: &str,
) -> Result<(String, Option<String>, Option<u64>), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", REDIRECT_URI),
        ("client_id", client_id),
        ("code_verifier", verifier),
    ];
    let resp = client
        .post(&meta.token_endpoint)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("token exchange: {}", e))?;
    let status = resp.status();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let msg = v
            .get("error_description")
            .and_then(|x| x.as_str())
            .or_else(|| v.get("error").and_then(|x| x.as_str()))
            .unwrap_or("no reason given");
        return Err(format!("token refused ({}): {}", status.as_u16(), msg));
    }
    let access = v
        .get("access_token")
        .and_then(|x| x.as_str())
        .ok_or("token response carried no access_token")?
        .to_string();
    let refresh = v
        .get("refresh_token")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    let expires_at = v
        .get("expires_in")
        .and_then(|x| x.as_u64())
        .map(|secs| now_secs() + secs);
    Ok((access, refresh, expires_at))
}

/// Trade a refresh token for a new access token. Called by the client layer
/// when the homeserver answers M_UNKNOWN_TOKEN, so an expiring session heals
/// itself instead of dropping the player back to the Connect button.
pub async fn refresh(session: &Session) -> Result<Session, String> {
    let refresh_token = session
        .refresh_token
        .as_deref()
        .ok_or("this session has no refresh token")?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;
    let form = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", session.client_id.as_str()),
    ];
    let resp = client
        .post(&session.token_endpoint)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("token refresh: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("token refresh refused ({})", resp.status().as_u16()));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut next = session.clone();
    next.access_token = v
        .get("access_token")
        .and_then(|x| x.as_str())
        .ok_or("refresh response carried no access_token")?
        .to_string();
    if let Some(rt) = v.get("refresh_token").and_then(|x| x.as_str()) {
        next.refresh_token = Some(rt.to_string());
    }
    next.expires_at = v
        .get("expires_in")
        .and_then(|x| x.as_u64())
        .map(|secs| now_secs() + secs);
    store::put(next.clone());
    Ok(next)
}

async fn whoami(homeserver: &str, token: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!(
        "{}/_matrix/client/v3/account/whoami",
        homeserver.trim_end_matches('/')
    );
    let resp = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("whoami: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("whoami: HTTP {}", resp.status().as_u16()));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    v.get("user_id")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "whoami returned no user_id".to_string())
}

/// Best-effort revoke on sign-out. A homeserver that refuses is not worth
/// blocking the local sign-out over: the token is dropped either way.
pub async fn logout(session: &Session) {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    else {
        return;
    };
    let url = format!(
        "{}/_matrix/client/v3/logout",
        session.homeserver.trim_end_matches('/')
    );
    let _ = client
        .post(&url)
        .bearer_auth(&session.access_token)
        .json(&json!({}))
        .send()
        .await;
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_the_documented_transform() {
        // RFC 7636 appendix B's worked example: verifier → S256 challenge.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn device_id_survives_as_one_scope_token() {
        let id = new_device_id();
        assert_eq!(id.len(), 10);
        assert!(id.chars().all(|c| c.is_ascii_uppercase()));
        // No spaces, no '=' padding — either would split or corrupt the scope.
        assert!(!matrix_scope(&id).contains('='));
        assert_eq!(matrix_scope(&id).split(' ').count(), 2);
    }

    #[test]
    fn redaction_drops_the_code() {
        let u = reqwest::Url::parse(
            "https://auth.example/callback?code=SECRET&state=xyz",
        )
        .unwrap();
        let s = redact(&u);
        assert!(!s.contains("SECRET"), "{}", s);
        assert!(s.starts_with("https://auth.example/callback"));
    }

    #[test]
    fn spa_continue_hook_is_read_from_the_query() {
        // The exact landing the live chain produces (verified against
        // beta.playstructs.com 2026-08-28).
        let u = reqwest::Url::parse(
            "https://beta.playstructs.com/?oidc=a15a84c9a8655f90e8c260adec555acc",
        )
        .unwrap();
        assert_eq!(
            oidc_request_id(&u, "").as_deref(),
            Some("a15a84c9a8655f90e8c260adec555acc")
        );
        assert_eq!(origin_of(&u), "https://beta.playstructs.com");
    }

    #[test]
    fn no_request_id_is_not_silently_treated_as_success() {
        let u = reqwest::Url::parse("https://beta.playstructs.com/").unwrap();
        assert!(oidc_request_id(&u, "<html>nothing here</html>").is_none());
    }

    #[test]
    fn consent_form_fields_round_trip() {
        let base = reqwest::Url::parse("https://auth.example/consent?id=1").unwrap();
        let body = r#"<html><body>
            <form method="POST" action="/consent/01ABC">
              <input type="hidden" name="csrf" value="tok&amp;en">
              <input type="hidden" name="action" value="consent">
              <button>Continue</button>
            </form></body></html>"#;
        let (url, fields) = parse_form(body, &base).unwrap();
        assert_eq!(url.as_str(), "https://auth.example/consent/01ABC");
        assert_eq!(fields.len(), 2);
        assert_eq!(fields[0], ("csrf".to_string(), "tok&en".to_string()));
    }

    #[test]
    fn a_ladder_records_where_it_broke() {
        let mut l = Ladder::new();
        l.set("service", "done", Some("matrix.example".into()));
        l.set("metadata", "failed", Some("HTTP 404".into()));
        let steps = l.steps();
        assert_eq!(steps.len(), STEP_DEFS.len());
        assert_eq!(steps[0].state, "done");
        assert_eq!(steps[1].state, "failed");
        assert_eq!(steps[1].detail.as_deref(), Some("HTTP 404"));
        // Everything after the failure must still read as untried.
        assert!(steps[2..].iter().all(|s| s.state == "todo"));
    }
}
