import SwiftUI

struct ConnectionStatusView: View {
    private let connection = ConnectionManager.shared

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)

            Text(connection.assistantName)
                .font(.headline)

            Spacer()
        }
    }

    private var statusColor: Color {
        switch connection.state {
        case .connected: .green
        case .connecting: .orange
        case .disconnected: .red
        }
    }
}
