#!/usr/bin/env bash
# Build memlore-mobile-ffi for iOS and package it for the Expo native module.
# Usage: scripts/mobile-core-ios.sh (pnpm mobile:core:ios)
#   1. release staticlibs for aarch64-apple-ios and aarch64-apple-ios-sim
#      (IPHONEOS_DEPLOYMENT_TARGET=17.0);
#   2. Swift bindings (uniffi-bindgen, library mode) into
#      mobile/modules/memlore-core/ios/Generated (gitignored);
#   3. mobile/modules/memlore-core/ios/MemloreCoreFFI.xcframework (gitignored)
#      with both slices and the FFI header + module.modulemap.
# The target directory comes from `cargo metadata` (the shared Cargo cache).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ios_dir="$root/mobile/modules/memlore-core/ios"
gen_dir="$ios_dir/Generated"
xcframework="$ios_dir/MemloreCoreFFI.xcframework"
targets=(aarch64-apple-ios aarch64-apple-ios-sim)

export IPHONEOS_DEPLOYMENT_TARGET=17.0

cd "$root/src-tauri"
for target in "${targets[@]}"; do
  cargo build --locked --release -p memlore-mobile-ffi --target "$target"
done

target_dir="$(cargo metadata --format-version 1 --no-deps | jq -r .target_directory)"
device_lib="$target_dir/aarch64-apple-ios/release/libmemlore_mobile_ffi.a"
sim_lib="$target_dir/aarch64-apple-ios-sim/release/libmemlore_mobile_ffi.a"

rm -rf "$gen_dir"
mkdir -p "$gen_dir"
cargo run --locked -p memlore-mobile-ffi --features uniffi-cli --bin uniffi-bindgen -- \
  generate --library "$device_lib" --language swift --out-dir "$gen_dir"

# The xcframework's Headers need the FFI header and the generated modulemap
# under the name clang looks for (module.modulemap).
headers="$(mktemp -d)"
trap 'rm -rf "$headers"' EXIT
cp "$gen_dir/MemloreCoreFFIFFI.h" "$headers/"
cp "$gen_dir/MemloreCoreFFIFFI.modulemap" "$headers/module.modulemap"

# xcodebuild refuses to overwrite an existing xcframework.
rm -rf "$xcframework"
xcodebuild -create-xcframework \
  -library "$device_lib" -headers "$headers" \
  -library "$sim_lib" -headers "$headers" \
  -output "$xcframework"

ls -lh "$device_lib" "$sim_lib"
echo "mobile-core-ios: done in ${SECONDS}s"
