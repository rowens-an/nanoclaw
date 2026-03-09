import SwiftUI

struct SettingsView: View {
    @State private var serverURL: String = ConnectionManager.shared.serverURL
    @State private var authToken: String = ConnectionManager.shared.authToken

    var body: some View {
        Form {
            Section("Server") {
                TextField("Server URL", text: $serverURL)
                    .textFieldStyle(.roundedBorder)

                SecureField("Auth Token (optional)", text: $authToken)
                    .textFieldStyle(.roundedBorder)
            }

            Section {
                Button("Save & Reconnect") {
                    ConnectionManager.shared.serverURL = serverURL
                    ConnectionManager.shared.authToken = authToken
                    ConnectionManager.shared.disconnect()
                    ConnectionManager.shared.connect()
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 400)
        .padding()
    }
}
