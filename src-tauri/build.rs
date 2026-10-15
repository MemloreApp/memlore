fn main() {
    load_dotenv_for_oauth();
    link_macos_photo_picker();
    tauri_build::build()
}

// Link the macOS PhotoPicker Swift package via swift-rs.
//
// The Swift package targets macOS 13+ (matches `LSMinimumSystemVersion` in
// `Info.plist`). The first build invokes `swift build`, which adds ~10s on
// a cold cache; subsequent builds are incremental and cached.
//
// Linking is gated to macOS only — Linux/Windows builds skip Swift entirely.
fn link_macos_photo_picker() {
    #[cfg(target_os = "macos")]
    {
        swift_rs::SwiftLinker::new("13.0")
            .with_package("PhotoPicker", "./swift/PhotoPicker")
            .link();
        globalize_swift_rs_runtime("PhotoPicker");
    }
}

// Xcode 27's SwiftPM makes the `@_cdecl` exports of the archive's `SwiftRs.o`
// member local (`nm` shows `t`), and swift-rs only promotes the package's own
// member back to global. The release link then fails with undefined
// `_retain_object` / `_release_object` / `_string_from_bytes`. Promote the
// swift-rs runtime symbols with the same rustup `llvm-objcopy` swift-rs uses.
// On older toolchains `nm` shows them global already and nothing runs.
// TODO(later): drop once swift-rs globalizes its own member (docs/LATER.md).
#[cfg(target_os = "macos")]
fn globalize_swift_rs_runtime(package: &str) {
    use std::path::{Path, PathBuf};
    use std::process::Command;

    const SYMBOLS: &[&str] = &[
        "_retain_object",
        "_release_object",
        "_string_from_bytes",
        "_data_from_bytes",
    ];

    fn find_archives(dir: &Path, lib_file: &str, depth: u32, found: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if depth > 0 {
                    find_archives(&path, lib_file, depth - 1, found);
                }
            } else if entry.file_name() == lib_file {
                found.push(path);
            }
        }
    }

    let out_path = Path::new(&std::env::var("OUT_DIR").unwrap())
        .join("swift-rs")
        .join(package);
    let mut archives = Vec::new();
    find_archives(&out_path, &format!("lib{package}.a"), 4, &mut archives);
    // Only archives where at least one runtime symbol is local (`t`).
    archives.retain(|archive| {
        let Ok(nm) = Command::new("nm").arg(archive).output() else {
            return false;
        };
        String::from_utf8_lossy(&nm.stdout).lines().any(|line| {
            let mut it = line.split_whitespace();
            matches!((it.next(), it.next(), it.next()), (Some(_), Some("t"), Some(name)) if SYMBOLS.contains(&name))
        })
    });
    if archives.is_empty() {
        return;
    }

    let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
    let objcopy = Command::new(rustc)
        .args(["--print", "sysroot"])
        .output()
        .ok()
        .map(|o| {
            Path::new(String::from_utf8_lossy(&o.stdout).trim())
                .join("lib/rustlib")
                .join(format!("{}-apple-darwin", std::env::consts::ARCH))
                .join("bin/llvm-objcopy")
        })
        .filter(|p| p.exists());
    let Some(objcopy) = objcopy else {
        println!(
            "cargo:warning=llvm-objcopy not found (run `rustup component add llvm-tools`); \
             swift-rs runtime symbols are local and the link will fail"
        );
        return;
    };

    for archive in archives {
        let mut cmd = Command::new(&objcopy);
        for s in SYMBOLS {
            cmd.arg(format!("--globalize-symbol={s}"));
        }
        let ok = cmd.arg(&archive).status().is_ok_and(|s| s.success());
        if !ok {
            println!("cargo:warning=llvm-objcopy failed on {}", archive.display());
        }
    }
}

// Surface OAuth credentials from `.env` to `option_env!()` at compile time.
//
// `option_env!` is evaluated by the compiler from the process environment when
// the macro site is built. Cargo doesn't auto-load `.env`, and Tauri's
// `beforeDevCommand` only feeds env vars into Vite (frontend), not into cargo.
// Without this hook, `pnpm tauri dev` rebuilds the Rust crate without the
// developer's GDRIVE_CLIENT_ID/SECRET, so the binary keeps the placeholder
// values and Google's OAuth returns `invalid_client`.
fn load_dotenv_for_oauth() {
    const KEYS: &[&str] = &[
        "GDRIVE_CLIENT_ID",
        "GDRIVE_CLIENT_SECRET",
        "GOOGLE_FONTS_API_KEY",
        "MEMLORE_MAPKIT_TOKEN",
    ];

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../.env");
    for key in KEYS {
        println!("cargo:rerun-if-env-changed={key}");
    }

    let Ok(contents) = std::fs::read_to_string("../.env") else {
        return;
    };

    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((k, v)) = trimmed.split_once('=') else {
            continue;
        };
        let key = k.trim();
        if !KEYS.contains(&key) {
            continue;
        }
        // A real env var always wins over the .env file.
        if std::env::var_os(key).is_some() {
            continue;
        }
        let value = v.trim().trim_matches('"').trim_matches('\'');
        // Reject control characters (notably a bare CR) so a malformed `.env`
        // value cannot break out of the `cargo:rustc-env=...` directive and
        // inject a second cargo directive on the next "line" cargo sees.
        // `str::lines()` already strips `\n` / `\r\n`, but a lone `\r` would
        // survive into `value` and cargo would treat what follows as a new
        // line of stdout.
        if value.chars().any(|c| c.is_control()) {
            println!("cargo:warning=ignoring {key} from .env: value contains control characters");
            continue;
        }
        println!("cargo:rustc-env={key}={value}");
    }
}
