import Foundation

struct Message: Identifiable, Codable, Equatable {
    let id: String
    let groupJid: String
    let sender: String
    let senderName: String
    let content: String
    let timestamp: Date
    let isFromMe: Bool

    enum CodingKeys: String, CodingKey {
        case id
        case groupJid = "chat_jid"
        case sender
        case senderName = "sender_name"
        case content
        case timestamp
        case isFromMe = "is_from_me"
    }

    init(id: String, groupJid: String, sender: String, senderName: String, content: String, timestamp: Date, isFromMe: Bool) {
        self.id = id
        self.groupJid = groupJid
        self.sender = sender
        self.senderName = senderName
        self.content = content
        self.timestamp = timestamp
        self.isFromMe = isFromMe
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        groupJid = try container.decode(String.self, forKey: .groupJid)
        sender = try container.decode(String.self, forKey: .sender)
        senderName = try container.decode(String.self, forKey: .senderName)
        content = try container.decode(String.self, forKey: .content)

        let ts = try container.decode(String.self, forKey: .timestamp)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        timestamp = formatter.date(from: ts) ?? Date()

        // Handle both Bool and Int (0/1) from JSON
        if let boolVal = try? container.decode(Bool.self, forKey: .isFromMe) {
            isFromMe = boolVal
        } else if let intVal = try? container.decode(Int.self, forKey: .isFromMe) {
            isFromMe = intVal != 0
        } else {
            isFromMe = false
        }
    }
}
