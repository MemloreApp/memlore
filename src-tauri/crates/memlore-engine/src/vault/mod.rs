//! Vault lifecycle: startup detection, first-time setup and password unlock,
//! moved out of the desktop glue (mobile-app plan, phase 11). The platform
//! side effects of that code (OS keystore, the desktop's post-unlock sweep,
//! the pending cloud session) go through [`VaultPlatformHooks`]; the desktop
//! implements it by calling the functions those call sites used before.

use zeroize::Zeroizing;

use crate::utils::boot_file::UnlockMethod;
use crate::utils::encryption::SALT_SIZE;
use crate::AppState;

pub mod setup;
pub mod startup;
pub mod unlock;

/// Settings key mirroring whether this device can unlock with the OS
/// keystore (`"true"` / `"false"`; absent reads as `false`).
pub const BIOMETRIC_ENABLED_SETTING: &str = "biometric_unlock_enabled";

/// Minimum password length enforced at the command layer, counted in
/// **Unicode scalar values** (what users perceive roughly as "characters"),
/// not UTF-8 bytes. This matches the frontend's expectation of "characters"
/// in the LockScreen copy, and avoids an accidental security surprise where
/// 5 emoji (≈20 bytes) would pass a byte-count check.
///
/// Combined with the Argon2id KDF params (64 MiB, t=3, p=4), this sets the
/// brute-force floor for the zero-knowledge threat model.
#[doc(hidden)]
pub const MIN_PASSWORD_LEN: usize = 8;

/// Platform side effects of the vault lifecycle. Each method stands in for
/// one call the code made before it moved into the engine, at the same
/// position. A platform without an OS keystore or post-unlock work
/// implements every method as a no-op (`is_os_kek_available` → `false`,
/// `consume_pending_cloud_session` → `None`).
pub trait VaultPlatformHooks: Send + Sync {
    /// Remove the OS-keystore unlock item (idempotent). Called by
    /// `startup_init` after each wipe-and-recreate of the DB.
    fn wipe_biometric_keychain(&self) -> Result<(), String>;
    /// Post-unlock platform sweep, called after the DB-side unlock sweeps
    /// with the DB lock released.
    fn post_unlock(&self, state: &AppState);
    /// Whether this platform has an OS keystore for an os_kek at all.
    fn is_os_kek_available(&self) -> bool;
    /// Generate a fresh os_kek and store it in the OS keystore.
    fn generate_os_kek(&self) -> Result<Zeroizing<[u8; 32]>, String>;
    /// Remove the os_kek from the OS keystore (idempotent).
    fn remove_os_kek(&self) -> Result<(), String>;
    /// Mirror the resolved unlock method into [`BIOMETRIC_ENABLED_SETTING`].
    fn sync_biometric_setting_for_unlock_method(
        &self,
        conn: &rusqlite::Connection,
        method: UnlockMethod,
    ) -> Result<(), String>;
    /// Consume the pending cloud session `session_id` and persist its sync
    /// settings into `conn`. `None`: no pending session (expired or
    /// missing); `Some(Ok(()))`: persisted; `Some(Err(e))`: persist failed.
    fn consume_pending_cloud_session(
        &self,
        conn: &rusqlite::Connection,
        session_id: &str,
    ) -> Option<Result<(), String>>;
}

#[doc(hidden)]
pub fn validate_password_length(password: &str) -> Result<(), String> {
    // Use `chars().count()` — Unicode scalar values, not bytes. This keeps
    // the check aligned with what the LockScreen displays to users as
    // "characters" and prevents "5 emoji = 20 bytes" bypasses.
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(format!(
            "Password must be at least {MIN_PASSWORD_LEN} characters"
        ));
    }
    Ok(())
}

#[doc(hidden)]
pub fn encode_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        // `write!` on a `String` cannot fail — the String is infallible as
        // a `fmt::Write` target. `.unwrap()` here is genuinely unreachable.
        write!(&mut s, "{b:02x}").unwrap();
    }
    s
}

#[doc(hidden)]
pub fn decode_hex_salt(hex: &str) -> Result<Vec<u8>, String> {
    let expected_chars = SALT_SIZE * 2;
    if hex.len() != expected_chars {
        return Err(format!(
            "Invalid salt length: expected {expected_chars} hex chars ({SALT_SIZE} bytes), got {}",
            hex.len()
        ));
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&hex[i..i + 2], 16).map_err(|e| format!("Invalid hex byte: {e}"))
        })
        .collect()
}
