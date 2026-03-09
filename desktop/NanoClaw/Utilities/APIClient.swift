import Foundation

actor APIClient {
    let baseURL: URL
    private var authToken: String?

    init(baseURL: URL, authToken: String? = nil) {
        self.baseURL = baseURL
        self.authToken = authToken
    }

    func setAuthToken(_ token: String?) {
        self.authToken = token
    }

    func getStatus() async throws -> StatusResponse {
        try await get("/api/status")
    }

    func getGroups() async throws -> [Group] {
        try await get("/api/groups")
    }

    func createGroup(name: String) async throws -> CreateGroupResponse {
        try await post("/api/groups", body: ["name": name])
    }

    func getMessages(jid: String, limit: Int = 200) async throws -> [Message] {
        let encoded = jid.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? jid
        return try await get("/api/groups/\(encoded)/messages?limit=\(limit)")
    }

    func clearSession(jid: String) async throws {
        let encoded = jid.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? jid
        var request = URLRequest(url: baseURL.appendingPathComponent("/api/groups/\(encoded)/session"))
        request.httpMethod = "DELETE"
        addAuth(&request)
        let _ = try await URLSession.shared.data(for: request)
    }

    func deleteGroup(jid: String) async throws {
        let encoded = jid.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? jid
        var request = URLRequest(url: baseURL.appendingPathComponent("/api/groups/\(encoded)"))
        request.httpMethod = "DELETE"
        addAuth(&request)
        let _ = try await URLSession.shared.data(for: request)
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "GET"
        addAuth(&request)
        let (data, _) = try await URLSession.shared.data(for: request)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func post<T: Decodable>(_ path: String, body: [String: String]) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        addAuth(&request)
        let (data, _) = try await URLSession.shared.data(for: request)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func addAuth(_ request: inout URLRequest) {
        if let token = authToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
    }
}

struct StatusResponse: Decodable {
    let connected: Bool
    let assistantName: String
    let clients: Int
}

struct CreateGroupResponse: Decodable {
    let jid: String
    let name: String
    let folder: String
    let message: String
}
