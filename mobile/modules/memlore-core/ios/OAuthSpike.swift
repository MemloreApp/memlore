import CryptoKit
import ExpoModulesCore
import Foundation
import Security

// Spike 17.2 (plan phase 17): Google sign-in on iOS with the iOS OAuth client
// (PKCE, no client secret) and the tokens in the Keychain. This file holds only
// what JS cannot do without a new package: the PKCE randomness and SHA-256
// (CryptoKit, Security) and one Keychain item. The browser session and the
// HTTP calls are in `src/hooks/useOAuthSpike.ts`. Values passed in or out are
// never logged here. Dev route: `app/(dev)/spike-oauth.tsx`. The sync plan's
// Google Drive sign-in replaces this file.
// TODO(later): see docs/LATER.md (remove with the dev spike routes).

enum OAuthSpike {
  static let queue = DispatchQueue(label: "app.memlore.mobile.spike-oauth", qos: .userInitiated)

  /// One generic-password item holds the token JSON the hook writes.
  private static let service = "app.memlore.mobile.spike-oauth"
  private static let account = "google-drive"

  static func spikeError(_ description: String) -> Exception {
    Exception(name: "MemloreSpike", description: description, code: "ERR_SPIKE")
  }

  // MARK: PKCE

  private static func base64Url(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  private static func randomBase64Url(byteCount: Int) throws -> String {
    var bytes = [UInt8](repeating: 0, count: byteCount)
    let status = SecRandomCopyBytes(kSecRandomDefault, byteCount, &bytes)
    guard status == errSecSuccess else {
      throw spikeError("SecRandomCopyBytes failed (\(status))")
    }
    return base64Url(Data(bytes))
  }

  /// A PKCE pair like desktop's `generate_pkce` (48 random bytes give a
  /// 64-character verifier; challenge = BASE64URL(SHA-256(verifier)), no
  /// padding) plus a 16-byte `state` nonce.
  static func pkce() throws -> [String: Any] {
    let verifier = try randomBase64Url(byteCount: 48)
    let challenge = base64Url(Data(SHA256.hash(data: Data(verifier.utf8))))
    let state = try randomBase64Url(byteCount: 16)
    return ["verifier": verifier, "challenge": challenge, "state": state]
  }

  // MARK: Keychain

  private static var itemQuery: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }

  /// Readable after the first unlock (background sync) and never in a backup
  /// or iCloud Keychain.
  static func write(_ value: String) throws {
    let attributes: [String: Any] = [
      kSecValueData as String: Data(value.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    var status = SecItemUpdate(itemQuery as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      let add = itemQuery.merging(attributes) { _, new in new }
      status = SecItemAdd(add as CFDictionary, nil)
    }
    guard status == errSecSuccess else {
      throw spikeError("Keychain write failed (\(status))")
    }
  }

  /// `found: false`, or the stored value with the item's attributes.
  static func read() throws -> [String: Any] {
    var query = itemQuery
    query[kSecReturnData as String] = true
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound {
      return ["found": false]
    }
    guard status == errSecSuccess, let attributes = item as? [String: Any],
      let data = attributes[kSecValueData as String] as? Data,
      let value = String(data: data, encoding: .utf8)
    else {
      throw spikeError("Keychain read failed (\(status))")
    }
    let accessible = attributes[kSecAttrAccessible as String] as? String
    var result: [String: Any] = [
      "found": true,
      "value": value,
      "afterFirstUnlockThisDeviceOnly":
        accessible == (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String),
    ]
    if let group = attributes[kSecAttrAccessGroup as String] as? String {
      result["accessGroup"] = group
    }
    if let modified = attributes[kSecAttrModificationDate as String] as? Date {
      result["modifiedAt"] = modified.timeIntervalSince1970 * 1000
    }
    return result
  }

  /// True when an item was deleted, false when there was none.
  static func delete() throws -> Bool {
    let status = SecItemDelete(itemQuery as CFDictionary)
    if status == errSecItemNotFound {
      return false
    }
    guard status == errSecSuccess else {
      throw spikeError("Keychain delete failed (\(status))")
    }
    return true
  }
}
