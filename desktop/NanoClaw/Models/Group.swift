import Foundation

struct Group: Identifiable, Codable, Equatable {
    let jid: String
    let name: String
    let folder: String
    let addedAt: String

    var id: String { jid }
}
