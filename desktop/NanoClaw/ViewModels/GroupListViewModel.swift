import Foundation

@MainActor
@Observable
final class GroupListViewModel {
    var groups: [Group] = []
    var isLoading = false

    private let connection: ConnectionManager

    init(connection: ConnectionManager = .shared) {
        self.connection = connection
    }

    func loadGroups() async {
        guard let url = URL(string: connection.serverURL) else { return }
        isLoading = true
        let token = connection.authToken.isEmpty ? nil : connection.authToken
        let client = APIClient(baseURL: url, authToken: token)
        if let groups = try? await client.getGroups() {
            self.groups = groups
        }
        isLoading = false
    }

    func deleteGroup(jid: String) async {
        guard let url = URL(string: connection.serverURL) else { return }
        let token = connection.authToken.isEmpty ? nil : connection.authToken
        let client = APIClient(baseURL: url, authToken: token)
        try? await client.deleteGroup(jid: jid)
        groups.removeAll { $0.jid == jid }
    }

    func createGroup(name: String) async -> Group? {
        guard let url = URL(string: connection.serverURL) else { return nil }
        let token = connection.authToken.isEmpty ? nil : connection.authToken
        let client = APIClient(baseURL: url, authToken: token)
        guard let result = try? await client.createGroup(name: name) else { return nil }
        let group = Group(jid: result.jid, name: result.name, folder: result.folder, addedAt: "")
        groups.append(group)
        return group
    }
}
