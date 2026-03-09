import Foundation

enum ConnectionState: Equatable {
    case disconnected
    case connecting
    case connected
}

@Observable
final class ConnectionManager: @unchecked Sendable {
    nonisolated(unsafe) static let shared = ConnectionManager()

    private(set) var state: ConnectionState = .disconnected
    private(set) var assistantName: String = "NanoClaude"

    private var webSocketTask: URLSessionWebSocketTask?
    private var reconnectDelay: TimeInterval = 1
    private let maxReconnectDelay: TimeInterval = 30
    private var shouldReconnect = true

    var onMessage: ((WSIncomingMessage) -> Void)?
    var onTyping: ((WSTypingIndicator) -> Void)?

    var serverURL: String {
        get { UserDefaults.standard.string(forKey: "serverURL") ?? "http://127.0.0.1:19280" }
        set { UserDefaults.standard.set(newValue, forKey: "serverURL") }
    }

    var authToken: String {
        get { KeychainHelper.get(key: "desktopAuthToken") ?? "" }
        set { KeychainHelper.set(key: "desktopAuthToken", value: newValue) }
    }

    private init() {}

    func connect() {
        shouldReconnect = true
        reconnectDelay = 1
        establishConnection()
    }

    func disconnect() {
        shouldReconnect = false
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        state = .disconnected
    }

    func send(_ message: WSOutgoingMessage) {
        guard let task = webSocketTask else { return }
        do {
            let data = try JSONEncoder().encode(message)
            task.send(.string(String(data: data, encoding: .utf8)!)) { [weak self] error in
                if let error {
                    print("WebSocket send error: \(error)")
                    self?.scheduleReconnect()
                }
            }
        } catch {
            print("WebSocket encode error: \(error)")
        }
    }

    private func establishConnection() {
        state = .connecting

        var wsURL = serverURL
            .replacingOccurrences(of: "http://", with: "ws://")
            .replacingOccurrences(of: "https://", with: "wss://")
        wsURL += "/ws"

        if !authToken.isEmpty {
            wsURL += "?token=\(authToken)"
        }

        guard let url = URL(string: wsURL) else {
            state = .disconnected
            return
        }

        let task = URLSession.shared.webSocketTask(with: url)
        self.webSocketTask = task
        task.resume()

        // Fetch status to get assistant name
        Task {
            await fetchStatus()
        }

        state = .connected
        reconnectDelay = 1
        receiveMessage()
    }

    private func receiveMessage() {
        webSocketTask?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handleMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.handleMessage(text)
                    }
                @unknown default:
                    break
                }
                self.receiveMessage()
            case .failure:
                self.scheduleReconnect()
            }
        }
    }

    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let incoming = try? JSONDecoder().decode(WSIncoming.self, from: data) else {
            return
        }

        Task { @MainActor in
            switch incoming {
            case .message(let msg):
                self.onMessage?(msg)
            case .typing(let typing):
                self.onTyping?(typing)
            }
        }
    }

    private func scheduleReconnect() {
        guard shouldReconnect else { return }
        state = .disconnected
        webSocketTask = nil

        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, maxReconnectDelay)

        Task {
            try? await Task.sleep(for: .seconds(delay))
            guard self.shouldReconnect else { return }
            self.establishConnection()
        }
    }

    private func fetchStatus() async {
        guard let url = URL(string: serverURL) else { return }
        let client = APIClient(baseURL: url, authToken: authToken.isEmpty ? nil : authToken)
        if let status = try? await client.getStatus() {
            await MainActor.run {
                self.assistantName = status.assistantName
            }
        }
    }
}

// Simple Keychain helper
enum KeychainHelper {
    static func set(key: String, value: String) {
        let data = value.data(using: .utf8)!
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecAttrService as String: "com.nanoclaw.desktop",
        ]
        SecItemDelete(query as CFDictionary)
        if !value.isEmpty {
            var addQuery = query
            addQuery[kSecValueData as String] = data
            SecItemAdd(addQuery as CFDictionary, nil)
        }
    }

    static func get(key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecAttrService as String: "com.nanoclaw.desktop",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
