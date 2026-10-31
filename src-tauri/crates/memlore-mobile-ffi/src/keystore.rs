//! OS keystore of the biometric os_kek: the random 32-byte KEK that wraps the
//! vault master in the boot file's `os_kek_wrapped_master` (see
//! `memlore_engine::vault::biometric`). `MobileVaultHooks` forwards the
//! engine's os_kek hooks to an [`OsKeyStore`].
//!
//! On iOS the item lives in the Keychain under the same identity and access
//! control as the desktop's macOS item (`src-tauri/src/commands/keychain.rs`,
//! `mod platform`). Host builds (tests, `cargo check`) have no keystore. No
//! method logs or returns key bytes in an error.

use std::sync::Arc;

use memlore_engine::vault::OsKekError;
use zeroize::Zeroizing;

/// Where the os_kek is kept. Crate-internal: the Keychain calls are made from
/// Rust, Swift never sees this trait.
pub(crate) trait OsKeyStore: Send + Sync {
    /// Whether this platform has a keystore for the os_kek at all.
    fn is_available(&self) -> bool;
    /// Store `key`, replacing any existing item.
    fn store(&self, key: &[u8; 32]) -> Result<(), String>;
    /// Read the os_kek back. `NotFound`: the item is gone; `Cancelled`: the
    /// user dismissed (or failed) the biometric prompt.
    fn retrieve(&self) -> Result<Zeroizing<[u8; 32]>, OsKekError>;
    /// Remove the item. Idempotent: a missing item is not an error.
    fn remove(&self) -> Result<(), String>;
}

/// The keystore of the platform this build runs on.
pub(crate) fn default_keystore() -> Arc<dyn OsKeyStore> {
    #[cfg(target_os = "ios")]
    {
        Arc::new(ios::IosKeychain)
    }
    #[cfg(not(target_os = "ios"))]
    {
        Arc::new(UnavailableKeyStore)
    }
}

#[cfg(target_os = "ios")]
mod ios {
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::passwords::{
        delete_generic_password_options, generic_password, set_generic_password_options,
        AccessControlOptions, PasswordOptions,
    };
    use zeroize::Zeroizing;

    use super::{OsKekError, OsKeyStore};

    /// Same item as the desktop (`KEYCHAIN_SERVICE` / `KEYCHAIN_ACCOUNT`).
    const KEYCHAIN_SERVICE: &str = "com.memlore.encryption-key";
    const KEYCHAIN_ACCOUNT: &str = "default";
    const KEYCHAIN_LABEL: &str = "Memlore encryption key";

    // OSStatus values, hard-coded like the desktop so the sys crate is not a
    // direct dependency.
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
    const ERR_SEC_USER_CANCELED: i32 = -128;
    const ERR_SEC_AUTH_FAILED: i32 = -25293;

    /// The iOS Keychain: a generic password readable only while the device is
    /// unlocked, never migrated to another device, and only after a Face ID
    /// (or Touch ID) match with the currently enrolled biometrics.
    pub(super) struct IosKeychain;

    fn options() -> PasswordOptions {
        PasswordOptions::new_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
    }

    fn access_control() -> Result<SecAccessControl, String> {
        SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
            AccessControlOptions::BIOMETRY_CURRENT_SET.bits(),
        )
        .map_err(|e| format!("Failed to create access control: {e}"))
    }

    impl OsKeyStore for IosKeychain {
        /// Always `true`: whether biometry is enrolled is probed by Swift's
        /// `LAContext`, and the OS checks it again when the item is read.
        fn is_available(&self) -> bool {
            true
        }

        fn store(&self, key: &[u8; 32]) -> Result<(), String> {
            // Delete-then-add, like the desktop: on a duplicate,
            // `set_generic_password_options` falls back to `SecItemUpdate`,
            // which drops the access control.
            let _ = self.remove();

            let mut options = options();
            options.set_access_control(access_control()?);
            options.set_label(KEYCHAIN_LABEL);
            set_generic_password_options(key, options)
                .map_err(|e| format!("Failed to store key in Keychain: {e}"))
        }

        /// Shows the Face ID prompt and blocks the calling thread until it is
        /// answered. The intermediate buffer is wiped on drop.
        fn retrieve(&self) -> Result<Zeroizing<[u8; 32]>, OsKekError> {
            let bytes = generic_password(options())
                .map(Zeroizing::new)
                .map_err(|e| match e.code() {
                    ERR_SEC_ITEM_NOT_FOUND => OsKekError::NotFound,
                    ERR_SEC_USER_CANCELED | ERR_SEC_AUTH_FAILED => OsKekError::Cancelled,
                    _ => OsKekError::Other(format!("Biometric unlock failed: {e}")),
                })?;
            if bytes.len() != 32 {
                return Err(OsKekError::Other(
                    "os_kek item has unexpected size".to_string(),
                ));
            }
            let mut key = Zeroizing::new([0u8; 32]);
            key.copy_from_slice(&bytes);
            Ok(key)
        }

        fn remove(&self) -> Result<(), String> {
            match delete_generic_password_options(options()) {
                Ok(()) => Ok(()),
                Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
                Err(e) => Err(format!("Failed to remove key from Keychain: {e}")),
            }
        }
    }
}

/// Host builds: no keystore, so the engine never offers biometric unlock.
/// Same contract as the desktop off macOS: nothing to read, removing is a
/// no-op.
#[cfg(not(target_os = "ios"))]
struct UnavailableKeyStore;

#[cfg(not(target_os = "ios"))]
impl OsKeyStore for UnavailableKeyStore {
    fn is_available(&self) -> bool {
        false
    }

    fn store(&self, _key: &[u8; 32]) -> Result<(), String> {
        Err("os_kek unlock is not available on this platform".to_string())
    }

    fn retrieve(&self) -> Result<Zeroizing<[u8; 32]>, OsKekError> {
        Err(OsKekError::Unavailable)
    }

    fn remove(&self) -> Result<(), String> {
        Ok(())
    }
}

/// In-memory keystore for the inline tests: available, no prompt, and
/// `retrieve` on an empty store is `NotFound` like a missing Keychain item.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct MemoryKeyStore {
    key: std::sync::Mutex<Option<[u8; 32]>>,
}

#[cfg(test)]
impl OsKeyStore for MemoryKeyStore {
    fn is_available(&self) -> bool {
        true
    }

    fn store(&self, key: &[u8; 32]) -> Result<(), String> {
        *self.key.lock().unwrap() = Some(*key);
        Ok(())
    }

    fn retrieve(&self) -> Result<Zeroizing<[u8; 32]>, OsKekError> {
        let key = *self.key.lock().unwrap();
        key.map(Zeroizing::new).ok_or(OsKekError::NotFound)
    }

    fn remove(&self) -> Result<(), String> {
        *self.key.lock().unwrap() = None;
        Ok(())
    }
}
