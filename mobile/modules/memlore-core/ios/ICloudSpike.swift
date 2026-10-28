import BackgroundTasks
import ExpoModulesCore
import Foundation
import UIKit
import UniformTypeIdentifiers

// Spike 17.1 (plan phase 17): can iOS read the folder the desktop writes in
// iCloud Drive (`com~apple~CloudDocs/Memlore`, plain files, no app container)?
// Read-only: it lists one picked folder and may download its files, never
// writes into iCloud Drive and never decrypts. It only accepts a folder named
// `MemloreSpike` (the fake test folder) and only reports `metadata.json` and
// `*.bin` names. Dev route: `app/(dev)/spike-icloud.tsx`. The sync plan's
// iCloud provider replaces this file.
// TODO(later): see docs/LATER.md (remove with the dev spike routes).

/// Shared state and file work of the spike. Everything that touches files runs
/// on `queue`, never on the main thread (coordinated reads can block).
enum ICloudSpike {
  static let folderName = "MemloreSpike"
  static let containerId = "iCloud.app.memlore"
  static let taskId = "app.memlore.mobile.spike-icloud"
  static let queue = DispatchQueue(label: "app.memlore.mobile.spike-icloud", qos: .userInitiated)

  private static let bookmarkKey = "spike.icloud.bookmark"
  private static let backgroundResultKey = "spike.icloud.backgroundResult"

  /// Retains the picker's delegate while the picker is up.
  @MainActor static var activePicker: FolderPickerDelegate?
  /// Set once the BGProcessingTask handler is registered at launch.
  nonisolated(unsafe) static var taskRegistered = false

  static func spikeError(_ description: String) -> Exception {
    Exception(name: "MemloreSpike", description: description, code: "ERR_SPIKE")
  }

  // MARK: Bookmark

  /// Called with the folder the picker returned. The bookmark made while the
  /// security scope is open carries that scope on iOS (`.withSecurityScope`
  /// is macOS-only).
  static func saveBookmark(for url: URL) throws {
    guard url.lastPathComponent == folderName else {
      throw spikeError("Pick the \(folderName) folder")
    }
    guard url.startAccessingSecurityScopedResource() else {
      throw spikeError("No security-scoped access to the picked folder")
    }
    defer { url.stopAccessingSecurityScopedResource() }
    let data = try url.bookmarkData(
      options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
    UserDefaults.standard.set(data, forKey: bookmarkKey)
  }

  static func forgetBookmark() {
    UserDefaults.standard.removeObject(forKey: bookmarkKey)
  }

  struct Resolved {
    let url: URL
    let wasStale: Bool
  }

  /// Resolves the stored bookmark, refreshing it when the system says stale.
  static func resolveBookmark() throws -> Resolved {
    guard let data = UserDefaults.standard.data(forKey: bookmarkKey) else {
      throw spikeError("No bookmark: pick the folder first")
    }
    var stale = false
    let url = try URL(resolvingBookmarkData: data, options: [], bookmarkDataIsStale: &stale)
    guard url.lastPathComponent == folderName else {
      throw spikeError("The bookmark does not point at \(folderName)")
    }
    if stale {
      try saveBookmark(for: url)
    }
    return Resolved(url: url, wasStale: stale)
  }

  static func bookmarkStatus() -> [String: Any] {
    guard UserDefaults.standard.data(forKey: bookmarkKey) != nil else {
      return ["hasBookmark": false]
    }
    do {
      let resolved = try resolveBookmark()
      let access = resolved.url.startAccessingSecurityScopedResource()
      if access { resolved.url.stopAccessingSecurityScopedResource() }
      return [
        "hasBookmark": true, "resolved": true, "wasStale": resolved.wasStale,
        "accessGranted": access, "folder": resolved.url.lastPathComponent,
      ]
    } catch {
      return ["hasBookmark": true, "resolved": false, "error": error.localizedDescription]
    }
  }

  // MARK: Listing

  private static let resourceKeys: [URLResourceKey] = [
    .isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey, .ubiquitousItemIsDownloadingKey,
    .fileSizeKey, .isDirectoryKey,
  ]

  /// `.a.bin.icloud` is the legacy placeholder name for a file not downloaded
  /// yet; returns the real name for both shapes.
  static func realName(_ raw: String) -> (name: String, legacyPlaceholder: Bool) {
    if raw.hasPrefix("."), raw.hasSuffix(".icloud"), raw.count > ".icloud".count + 1 {
      return (String(raw.dropFirst().dropLast(".icloud".count)), true)
    }
    return (raw, false)
  }

  /// Only the spike's own file names are ever reported.
  static func isSpikeFile(_ name: String) -> Bool {
    name == "metadata.json" || name.hasSuffix(".bin")
  }

  private static func statusName(_ status: URLUbiquitousItemDownloadingStatus?) -> String {
    switch status {
    case .some(.current): return "current"
    case .some(.downloaded): return "downloaded"
    case .some(.notDownloaded): return "notDownloaded"
    case .some(let other): return other.rawValue
    case .none: return "none"
    }
  }

  /// Coordinated, non-recursive listing of the bookmarked folder. Files that
  /// are already local are also read (coordinated) to count their bytes; a
  /// placeholder is never read here, since a coordinated read downloads it.
  static func list() throws -> [String: Any] {
    let resolved = try resolveBookmark()
    let folder = resolved.url
    guard folder.startAccessingSecurityScopedResource() else {
      throw spikeError("No security-scoped access to the bookmarked folder")
    }
    defer { folder.stopAccessingSecurityScopedResource() }

    var coordinationError: NSError?
    var listError: Error?
    var items: [[String: Any]] = []
    var otherCount = 0
    let coordinator = NSFileCoordinator()
    coordinator.coordinate(readingItemAt: folder, options: [], error: &coordinationError) { dir in
      do {
        let urls = try FileManager.default.contentsOfDirectory(
          at: dir, includingPropertiesForKeys: resourceKeys, options: [])
        for url in urls {
          let (name, legacyPlaceholder) = realName(url.lastPathComponent)
          guard isSpikeFile(name) else {
            otherCount += 1
            continue
          }
          let values = try? url.resourceValues(forKeys: Set(resourceKeys))
          let status = statusName(values?.ubiquitousItemDownloadingStatus)
          var item: [String: Any] = [
            "name": name,
            "legacyPlaceholder": legacyPlaceholder,
            "ubiquitous": values?.isUbiquitousItem ?? false,
            "status": status,
            "downloading": values?.ubiquitousItemIsDownloading ?? false,
            "size": values?.fileSize ?? -1,
          ]
          if !legacyPlaceholder && status == "current" {
            item["bytesRead"] = coordinatedByteCount(folder.appendingPathComponent(name))
          }
          items.append(item)
        }
      } catch {
        listError = error
      }
    }
    if let error = coordinationError ?? listError {
      throw spikeError("Listing failed: \(error.localizedDescription)")
    }
    items.sort { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
    return [
      "folder": folder.lastPathComponent, "wasStale": resolved.wasStale, "items": items,
      "otherCount": otherCount,
    ]
  }

  private static func coordinatedByteCount(_ url: URL) -> Int {
    var error: NSError?
    var count = -1
    NSFileCoordinator().coordinate(readingItemAt: url, options: .withoutChanges, error: &error) {
      count = (try? Data(contentsOf: $0).count) ?? -1
    }
    return count
  }

  /// `startDownloadingUbiquitousItem` for every spike file that is not local.
  static func startDownloads() throws -> [String: Any] {
    let resolved = try resolveBookmark()
    let folder = resolved.url
    guard folder.startAccessingSecurityScopedResource() else {
      throw spikeError("No security-scoped access to the bookmarked folder")
    }
    defer { folder.stopAccessingSecurityScopedResource() }
    var started: [String] = []
    var failed: [String] = []
    let urls = try FileManager.default.contentsOfDirectory(
      at: folder, includingPropertiesForKeys: resourceKeys, options: [])
    for url in urls {
      let (name, _) = realName(url.lastPathComponent)
      guard isSpikeFile(name) else { continue }
      let real = folder.appendingPathComponent(name)
      let status = try? real.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey])
        .ubiquitousItemDownloadingStatus
      if status == .current { continue }
      do {
        try FileManager.default.startDownloadingUbiquitousItem(at: real)
        started.append(name)
      } catch {
        failed.append("\(name): \(error.localizedDescription)")
      }
    }
    return ["started": started.sorted(), "failed": failed]
  }

  // MARK: Ubiquity container (test b)

  /// Only says whether the container resolves; its contents are never listed.
  static func containerProbe() -> [String: Any] {
    let token = FileManager.default.ubiquityIdentityToken != nil
    let url = FileManager.default.url(forUbiquityContainerIdentifier: containerId)
    return [
      "identityToken": token,
      "containerResolved": url != nil,
      "containerLeaf": url?.lastPathComponent ?? NSNull(),
    ]
  }

  // MARK: Background access (a4)

  /// Registers the BGProcessingTask handler, only in a build whose Info.plist
  /// permits the identifier (MEMLORE_SPIKE_ICLOUD=1, see app.config.ts);
  /// registering an identifier that is not permitted crashes.
  static func registerBackgroundTaskIfPermitted() {
    let permitted =
      Bundle.main.object(forInfoDictionaryKey: "BGTaskSchedulerPermittedIdentifiers") as? [String]
      ?? []
    guard permitted.contains(taskId) else { return }
    taskRegistered = BGTaskScheduler.shared.register(forTaskWithIdentifier: taskId, using: queue) {
      task in
      task.expirationHandler = { task.setTaskCompleted(success: false) }
      let ok = recordBackgroundListing(source: "BGProcessingTask")
      task.setTaskCompleted(success: ok)
    }
  }

  static func scheduleBackgroundTask() throws -> [String: Any] {
    guard taskRegistered else {
      throw spikeError("Task not registered: build with MEMLORE_SPIKE_ICLOUD=1")
    }
    let request = BGProcessingTaskRequest(identifier: taskId)
    request.requiresNetworkConnectivity = false
    request.requiresExternalPower = false
    do {
      try BGTaskScheduler.shared.submit(request)
    } catch {
      let ns = error as NSError
      throw spikeError("submit failed: \(ns.domain) \(ns.code) \(ns.localizedDescription)")
    }
    return ["submitted": taskId]
  }

  /// Fallback for the simulator: list after `delay` seconds inside a
  /// UIKit background task, so the app can be sent home first.
  @MainActor static func listLaterInBackground(delay: Double) {
    var taskId: UIBackgroundTaskIdentifier = .invalid
    taskId = UIApplication.shared.beginBackgroundTask(withName: "spike-icloud") {
      UIApplication.shared.endBackgroundTask(taskId)
    }
    queue.asyncAfter(deadline: .now() + delay) {
      _ = recordBackgroundListing(source: "beginBackgroundTask")
      DispatchQueue.main.async { UIApplication.shared.endBackgroundTask(taskId) }
    }
  }

  /// Resolve + coordinated listing, stored for the UI to read on return.
  /// Runs on `queue`.
  private static func recordBackgroundListing(source: String) -> Bool {
    let state = DispatchQueue.main.sync { () -> String in
      switch UIApplication.shared.applicationState {
      case .active: return "active"
      case .inactive: return "inactive"
      case .background: return "background"
      @unknown default: return "unknown"
      }
    }
    var result: [String: Any] = [
      "source": source, "at": ISO8601DateFormatter().string(from: Date()), "appState": state,
    ]
    var ok = false
    do {
      let listing = try list()
      let items = listing["items"] as? [[String: Any]] ?? []
      result["count"] = items.count
      result["statuses"] = items.map { "\($0["name"] ?? "?")=\($0["status"] ?? "?")" }
      ok = true
    } catch {
      result["error"] = error.localizedDescription
    }
    result["ok"] = ok
    if let data = try? JSONSerialization.data(withJSONObject: result),
      let json = String(data: data, encoding: .utf8)
    {
      UserDefaults.standard.set(json, forKey: backgroundResultKey)
    }
    return ok
  }

  static func backgroundResult() -> String? {
    UserDefaults.standard.string(forKey: backgroundResultKey)
  }
}

/// Folder picker callbacks; resolves the module promise once.
final class FolderPickerDelegate: NSObject, UIDocumentPickerDelegate {
  private var promise: Promise?

  init(promise: Promise) {
    self.promise = promise
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL])
  {
    guard let promise, let url = urls.first else { return }
    self.promise = nil
    ICloudSpike.queue.async {
      do {
        try ICloudSpike.saveBookmark(for: url)
        promise.resolve(url.lastPathComponent)
      } catch let error as Exception {
        promise.reject(error)
      } catch {
        promise.reject(ICloudSpike.spikeError(error.localizedDescription))
      }
    }
    Task { @MainActor in ICloudSpike.activePicker = nil }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    promise?.reject(ICloudSpike.spikeError("Cancelled"))
    promise = nil
    Task { @MainActor in ICloudSpike.activePicker = nil }
  }
}

/// Registers the BGProcessingTask before launch ends, as BGTaskScheduler
/// requires (a module's OnCreate runs too late under the scene life cycle).
/// A no-op in builds without the spike's Info.plist keys.
public class ICloudSpikeAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    ICloudSpike.registerBackgroundTaskIfPermitted()
    return true
  }
}
