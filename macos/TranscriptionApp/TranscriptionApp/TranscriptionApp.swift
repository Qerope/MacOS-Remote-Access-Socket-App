// TranscriptionApp.swift

import SwiftUI

@main
struct TranscriptionApp: App {
    // The AppDelegate is used to set up the app's lifecycle,
    // particularly for creating the menu bar item.
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        // The Settings scene is required for menu bar apps to have a settings window,
        // even if it's empty. This allows the app to be properly configured.
        Settings {
            EmptyView()
        }
    }
}
