import SwiftUI

struct GroupListView: View {
    @Bindable var viewModel: GroupListViewModel
    @Binding var selectedGroupJid: String?
    @State private var showNewGroupSheet = false
    @State private var groupToDelete: Group?

    var body: some View {
        VStack(spacing: 0) {
            ConnectionStatusView()
                .padding(.horizontal, 12)
                .padding(.vertical, 8)

            Divider()

            List(viewModel.groups, selection: $selectedGroupJid) { group in
                GroupRowView(group: group)
                    .tag(group.jid)
                    .contextMenu {
                        Button(role: .destructive) {
                            groupToDelete = group
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
            }
            .listStyle(.sidebar)

            Divider()

            Button {
                showNewGroupSheet = true
            } label: {
                Label("New Group", systemImage: "plus.circle")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .sheet(isPresented: $showNewGroupSheet) {
            NewGroupSheet { name in
                Task {
                    if let group = await viewModel.createGroup(name: name) {
                        selectedGroupJid = group.jid
                    }
                }
            }
        }
        .alert("Delete Group?", isPresented: Binding(
            get: { groupToDelete != nil },
            set: { if !$0 { groupToDelete = nil } }
        )) {
            Button("Cancel", role: .cancel) { groupToDelete = nil }
            Button("Delete", role: .destructive) {
                guard let group = groupToDelete else { return }
                if selectedGroupJid == group.jid {
                    selectedGroupJid = nil
                }
                Task { await viewModel.deleteGroup(jid: group.jid) }
                groupToDelete = nil
            }
        } message: {
            if let group = groupToDelete {
                Text("Are you sure you want to delete \"\(group.name)\"?")
            }
        }
    }
}
