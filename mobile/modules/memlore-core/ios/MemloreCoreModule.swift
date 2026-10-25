import ExpoModulesCore
import Foundation

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
  }
}
