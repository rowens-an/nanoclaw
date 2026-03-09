import SwiftUI

struct ChatView: View {
    @Bindable var viewModel: ChatViewModel
    @State private var showClearConfirmation = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(viewModel.messages) { message in
                            MessageBubbleView(message: message)
                                .id(message.id)
                        }
                    }
                    .padding()
                }
                .onChange(of: viewModel.messages.count) { _, _ in
                    if let last = viewModel.messages.last {
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }

            if viewModel.isTyping {
                TypingIndicatorView()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)
                    .padding(.bottom, 4)
            }

            Divider()
            MessageInputView(text: $viewModel.inputText, onSend: viewModel.sendMessage)
        }
        .toolbar {
            ToolbarItem(placement: .automatic) {
                Button {
                    showClearConfirmation = true
                } label: {
                    Image(systemName: "arrow.counterclockwise")
                }
                .help("Clear session")
            }
        }
        .alert("Clear Session", isPresented: $showClearConfirmation) {
            Button("Cancel", role: .cancel) { }
            Button("Clear", role: .destructive) {
                Task { await viewModel.clearSession() }
            }
        } message: {
            Text("This will delete all messages and start a fresh session. This cannot be undone.")
        }
    }
}
