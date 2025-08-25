//
//  AppDelegate.swift
//  TranscriptionApp
//
//  Created by VTD on 8/16/25.
//


// AppDelegate.swift

import SwiftUI

// Handles the setup of the menu bar item and its corresponding popover.
class AppDelegate: NSObject, NSApplicationDelegate {
    var statusBarItem: NSStatusItem!
    var popover: NSPopover!
    
    // Lazily instantiate the AudioManager to ensure it's created only when needed.
    // It's the central manager for all audio, transcription, and state logic.
    lazy var audioManager = AudioManager()

    func applicationDidFinishLaunching(_ aNotification: Notification) {
        // Create the popover that will contain the SwiftUI view
        popover = NSPopover()
        popover.contentSize = NSSize(width: 380, height: 520)
        popover.behavior = .transient // Closes automatically when clicking outside
        
        // Embed the main SwiftUI view within a hosting controller
        popover.contentViewController = NSHostingController(rootView: ContentView(audioManager: self.audioManager))

        // Create the status bar item (the icon in the menu bar)
        statusBarItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusBarItem.button {
            button.image = NSImage(systemSymbolName: "waveform.circle.fill", accessibilityDescription: "Transcription App")
            button.action = #selector(togglePopover(_:))
        }
    }

    /// Toggles the visibility of the popover.
    @objc func togglePopover(_ sender: AnyObject?) {
        if let button = statusBarItem.button {
            if popover.isShown {
                popover.performClose(sender)
            } else {
                popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
                // Make the popover's window the key window to receive events
                popover.contentViewController?.view.window?.becomeKey()
            }
        }
    }
}