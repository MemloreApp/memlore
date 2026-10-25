# Local Expo module over the UniFFI bindings of memlore-mobile-ffi.
# MemloreCoreFFI.xcframework and Generated/ are build outputs of
# `pnpm mobile:core:ios` (gitignored); run it before `pod install`.
Pod::Spec.new do |s|
  s.name           = 'MemloreCore'
  s.version        = '0.1.0'
  s.summary        = 'Memlore engine for the mobile app'
  s.description    = 'Expo module that calls memlore-engine through its UniFFI Swift bindings.'
  s.author         = 'Memlore'
  s.homepage       = 'https://memlore.app'
  s.license        = 'AGPL-3.0-or-later'
  s.platforms      = { :ios => '17.0' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.vendored_frameworks = 'MemloreCoreFFI.xcframework'
  s.source_files = 'Generated/*.swift', '*.swift'

  # The xcframework's simulator slice is arm64 only. Release builds every
  # architecture (ONLY_ACTIVE_ARCH=NO), and with x86_64 in ARCHS CocoaPods
  # finds no matching slice, so the FFI module is missing. Device builds are
  # unaffected.
  no_intel_simulator = { 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'x86_64' }
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }.merge(no_intel_simulator)
  s.user_target_xcconfig = no_intel_simulator
end
