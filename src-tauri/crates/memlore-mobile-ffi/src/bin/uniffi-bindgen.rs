//! Binding generator (`cargo run -p memlore-mobile-ffi --features uniffi-cli
//! --bin uniffi-bindgen -- generate --library <lib> ...`).

fn main() {
    uniffi::uniffi_bindgen_main()
}
