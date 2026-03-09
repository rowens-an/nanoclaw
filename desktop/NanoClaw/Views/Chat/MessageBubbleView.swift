import SwiftUI

struct MessageBubbleView: View {
    let message: Message

    // isFromMe = true means bot/agent message, false means user message
    private var isAgent: Bool { message.isFromMe }

    var body: some View {
        HStack {
            if !isAgent { Spacer(minLength: 60) }

            VStack(alignment: isAgent ? .leading : .trailing, spacing: 4) {
                if isAgent {
                    Text(message.senderName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Text(MarkdownRenderer.render(message.content))
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(isAgent ? Color(.controlBackgroundColor) : Color.accentColor)
                    .foregroundColor(isAgent ? Color.primary : Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: 12))

                Text(message.timestamp, style: .time)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            if isAgent { Spacer(minLength: 60) }
        }
    }
}
