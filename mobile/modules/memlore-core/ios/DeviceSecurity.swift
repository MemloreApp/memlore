import Darwin
import UIKit

/// The app-switcher privacy shield, the background auto-lock clock and
/// screen-capture detection (decisions 5 and 6). Main thread only. It never
/// calls the engine itself: `lockVault` queues `lock()` on the one serial
/// engine queue in `MemloreCoreModule.swift`, like every other engine call.
@MainActor
final class DeviceSecurity {
  /// Whether the engine holds the keys, as seen from the main thread.
  /// Process-wide like the engine, which outlives a JS reload.
  /// `MemloreCoreModule` sets it after each successful unlock, vault creation
  /// and lock, in the order those ran on the engine queue.
  static var vaultUnlocked = false

  /// How long a pending auto-lock keeps the shield up when JS never calls
  /// `releasePrivacyShield()` (no listener yet, a reload), so the app is never
  /// stuck behind it.
  private static let shieldSafetyTimeout: TimeInterval = 2

  private let sendEvent: (String, [String: Any?]) -> Void
  /// Queues the engine's `lock()`; `done` runs on the main thread after it.
  private let lockVault: (@escaping @MainActor () -> Void) -> Void

  private var observers: [NSObjectProtocol] = []
  private var shields: [UIView] = []
  /// `CLOCK_MONOTONIC` nanoseconds at the last `didEnterBackground`.
  private var backgroundedAt: UInt64?
  /// Locked at `didEnterBackground` (interval "immediate"); JS hears about it
  /// at the next `willEnterForeground`.
  private var lockedInBackground = false
  /// An auto-lock JS has not answered yet: the shield stays up until
  /// `releasePrivacyShield()` or the safety timeout.
  private var autoLockPending = false
  private var shieldTimeout: DispatchWorkItem?

  init(
    sendEvent: @escaping (String, [String: Any?]) -> Void,
    lockVault: @escaping (@escaping @MainActor () -> Void) -> Void
  ) {
    self.sendEvent = sendEvent
    self.lockVault = lockVault
  }

  func start() {
    observe(UIApplication.willResignActiveNotification) { $0.willResignActive() }
    observe(UIApplication.didEnterBackgroundNotification) { $0.didEnterBackground() }
    observe(UIApplication.willEnterForegroundNotification) { $0.willEnterForeground() }
    observe(UIApplication.didBecomeActiveNotification) { $0.didBecomeActive() }
    observe(UIScreen.capturedDidChangeNotification) { $0.capturedDidChange() }
  }

  func stop() {
    observers.forEach(NotificationCenter.default.removeObserver)
    observers = []
    shieldTimeout?.cancel()
    shieldTimeout = nil
    hideShield()
  }

  /// JS has swapped to the lock screen after `onAutoLock`.
  func releasePrivacyShield() {
    autoLockPending = false
    shieldTimeout?.cancel()
    shieldTimeout = nil
    // JS usually answers while the app is still inactive (between
    // willEnterForeground and didBecomeActive); didBecomeActive then takes
    // the shield off.
    if UIApplication.shared.applicationState == .active {
      hideShield()
    }
  }

  /// Recording, mirroring or AirPlay of any of the app's screens.
  static func isScreenCaptured() -> Bool {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .contains { $0.screen.isCaptured }
  }

  // MARK: - Lifecycle

  private func observe(
    _ name: Notification.Name, _ handler: @escaping @MainActor (DeviceSecurity) -> Void
  ) {
    let token = NotificationCenter.default.addObserver(
      forName: name, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        handler(self)
      }
    }
    observers.append(token)
  }

  /// Before the app-switcher snapshot: iOS takes it after didEnterBackground,
  /// from whatever is on screen. The Face ID sheet and Control Center also
  /// resign active; the shield covering the app then is accepted.
  private func willResignActive() {
    showShield()
  }

  private func didEnterBackground() {
    shieldTimeout?.cancel()
    shieldTimeout = nil
    showShield()
    // CLOCK_MONOTONIC keeps counting while the device sleeps.
    // CLOCK_UPTIME_RAW, mach_absolute_time and systemUptime stop, so a phone
    // that slept in a pocket would come back unlocked (fail open).
    backgroundedAt = clock_gettime_nsec_np(CLOCK_MONOTONIC)
    // A suspended app runs no timer, and a background task gets ~30 s, so a
    // 1/5/15-minute interval is measured at willEnterForeground. Only
    // "immediate" locks here.
    guard Self.vaultUnlocked, AutoLockCache.seconds == 0 else { return }
    Self.vaultUnlocked = false
    lockedInBackground = true
    lockInBackgroundTask()
  }

  private func willEnterForeground() {
    let stamp = backgroundedAt
    backgroundedAt = nil
    if lockedInBackground {
      lockedInBackground = false
      autoLockPending = true
      sendEvent("onAutoLock", [:])
      return
    }
    // Locked by the user, or never unlocked: nothing to tell JS.
    guard Self.vaultUnlocked, let stamp else { return }
    let now = clock_gettime_nsec_np(CLOCK_MONOTONIC)
    // The clock never goes back; if it did, lock (fail closed).
    let elapsed = now >= stamp ? now - stamp : UInt64.max
    guard elapsed >= UInt64(AutoLockCache.seconds) * NSEC_PER_SEC else { return }
    Self.vaultUnlocked = false
    autoLockPending = true
    lockVault {}
    sendEvent("onAutoLock", [:])
  }

  private func didBecomeActive() {
    guard autoLockPending else {
      hideShield()
      return
    }
    let timeout = DispatchWorkItem { [weak self] in
      MainActor.assumeIsolated { self?.releasePrivacyShield() }
    }
    shieldTimeout?.cancel()
    shieldTimeout = timeout
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.shieldSafetyTimeout, execute: timeout)
  }

  private func capturedDidChange() {
    let captured = Self.isScreenCaptured()
    sendEvent("onScreenCaptureChange", ["captured": captured])
  }

  // MARK: - Auto-lock

  /// The engine lock runs on its queue; the background task keeps the
  /// process from being suspended before it has.
  private func lockInBackgroundTask() {
    let app = UIApplication.shared
    var task = UIBackgroundTaskIdentifier.invalid
    let end = {
      guard task != .invalid else { return }
      app.endBackgroundTask(task)
      task = .invalid
    }
    task = app.beginBackgroundTask(withName: "memlore-auto-lock") { end() }
    lockVault { end() }
  }

  // MARK: - Shield

  /// An opaque view over each key window, added last so it sits above the
  /// React root and any presented screen.
  private func showShield() {
    for window in keyWindows() {
      if let shield = shields.first(where: { $0.superview === window }) {
        window.bringSubviewToFront(shield)
        continue
      }
      let shield = UIView(frame: window.bounds)
      shield.backgroundColor = .systemBackground
      shield.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      window.addSubview(shield)
      shields.append(shield)
    }
  }

  private func hideShield() {
    shields.forEach { $0.removeFromSuperview() }
    shields = []
  }

  private func keyWindows() -> [UIWindow] {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .compactMap { $0.keyWindow ?? $0.windows.first }
  }
}
