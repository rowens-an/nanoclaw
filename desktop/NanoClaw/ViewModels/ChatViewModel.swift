import Foundation

@MainActor
@Observable
final class ChatViewModel {
    var messages: [Message] = []
    var isTyping = false
    var inputText = ""

    private let groupJid: String
    private let connection: ConnectionManager

    init(groupJid: String, connection: ConnectionManager = .shared) {
        self.groupJid = groupJid
        self.connection = connection
    }

    func loadHistory() async {
        guard let url = URL(string: connection.serverURL) else { return }
        let token = connection.authToken.isEmpty ? nil : connection.authToken
        let client = APIClient(baseURL: url, authToken: token)
        if let history = try? await client.getMessages(jid: groupJid) {
            self.messages = history
        }
    }

    func clearSession() async {
        guard let url = URL(string: connection.serverURL) else { return }
        let token = connection.authToken.isEmpty ? nil : connection.authToken
        let client = APIClient(baseURL: url, authToken: token)
        try? await client.clearSession(jid: groupJid)
        messages.removeAll()
    }

    func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        inputText = ""

        let id = UUID().uuidString
        let msg = Message(
            id: id,
            groupJid: groupJid,
            sender: "desktop-user",
            senderName: "User",
            content: text,
            timestamp: Date(),
            isFromMe: false
        )
        messages.append(msg)

        connection.send(WSOutgoingMessage(groupJid: groupJid, content: text, id: id))
    }

    func handleIncoming(_ msg: WSIncomingMessage) {
        guard msg.groupJid == groupJid else { return }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: msg.timestamp) ?? Date()

        let isAgent = msg.sender != "desktop-user"
        let message = Message(
            id: msg.id,
            groupJid: msg.groupJid,
            sender: msg.sender,
            senderName: msg.sender,
            content: msg.content,
            timestamp: date,
            isFromMe: isAgent
        )

        // Agent responded — clear typing indicator
        if isAgent {
            isTyping = false
        }

        // Avoid duplicates (our own messages come back from the server)
        if !messages.contains(where: { $0.id == msg.id }) {
            messages.append(message)
        }
    }

    func handleTyping(_ indicator: WSTypingIndicator) {
        guard indicator.groupJid == groupJid else { return }
        isTyping = indicator.isTyping
    }
}
