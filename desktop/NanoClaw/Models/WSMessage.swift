import Foundation

enum WSIncoming: Decodable {
    case message(WSIncomingMessage)
    case typing(WSTypingIndicator)

    enum MessageType: String, Decodable {
        case message
        case typing
    }

    private enum CodingKeys: String, CodingKey {
        case type
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(MessageType.self, forKey: .type)
        switch type {
        case .message:
            self = .message(try WSIncomingMessage(from: decoder))
        case .typing:
            self = .typing(try WSTypingIndicator(from: decoder))
        }
    }
}

struct WSIncomingMessage: Decodable {
    let type: String
    let groupJid: String
    let content: String
    let sender: String
    let timestamp: String
    let id: String
}

struct WSTypingIndicator: Decodable {
    let type: String
    let groupJid: String
    let isTyping: Bool
}

struct WSOutgoingMessage: Encodable {
    let type = "message"
    let groupJid: String
    let content: String
    let id: String
}
