import SwiftUI

struct GroupRowView: View {
    let group: Group

    var body: some View {
        HStack {
            Image(systemName: "bubble.left.and.bubble.right")
                .foregroundStyle(.secondary)
            Text(group.name)
                .lineLimit(1)
        }
    }
}
