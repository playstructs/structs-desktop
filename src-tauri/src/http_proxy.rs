use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;

static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

/// Shared reqwest client used by both the JS `fetch` proxy and the MCP Guild
/// API client. `cookie_store(true)` means any session cookie set by a webapp
/// login (`/api/auth/login`) is reused by subsequent MCP-side calls — so the
/// MCP inherits the user's auth automatically once they're signed in.
pub fn shared_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        // 20 s: the v0.22 guild server gives player fund reads a 15 s native
        // deadline (VaultFundsManager) and its own webapp waits 15 s; a 10 s
        // client cut those off before the server could answer.
        Client::builder()
            .cookie_store(true)
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .expect("failed to build HTTP client")
    })
}

#[inline]
fn client() -> &'static Client {
    shared_client()
}

#[derive(Debug, Deserialize)]
pub struct ProxyRequest {
    pub url: String,
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<String>,
    /// A body that is not text (FormData, Blob, ArrayBuffer), as base64. Wins
    /// over `body` when both are present.
    pub body_b64: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ProxyResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
    /// `"base64"` when `body` carries bytes that are not UTF-8; absent when
    /// it is the text itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<&'static str>,
}

/// A response body as it crosses IPC, without losing a byte.
///
/// `resp.text()` decoded lossily (and by the declared charset), so a gif
/// fetched for its bytes came back 2,308 → 4,357 bytes and a latin-1 page was
/// re-encoded under a header that still said latin-1. Bytes that ARE valid
/// UTF-8 go across as that text — re-encoding it on the JS side yields the
/// same bytes, so JSON costs nothing extra — and anything else goes as base64.
/// No content-type guessing: the bytes decide.
pub fn encode_body(bytes: Vec<u8>) -> (String, Option<&'static str>) {
    use base64::Engine;
    match String::from_utf8(bytes) {
        Ok(text) => (text, None),
        Err(e) => (base64::engine::general_purpose::STANDARD.encode(e.into_bytes()), Some("base64")),
    }
}

#[tauri::command]
pub async fn proxy_fetch(req: ProxyRequest) -> Result<ProxyResponse, String> {
    let method = req
        .method
        .as_deref()
        .unwrap_or("GET")
        .parse::<reqwest::Method>()
        .map_err(|e| e.to_string())?;

    let mut builder = client().request(method, &req.url);

    if let Some(headers) = req.headers {
        for (k, v) in headers {
            builder = builder.header(&k, &v);
        }
    }

    if let Some(b64) = req.body_b64 {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.as_bytes())
            .map_err(|e| format!("body_b64: {e}"))?;
        builder = builder.body(bytes);
    } else if let Some(body) = req.body {
        builder = builder.body(body);
    }

    let resp = builder.send().await.map_err(|e| e.to_string())?;

    let status = resp.status().as_u16();
    let headers: HashMap<String, String> = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let (body, encoding) = encode_body(bytes.to_vec());

    Ok(ProxyResponse {
        status,
        headers,
        body,
        encoding,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    #[test]
    fn text_crosses_as_itself() {
        let (body, enc) = encode_body(r#"{"name":"Pétra ✦"}"#.as_bytes().to_vec());
        assert_eq!(body, r#"{"name":"Pétra ✦"}"#);
        assert_eq!(enc, None);
    }

    /// The bug this pins: a gif's header is ASCII but its pixel data is not
    /// UTF-8, and a lossy decode replaced every bad byte with U+FFFD.
    #[test]
    fn a_gif_survives_byte_for_byte() {
        let gif: Vec<u8> = b"GIF89a\x80\x00\x80\x00\xf7\x00\x00\xff\xfe\x00;".to_vec();
        let (body, enc) = encode_body(gif.clone());
        assert_eq!(enc, Some("base64"));
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(body).unwrap(), gif);
    }

    #[test]
    fn latin1_is_not_reencoded() {
        let latin1 = vec![b'c', b'a', b'f', 0xe9];
        let (body, enc) = encode_body(latin1.clone());
        assert_eq!(enc, Some("base64"));
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(body).unwrap(), latin1);
    }

    #[test]
    fn an_empty_body_is_empty_text() {
        assert_eq!(encode_body(Vec::new()), (String::new(), None));
    }
}
