// ContentView.swift

import SwiftUI
import AVFoundation

// The main SwiftUI view for the popover UI.
struct ContentView: View {
    // The single source of truth for audio, transcription state, and data.
    @StateObject var audioManager: AudioManager

    var body: some View {
        VStack(spacing: 16) {
            HeaderView(isConnected: audioManager.isConnected)
            
            AudioInputPicker(
                availableDevices: audioManager.availableDevices,
                selectedDeviceID: $audioManager.selectedDeviceID
            )
            
            VolumeMeter(audioLevel: audioManager.audioLevel)

            TranscriptView(
                segments: audioManager.transcriptSegments,
                fallbackText: audioManager.transcription
            )
            
            ControlsView(
                isTranscribing: audioManager.isTranscribing,
                isTranscriptEmpty: audioManager.transcriptSegments.isEmpty,
                startAction: audioManager.startTranscription,
                stopAction: audioManager.stopTranscription,
                copyAction: {
                    let pasteboard = NSPasteboard.general
                    pasteboard.clearContents()
                    pasteboard.setString(audioManager.formattedFullTranscript(), forType: .string)
                }
            )
        }
        .frame(width: 380, height: 520)
        .onAppear {
            // Request permissions and load devices when the view appears.
            audioManager.checkPermissionsAndSetup()
        }
        .onDisappear {
            // Stop transcription when the popover is closed to save resources.
            audioManager.stopTranscription()
        }
    }
}


// MARK: - Subviews for ContentView

private struct HeaderView: View {
    let isConnected: Bool
    
    var body: some View {
        VStack {
            Text("Live Transcription")
                .font(.headline)
                .padding(.top)

            HStack {
                Circle()
                    .fill(isConnected ? .green : .red)
                    .frame(width: 10, height: 10)
                Text(isConnected ? "Connected to Server" : "Disconnected")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
    }
}

private struct AudioInputPicker: View {
    let availableDevices: [AVCaptureDevice]
    @Binding var selectedDeviceID: String?
    
    var body: some View {
        Picker("Audio Input:", selection: $selectedDeviceID) {
            ForEach(availableDevices, id: \.uniqueID) { device in
                Text(device.localizedName).tag(device.uniqueID as String?)
            }
        }
        .pickerStyle(MenuPickerStyle())
        .padding(.horizontal)
    }
}

private struct VolumeMeter: View {
    let audioLevel: Float
    
    private func colorForAudioLevel(_ level: Float) -> Color {
        if level > 0.7 { return .red }
        if level > 0.4 { return .yellow }
        return .green
    }

    var body: some View {
        VStack {
            Text("Volume")
                .font(.caption)
                .foregroundColor(.secondary)
            ProgressView(value: audioLevel)
                .progressViewStyle(LinearProgressViewStyle())
                .frame(height: 8)
                .accentColor(colorForAudioLevel(audioLevel))
        }
        .padding(.horizontal)
    }
}

private struct TranscriptView: View {
    let segments: [TranscriptSegment]
    let fallbackText: String
    
    private var timeFormatter: DateFormatter {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }
    
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if segments.isEmpty {
                         Text(fallbackText)
                            .foregroundColor(.secondary)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        ForEach(segments) { segment in
                            VStack(alignment: .leading) {
                                HStack {
                                    Text("[\(segment.timestamp, formatter: timeFormatter)]")
                                        .fontWeight(.bold)
                                    Text("(\(segment.speakerLabel)):")
                                        .fontWeight(.semibold)
                                        .foregroundColor(.accentColor)
                                }
                                .font(.caption)
                                
                                Text(segment.text)
                                    .font(.body)
                                    .textSelection(.enabled)
                            }
                            .id(segment.id)
                        }
                    }
                }
                .padding(12)
            }
            .background(Color(NSColor.textBackgroundColor))
            .cornerRadius(8)
            .frame(minHeight: 200)
            .padding(.horizontal)
            .onChange(of: segments) { _ in
                // Auto-scroll to the bottom when new content is added.
                proxy.scrollTo(segments.last?.id, anchor: .bottom)
            }
        }
    }
}

private struct ControlsView: View {
    let isTranscribing: Bool
    let isTranscriptEmpty: Bool
    let startAction: () -> Void
    let stopAction: () -> Void
    let copyAction: () -> Void

    var body: some View {
        HStack {
            Button(action: {
                if isTranscribing {
                    stopAction()
                } else {
                    startAction()
                }
            }) {
                Text(isTranscribing ? "Stop" : "Start")
                    .frame(maxWidth: .infinity)
            }
            .controlSize(.large)

            Button(action: copyAction) {
                Image(systemName: "doc.on.doc")
            }
            .controlSize(.large)
            .disabled(isTranscriptEmpty)
        }
        .padding([.horizontal, .bottom])
    }
}
