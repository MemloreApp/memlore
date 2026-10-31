import ExpoModulesCore
import Foundation
import LocalAuthentication
import UIKit
import UniformTypeIdentifiers

/// Every engine call runs on this serial background queue, so the lazy
/// creation in `EngineHolder` never races and the JS thread never blocks.
private let engineQueue = DispatchQueue(label: "app.memlore.mobile.engine", qos: .userInitiated)

/// One engine per process, rooted at Application Support/vault. Expo creates
/// a new module instance on a JS reload; the engine (and its DB connection)
/// stays. Only touched on `engineQueue`.
private final class EngineHolder: @unchecked Sendable {
  static let shared = EngineHolder()
  private var engine: MemloreEngine?

  func get() throws -> MemloreEngine {
    if let engine {
      return engine
    }
    let support = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let vault = support.appendingPathComponent("vault", isDirectory: true)
    protectVaultFolder(vault)
    let appVersion =
      Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    let created = try MemloreEngine(appDataDir: vault.path, appVersion: appVersion)
    engine = created
    return created
  }
}

/// Applied before the engine opens `memlore.db`, on every launch (all steps
/// are idempotent). Best effort: a failure is logged and the vault still
/// opens, since the files work without these attributes.
private func protectVaultFolder(_ vault: URL) {
  let fileManager = FileManager.default
  // CompleteUntilFirstUserAuthentication, not Complete: M2's background sync
  // has to read the vault while the device is locked.
  let protection: [FileAttributeKey: Any] = [
    .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication
  ]
  do {
    try fileManager.createDirectory(
      at: vault, withIntermediateDirectories: true, attributes: protection)
  } catch {
    NSLog("[MemloreCore] could not create the vault folder: \(error)")
  }
  // `createDirectory` only applies the class to a folder it creates. New
  // files (SQLite's -wal/-shm/-journal, the boot file's temp-then-rename)
  // inherit the folder's class, so an existing folder needs it set too.
  do {
    try fileManager.setAttributes(protection, ofItemAtPath: vault.path)
  } catch {
    NSLog("[MemloreCore] could not set the vault folder's protection class: \(error)")
  }
  // Non-recursive: the engine writes only siblings of `memlore.db` here
  // today; a subfolder added later (M4 media) inherits the folder's class.
  do {
    for file in try fileManager.contentsOfDirectory(at: vault, includingPropertiesForKeys: nil) {
      do {
        try fileManager.setAttributes(protection, ofItemAtPath: file.path)
      } catch {
        NSLog("[MemloreCore] could not set a vault file's protection class: \(error)")
      }
    }
  } catch {
    NSLog("[MemloreCore] could not list the vault folder: \(error)")
  }
  // Excluded from iCloud and computer backups (decision 4): the boot file
  // holds the master key wrapped by the password, and a backup copy would
  // allow offline password guessing.
  do {
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var url = vault
    try url.setResourceValues(values)
  } catch {
    NSLog("[MemloreCore] could not exclude the vault from backups: \(error)")
  }
}

/// Maps engine errors to the codes `index.ts` documents. Rust messages carry
/// no key material; passwords and phrases are never part of a message here.
private func toException(_ error: Error) -> Exception {
  switch error {
  case MemloreError.Locked:
    return Exception(name: "MemloreLocked", description: "The vault is locked", code: "ERR_LOCKED")
  case MemloreError.WrongPassword:
    return Exception(
      name: "MemloreWrongPassword", description: "Wrong password", code: "ERR_WRONG_PASSWORD")
  case MemloreError.Io(let msg):
    return Exception(name: "MemloreIo", description: msg, code: "ERR_IO")
  case MemloreError.Format(let msg):
    return Exception(name: "MemloreFormat", description: msg, code: "ERR_FORMAT")
  case MemloreError.BiometricDisabled(let msg):
    return biometricDisabled(msg)
  case MemloreError.BiometricCancelled:
    return biometricCancelled()
  default:
    return Exception(name: "MemloreIo", description: error.localizedDescription, code: "ERR_IO")
  }
}

/// Runs `body` with the shared engine, rethrowing engine errors as coded
/// Expo exceptions.
private func withEngine<T>(_ body: (MemloreEngine) throws -> T) throws -> T {
  do {
    return try body(EngineHolder.shared.get())
  } catch {
    throw toException(error)
  }
}

private func biometricDisabled(_ msg: String) -> Exception {
  Exception(name: "MemloreBiometricDisabled", description: msg, code: "ERR_BIOMETRIC_DISABLED")
}

private func biometricCancelled() -> Exception {
  Exception(
    name: "MemloreBiometricCancelled", description: "Biometric unlock was cancelled",
    code: "ERR_BIOMETRIC_CANCELLED")
}

/// A failed `evaluatePolicy`. A failed match counts as cancelled, like
/// `errSecAuthFailed` in the FFI keystore: nothing changed.
private func toBiometricException(_ error: Error?) -> Exception {
  guard let error = error as? LAError else {
    let msg = error?.localizedDescription ?? "The biometric check failed"
    return Exception(name: "MemloreIo", description: msg, code: "ERR_IO")
  }
  switch error.code {
  case .userCancel, .appCancel, .systemCancel, .userFallback, .authenticationFailed:
    return biometricCancelled()
  case .biometryNotAvailable, .biometryNotEnrolled, .biometryLockout, .passcodeNotSet:
    return biometricDisabled(error.localizedDescription)
  default:
    return Exception(name: "MemloreIo", description: error.localizedDescription, code: "ERR_IO")
  }
}

/// The auto-lock interval read from the vault at the last unlock, for
/// `DeviceSecurity`, which needs it while the vault is locked. Never read
/// from the engine while locked.
@MainActor
enum AutoLockCache {
  /// The engine's default (`AUTO_LOCK_DEFAULT`): used until the first
  /// unlock, and when the read fails. Never 0 and never "don't lock".
  nonisolated static let defaultSeconds: UInt32 = 60
  static var seconds: UInt32 = defaultSeconds
}

private func cacheAutoLockSeconds(_ seconds: UInt32) {
  DispatchQueue.main.async {
    MainActor.assumeIsolated { AutoLockCache.seconds = seconds }
  }
}

/// Call on `engineQueue` right after an unlock or a vault creation
/// succeeded. A failed read keeps the unlock and caches the default.
private func refreshAutoLockCache(_ engine: MemloreEngine) {
  do {
    cacheAutoLockSeconds(try engine.autoLockSeconds())
  } catch {
    NSLog("[MemloreCore] could not read the auto-lock interval: \(error)")
    cacheAutoLockSeconds(AutoLockCache.defaultSeconds)
  }
}

/// Mirrors the engine's lock state for `DeviceSecurity`. Call on
/// `engineQueue` right after the engine call succeeded: the main thread runs
/// these in engine-queue order, so the flag ends in the engine's state.
private func markVault(unlocked: Bool) {
  DispatchQueue.main.async {
    MainActor.assumeIsolated { DeviceSecurity.vaultUnlocked = unlocked }
  }
}

/// `DeviceSecurity`'s auto-lock. On `engineQueue` like every other engine
/// call: since 2.5, `lock()` clears the key and then swaps in the placeholder
/// while an unlock installs the connection and then sets the key, so a lock
/// and an unlock on two queues could leave the key set over the placeholder.
private func autoLockVault(done: @escaping @MainActor () -> Void) {
  engineQueue.async {
    do {
      try withEngine { engine in try engine.lock() }
      markVault(unlocked: false)
    } catch {
      NSLog("[MemloreCore] auto-lock failed: \(error)")
    }
    DispatchQueue.main.async {
      MainActor.assumeIsolated { done() }
    }
  }
}

/// `BiometricStatus` in `index.ts`.
struct BiometricStatusRecord: Record {
  @Field var available: Bool = false
  /// `faceID` | `touchID` | `none`; the hardware's kind, even when
  /// `available` is false (not enrolled, locked out).
  @Field var kind: String = "none"

  init() {}

  init(available: Bool, kind: String) {
    self.available = available
    self.kind = kind
  }
}

private func biometricStatus() -> BiometricStatusRecord {
  let context = LAContext()
  // `biometryType` is only set once `canEvaluatePolicy` has run.
  let available = context.canEvaluatePolicy(
    .deviceOwnerAuthenticationWithBiometrics, error: nil)
  let kind: String
  switch context.biometryType {
  case .faceID: kind = "faceID"
  case .touchID: kind = "touchID"
  default: kind = "none"
  }
  return BiometricStatusRecord(available: available, kind: kind)
}

/// `EntryTitle` in `index.ts`.
struct EntryTitleRecord: Record {
  @Field var id: String = ""
  @Field var title: String? = nil
  /// Unix seconds.
  @Field var entryDate: Double = 0

  init() {}

  init(entry: EntryTitleFfi) {
    id = entry.id
    title = entry.title
    entryDate = Double(entry.entryDate)
  }
}

public class MemloreCoreModule: Module {
  /// Main thread only.
  private var deviceSecurity: DeviceSecurity?

  public func definition() -> ModuleDefinition {
    Name("MemloreCore")

    Events("onAutoLock", "onScreenCaptureChange")

    // Both hop to main in order, so a reload's destroy never runs before its
    // create. Destroy holds the module until the observers are gone.
    OnCreate {
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          let security = DeviceSecurity(
            sendEvent: { [weak module = self] name, body in module?.sendEvent(name, body) },
            lockVault: autoLockVault)
          security.start()
          self.deviceSecurity = security
        }
      }
    }

    OnDestroy {
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self.deviceSecurity?.stop()
          self.deviceSecurity = nil
        }
      }
    }

    AsyncFunction("releasePrivacyShield") {
      MainActor.assumeIsolated { self.deviceSecurity?.releasePrivacyShield() }
    }.runOnQueue(.main)

    AsyncFunction("isScreenCaptured") { () -> Bool in
      MainActor.assumeIsolated { DeviceSecurity.isScreenCaptured() }
    }.runOnQueue(.main)

    AsyncFunction("startupMode") { () throws -> String in
      try withEngine { engine in
        switch engine.startupMode() {
        case .firstLaunch: return "first_launch"
        case .passwordLocked: return "password_locked"
        case .bootFileCorrupt: return "boot_file_corrupt"
        }
      }
    }.runOnQueue(engineQueue)

    AsyncFunction("createVault") { (password: String) throws -> String in
      try withEngine { engine in
        let phrase = try engine.createVault(password: password)
        refreshAutoLockCache(engine)
        markVault(unlocked: true)
        return phrase
      }
    }.runOnQueue(engineQueue)

    AsyncFunction("unlock") { (password: String) throws in
      try withEngine { engine in
        try engine.unlock(password: password)
        refreshAutoLockCache(engine)
        markVault(unlocked: true)
      }
    }.runOnQueue(engineQueue)

    AsyncFunction("lock") { () throws in
      try withEngine { engine in try engine.lock() }
      markVault(unlocked: false)
    }.runOnQueue(engineQueue)

    // Not on `engineQueue`: `unlockWithBiometric` holds it for the whole
    // Face ID prompt.
    AsyncFunction("biometricStatus") { () -> BiometricStatusRecord in
      biometricStatus()
    }

    AsyncFunction("isBiometricUnlockEnabled") { () throws -> Bool in
      try withEngine { engine in engine.isBiometricUnlockEnabled() }
    }.runOnQueue(engineQueue)

    // One Face ID check first, so the user confirms before the engine stores
    // a Keychain item (storing it shows no prompt). Touch ID shows the
    // reason; Face ID shows the Info.plist purpose string.
    AsyncFunction("enableBiometric") { (promise: Promise) in
      let context = LAContext()
      // No "Enter Password" button: this prompt has no fallback.
      context.localizedFallbackTitle = ""
      // The purpose string, localised (vi.lproj/InfoPlist.strings); the
      // default is app.config.ts's English text.
      let reason = Bundle.main.localizedString(
        forKey: "NSFaceIDUsageDescription",
        value:
          "Memlore uses Face ID to unlock your journal. You can always use your password instead.",
        table: "InfoPlist")
      context.evaluatePolicy(
        .deviceOwnerAuthenticationWithBiometrics,
        localizedReason: reason
      ) { success, error in
        // Keeps the context alive until the prompt has answered.
        withExtendedLifetime(context) {}
        guard success else {
          promise.reject(toBiometricException(error))
          return
        }
        engineQueue.async {
          do {
            try withEngine { engine in try engine.enableBiometric() }
            promise.resolve()
          } catch let exception as Exception {
            // Already coded by `withEngine`; `toException` would remap it
            // to ERR_IO.
            promise.reject(exception)
          } catch {
            promise.reject(toException(error))
          }
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("disableBiometric") { () throws in
      try withEngine { engine in try engine.disableBiometric() }
    }.runOnQueue(engineQueue)

    AsyncFunction("unlockWithBiometric") { () throws in
      try withEngine { engine in
        try engine.unlockWithBiometric()
        refreshAutoLockCache(engine)
        markVault(unlocked: true)
      }
    }.runOnQueue(engineQueue)

    AsyncFunction("autoLockSeconds") { () throws -> Int in
      try withEngine { engine in try Int(engine.autoLockSeconds()) }
    }.runOnQueue(engineQueue)

    AsyncFunction("setAutoLockSeconds") { (seconds: Int) throws in
      guard let value = UInt32(exactly: seconds) else {
        throw Exception(
          name: "MemloreFormat", description: "auto-lock seconds out of range",
          code: "ERR_FORMAT")
      }
      try withEngine { engine in try engine.setAutoLockSeconds(seconds: value) }
      cacheAutoLockSeconds(value)
    }.runOnQueue(engineQueue)

    AsyncFunction("entryCount") { () throws -> Int in
      try withEngine { engine in try Int(engine.entryCount()) }
    }.runOnQueue(engineQueue)

    AsyncFunction("createEntry") { (title: String) throws -> String in
      try withEngine { engine in try engine.createEntry(title: title) }
    }.runOnQueue(engineQueue)

    AsyncFunction("listEntryTitles") { (limit: Int) throws -> [EntryTitleRecord] in
      try withEngine { engine in
        try engine.listEntryTitles(limit: UInt32(clamping: max(0, limit))).map {
          EntryTitleRecord(entry: $0)
        }
      }
    }.runOnQueue(engineQueue)

    // Yjs bytes cross the bridge as base64: the DOM editor decodes them, JS
    // never handles a byte array.
    AsyncFunction("loadEntryYjs") { (id: String) throws -> String in
      try withEngine { engine in try engine.loadEntryYjs(id: id).base64EncodedString() }
    }.runOnQueue(engineQueue)

    AsyncFunction("saveEntryYjs") {
      (id: String, fullStateB64: String, contentText: String, previewText: String) throws in
      guard let fullState = Data(base64Encoded: fullStateB64) else {
        throw Exception(
          name: "MemloreFormat", description: "fullState is not base64", code: "ERR_FORMAT")
      }
      try withEngine { engine in
        try engine.saveEntryYjs(
          id: id, fullState: fullState, contentText: contentText, previewText: previewText)
      }
    }.runOnQueue(engineQueue)

    // Spike 17.1, dev route only (`app/(dev)/spike-icloud.tsx`); read-only,
    // see ICloudSpike.swift. Rejects with code ERR_SPIKE.
    // TODO(later): see docs/LATER.md (remove with the dev spike routes).
    AsyncFunction("spikeICloudPickFolder") { (promise: Promise) in
      let presenter = self.appContext?.utilities?.currentViewController()
      MainActor.assumeIsolated {
        guard let presenter else {
          promise.reject(ICloudSpike.spikeError("No view controller to present the picker"))
          return
        }
        let delegate = FolderPickerDelegate(promise: promise)
        ICloudSpike.activePicker = delegate
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        picker.allowsMultipleSelection = false
        picker.delegate = delegate
        presenter.present(picker, animated: true)
      }
    }.runOnQueue(.main)

    AsyncFunction("spikeICloudBookmarkStatus") { () -> [String: Any] in
      ICloudSpike.bookmarkStatus()
    }.runOnQueue(ICloudSpike.queue)

    AsyncFunction("spikeICloudForgetBookmark") {
      ICloudSpike.forgetBookmark()
    }.runOnQueue(ICloudSpike.queue)

    AsyncFunction("spikeICloudList") { () throws -> [String: Any] in
      try ICloudSpike.list()
    }.runOnQueue(ICloudSpike.queue)

    AsyncFunction("spikeICloudStartDownloads") { () throws -> [String: Any] in
      try ICloudSpike.startDownloads()
    }.runOnQueue(ICloudSpike.queue)

    AsyncFunction("spikeICloudContainerProbe") { () -> [String: Any] in
      ICloudSpike.containerProbe()
    }.runOnQueue(ICloudSpike.queue)

    AsyncFunction("spikeICloudScheduleBackgroundTask") { () throws -> [String: Any] in
      try ICloudSpike.scheduleBackgroundTask()
    }.runOnQueue(ICloudSpike.queue)

    AsyncFunction("spikeICloudListLaterInBackground") { (delaySeconds: Double) in
      MainActor.assumeIsolated { ICloudSpike.listLaterInBackground(delay: delaySeconds) }
    }.runOnQueue(.main)

    AsyncFunction("spikeICloudBackgroundResult") { () -> String? in
      ICloudSpike.backgroundResult()
    }.runOnQueue(ICloudSpike.queue)

    // Spike 17.2, dev route only (`app/(dev)/spike-oauth.tsx`); PKCE and one
    // Keychain item, see OAuthSpike.swift. Rejects with code ERR_SPIKE.
    // TODO(later): see docs/LATER.md (remove with the dev spike routes).
    AsyncFunction("spikeOAuthPkce") { () throws -> [String: Any] in
      try OAuthSpike.pkce()
    }.runOnQueue(OAuthSpike.queue)

    AsyncFunction("spikeOAuthKeychainWrite") { (value: String) throws in
      try OAuthSpike.write(value)
    }.runOnQueue(OAuthSpike.queue)

    AsyncFunction("spikeOAuthKeychainRead") { () throws -> [String: Any] in
      try OAuthSpike.read()
    }.runOnQueue(OAuthSpike.queue)

    AsyncFunction("spikeOAuthKeychainDelete") { () throws -> Bool in
      try OAuthSpike.delete()
    }.runOnQueue(OAuthSpike.queue)
  }
}
