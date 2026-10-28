import ExpoModulesCore
import Foundation
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
    let appVersion =
      Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    let created = try MemloreEngine(
      appDataDir: support.appendingPathComponent("vault", isDirectory: true).path,
      appVersion: appVersion)
    engine = created
    return created
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
  public func definition() -> ModuleDefinition {
    Name("MemloreCore")

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
      try withEngine { engine in try engine.createVault(password: password) }
    }.runOnQueue(engineQueue)

    AsyncFunction("unlock") { (password: String) throws in
      try withEngine { engine in try engine.unlock(password: password) }
    }.runOnQueue(engineQueue)

    AsyncFunction("lock") { () throws in
      try withEngine { engine in try engine.lock() }
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
