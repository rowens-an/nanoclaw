import SwiftUI

struct ContentView: View {
    @State private var selectedGroupJid: String?
    @State private var groupListVM = GroupListViewModel()
    @State private var chatViewModels: [String: ChatViewModel] = [:]
    private let connection = ConnectionManager.shared

    var body: some View {
        NavigationSplitView {
            GroupListView(
                viewModel: groupListVM,
                selectedGroupJid: $selectedGroupJid
            )
        } detail: {
            if let jid = selectedGroupJid, let vm = chatViewModels[jid] {
                ChatView(viewModel: vm)
            } else {
                ContentUnavailableView(
                    "No Conversation Selected",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("Select a group from the sidebar or create a new one.")
                )
            }
        }
        .navigationSplitViewColumnWidth(min: 200, ideal: 250, max: 350)
        .onAppear {
            setupConnectionHandlers()
            connection.connect()
            Task { await groupListVM.loadGroups() }
        }
        .onChange(of: selectedGroupJid) { _, newJid in
            guard let jid = newJid else { return }
            if chatViewModels[jid] == nil {
                let vm = ChatViewModel(groupJid: jid)
                chatViewModels[jid] = vm
            }
            Task { await chatViewModels[jid]?.loadHistory() }
        }
    }

    private func setupConnectionHandlers() {
        connection.onMessage = { [self] msg in
            if let vm = chatViewModels[msg.groupJid] {
                vm.handleIncoming(msg)
            }
        }
        connection.onTyping = { [self] typing in
            if let vm = chatViewModels[typing.groupJid] {
                vm.handleTyping(typing)
            }
        }
    }
}
