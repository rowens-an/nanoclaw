import SwiftUI

@main
struct NanoClawApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .defaultSize(width: 900, height: 600)

        Settings {
            SettingsView()
        }
    }
}
