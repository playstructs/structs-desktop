//! Making a name hard to WEAR.
//!
//! An on-chain name is nobody else's to take — the chain settles who owns it.
//! A Matrix display name is the opposite: any account may set any string, and
//! federation means the account need not even be on our homeserver. Everything
//! here exists to keep the second kind of name from passing as the first.
//!
//! Two jobs, deliberately separate:
//!
//! * [`sanitize`] decides what is SHOWN. It removes characters that are
//!   invisible or that reorder the text around them, because a name the reader
//!   cannot see in full is a name they cannot check.
//! * [`fold`] decides what COLLIDES. It is aggressive on purpose: a false
//!   collision only adds a disambiguating player id to a display name, which
//!   costs nothing, while a missed collision is an impersonation that renders
//!   clean.

/// Characters that are invisible, or that move other characters around.
///
/// Zero-width joiners defeat an equality check while showing nothing; the bidi
/// overrides re-order a whole run, so `1-61\u{202E}…` can paint a name that is
/// not the string it is stored as. Neither has any business in a display name.
fn is_invisible(c: char) -> bool {
    matches!(c,
        '\u{200B}'..='\u{200F}'   // zero-width space/joiners, LRM/RLM
        | '\u{202A}'..='\u{202E}' // bidi embedding and OVERRIDE
        | '\u{2060}'..='\u{2064}' // word joiner, invisible operators
        | '\u{2066}'..='\u{2069}' // bidi isolates
        | '\u{FEFF}'              // BOM / zero-width no-break
        | '\u{00AD}'              // soft hyphen
        | '\u{180E}'              // Mongolian vowel separator
    ) || c.is_control()
}

/// What a display name is allowed to LOOK like.
///
/// Invisible and reordering characters are dropped, every run of whitespace
/// becomes one space, and the result is trimmed. The name that reaches the
/// screen is then the same name a reader can compare by eye.
pub fn sanitize(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut space = false;
    for c in name.chars().filter(|c| !is_invisible(*c)) {
        if c.is_whitespace() {
            space = !out.is_empty();
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        out.push(c);
    }
    out
}

/// Latin letters that another script — or a digit — can be dressed up as.
///
/// This is a targeted table, not UTS-39: it covers the scripts an attacker
/// actually reaches for (Cyrillic and Greek lookalikes, full-width forms) and
/// the digit-for-letter substitutions that read as the letter at a glance. A
/// complete confusable pass wants a real Unicode crate; see the Comms backlog.
fn defang(c: char) -> char {
    match c {
        // ── Cyrillic ──
        'а' => 'a', 'в' => 'b', 'с' => 'c', 'е' => 'e', 'ѕ' => 's', 'һ' => 'h',
        'і' | 'ї' => 'i', 'ј' => 'j', 'к' => 'k', 'м' => 'm', 'н' => 'h',
        'о' => 'o', 'р' => 'p', 'т' => 't', 'у' => 'y', 'х' => 'x', 'г' => 'r',
        'ё' => 'e', 'ԁ' => 'd', 'ԛ' => 'q', 'ѡ' => 'w', 'ո' => 'n',
        // ── Greek ──
        'α' => 'a', 'β' => 'b', 'ε' => 'e', 'ζ' => 'z', 'η' => 'n', 'ι' => 'i',
        'κ' => 'k', 'μ' => 'm', 'ν' => 'v', 'ο' => 'o', 'ρ' => 'p', 'τ' => 't',
        'υ' => 'u', 'χ' => 'x', 'γ' => 'y', 'σ' => 'o', 'ϲ' => 'c',
        // ── Digits worn as letters ──
        '0' => 'o', '1' => 'l', '3' => 'e', '4' => 'a', '5' => 's', '7' => 't',
        '8' => 'b', '9' => 'g', '6' => 'b', '2' => 'z',
        // ── Full-width Latin ──
        'ａ'..='ｚ' => ((c as u32 - 'ａ' as u32) as u8 + b'a') as char,
        'Ａ'..='Ｚ' => ((c as u32 - 'Ａ' as u32) as u8 + b'a') as char,
        other => other,
    }
}

/// The key two names are compared BY.
///
/// Case is discarded, lookalikes are folded to their Latin letter, and
/// everything that is not a letter or digit is dropped — so `M a r k`,
/// `M-a-r-k` and `Mark` are one name for collision purposes. Aggressive by
/// design: see the module note on which direction is safe to be wrong in.
pub fn fold(name: &str) -> String {
    sanitize(name)
        .to_lowercase()
        .chars()
        .map(defang)
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// Does this name try to wear a guild?
///
/// The window renders a real tag as `[SN.C]` from the CHAIN, beside the name.
/// A self-chosen name containing its own brackets paints the same badge
/// without owning it, so a name that does this is never shown bare.
pub fn claims_a_guild_tag(name: &str) -> bool {
    let n = sanitize(name);
    n.contains('[') || n.contains(']')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invisible_characters_never_reach_the_screen() {
        // A zero-width space splits a name for every equality check while
        // showing nothing at all.
        assert_eq!(sanitize("Mark\u{200B}lifer"), "Marklifer");
        // A right-to-left OVERRIDE repaints everything after it.
        assert_eq!(sanitize("Mark\u{202E}lifer"), "Marklifer");
        assert_eq!(sanitize("\u{FEFF}JPEG\u{00AD}"), "JPEG");
        assert_eq!(sanitize("  spaced   out  "), "spaced out");
    }

    #[test]
    fn a_lookalike_name_folds_onto_the_name_it_imitates() {
        // Cyrillic а and е: a different string, the same picture.
        assert_eq!(fold("M\u{0430}rklif\u{0435}r"), fold("Marklifer"));
        // Greek ο and ρ.
        assert_eq!(fold("P\u{03BF}\u{03C1}py"), fold("Poppy"));
        // Full-width.
        assert_eq!(fold("ＪＰＥＧ"), fold("JPEG"));
        // Digits worn as letters.
        assert_eq!(fold("M4rk1if3r"), fold("Marklifer"));
        // Spacing and punctuation are not a disguise either.
        assert_eq!(fold("M a r k - l i f e r"), fold("Marklifer"));
        // And the invisible-character trick folds away too.
        assert_eq!(fold("Mark\u{200B}lifer"), fold("Marklifer"));
    }

    #[test]
    fn different_names_stay_different() {
        assert_ne!(fold("Marklifer"), fold("Phoniffer"));
        assert_ne!(fold("JPEG"), fold("PNG"));
        // Folding must not collapse everything to nothing.
        assert_eq!(fold("JPEG"), "jpeg");
        assert_eq!(fold("   "), "");
    }

    #[test]
    fn even_an_owned_name_has_to_be_legible() {
        // An on-chain name is the one string this app trusts outright: it
        // renders with no player id beside it, because the chain settles who
        // owns it. The chain does NOT settle whether it can be read — nothing
        // stops registering a name that reorders the text around it.
        assert_eq!(sanitize("Mark\u{202E}lifer"), "Marklifer");
        assert_eq!(sanitize("[SN.C]\u{200B} Corp"), "[SN.C] Corp");
        // Ordinary names pass through untouched — this must not quietly
        // rewrite what people are called.
        for ok in ["Marklifer", "JPEG", "Kilgore Crabla", "T.Xue", "beezhan"] {
            assert_eq!(sanitize(ok), ok);
        }
    }

    #[test]
    fn a_name_that_paints_its_own_guild_badge_is_flagged() {
        assert!(claims_a_guild_tag("[SN.C] Marklifer"));
        assert!(claims_a_guild_tag("Marklifer]"));
        // Even when the brackets are hidden behind an invisible character.
        assert!(claims_a_guild_tag("\u{200B}[SN.C] Marklifer"));
        assert!(!claims_a_guild_tag("Marklifer"));
    }
}
