import SwiftUI
import AVFoundation
import Speech
import SocketIO
import Combine

// Main App entry point
@main
struct TranscriptionApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        Settings {
            EmptyView()
        }
    }
}

// AppDelegate to set up the menu bar item and handle its actions
class AppDelegate: NSObject, NSApplicationDelegate {
    var statusBarItem: NSStatusItem!
    var popover: NSPopover!
    
    @objc func togglePopover(_ sender: AnyObject?) {
        if let button = statusBarItem.button {
            if popover.isShown {
                popover.performClose(sender)
            } else {
                popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
                popover.contentViewController?.view.window?.becomeKey()
            }
        }
    }

    func applicationDidFinishLaunching(_ aNotification: Notification) {
        popover = NSPopover()
        popover.contentSize = NSSize(width: 360, height: 480)
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(rootView: ContentView(audioManager: AudioManager()))

        statusBarItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        
        if let button = statusBarItem.button {
            button.image = NSImage(systemSymbolName: "waveform", accessibilityDescription: "Transcription App")
            button.action = #selector(togglePopover(_:))
        }
    }
}


// The main SwiftUI view for the popover
struct ContentView: View {
    @StateObject var audioManager: AudioManager

    var body: some View {
        VStack(spacing: 16) {
            Text("Live Transcription")
                .font(.headline)
                .foregroundColor(.primary)
                .padding(.top)

            HStack {
                Circle()
                    .fill(audioManager.isConnected ? .green : .red)
                    .frame(width: 10, height: 10)
                Text(audioManager.isConnected ? "Connected to Server" : "Disconnected")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Picker("Audio Input:", selection: $audioManager.selectedDeviceID) {
                ForEach(audioManager.availableDevices, id: \.uniqueID) { device in
                    Text(device.localizedName).tag(device.uniqueID as String?)
                }
            }
            .pickerStyle(MenuPickerStyle())
            .padding(.horizontal)

            VStack {
                Text("Volume")
                    .font(.caption)
                    .foregroundColor(.secondary)
                ProgressView(value: audioManager.audioLevel)
                    .progressViewStyle(LinearProgressViewStyle())
                    .frame(height: 8)
                    .accentColor(colorForAudioLevel(audioManager.audioLevel))
            }
            .padding(.horizontal)
            
            ScrollView {
                Text(audioManager.transcription)
                    .font(.body)
                    .foregroundColor(.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(Color(NSColor.textBackgroundColor))
                    .cornerRadius(8)
            }
            .frame(minHeight: 200)
            .padding(.horizontal)

            HStack {
                Button(action: {
                    if audioManager.isTranscribing {
                        audioManager.stopTranscription()
                    } else {
                        audioManager.startTranscription()
                    }
                }) {
                    Text(audioManager.isTranscribing ? "Stop" : "Start")
                        .frame(maxWidth: .infinity)
                }
                .controlSize(.large)
                
                Button(action: {
                    let pasteboard = NSPasteboard.general
                    pasteboard.clearContents()
                    pasteboard.setString(audioManager.transcription, forType: .string)
                }) {
                    Image(systemName: "doc.on.doc")
                }
                .controlSize(.large)
                .disabled(audioManager.transcription.isEmpty)
            }
            .padding([.horizontal, .bottom])
        }
        .frame(width: 360, height: 480)
        .onAppear {
            audioManager.checkPermissionsAndSetup()
        }
        .onDisappear {
            audioManager.stopTranscription()
        }
    }
    
    private func colorForAudioLevel(_ level: Float) -> Color {
        if level > 0.7 { return .red }
        if level > 0.4 { return .yellow }
        return .green
    }
}


// Manages audio, speech recognition, networking, and state
class AudioManager: NSObject, ObservableObject, SFSpeechRecognizerDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
    
    // UI State Properties
    @Published var availableDevices: [AVCaptureDevice] = []
    @Published var selectedDeviceID: String? = nil {
        didSet {
            if oldValue != selectedDeviceID && isTranscribing {
                stopTranscription()
                startTranscription()
            }
        }
    }
    @Published var audioLevel: Float = 0.0
    @Published var transcription: String = "Select an input and press Start."
    @Published var isTranscribing = false
    
    // Networking Properties
    @Published var isConnected = false
    private let socketService = SocketService()
    private var cancellables = Set<AnyCancellable>()

    // AVCaptureSession properties
    private var captureSession: AVCaptureSession?
    private let audioOutput = AVCaptureAudioDataOutput()
    private let sessionQueue = DispatchQueue(label: "sessionQueue", qos: .userInitiated)

    // Speech Recognition properties
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    
    
    private var clipboardTimer: Timer?
    private var lastClipboardContent: String = ""
    
    
    override init() {
        super.init()
        speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        speechRecognizer?.delegate = self
        
        socketService.$isConnected
            .receive(on: DispatchQueue.main)
            .assign(to: \.isConnected, on: self)
            .store(in: &cancellables)
    }

    func checkPermissionsAndSetup() {
        AVCaptureDevice.requestAccess(for: .audio) { _ in
            SFSpeechRecognizer.requestAuthorization { authStatus in
                DispatchQueue.main.async {
                    if authStatus == .authorized {
                        self.loadAudioDevices()
                    } else {
                        self.transcription = "Speech recognition access denied."
                    }
                }
            }
        }
    }
    
    private func loadAudioDevices() {
        let discoverySession = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInMicrophone, .externalUnknown], mediaType: .audio, position: .unspecified)
        DispatchQueue.main.async {
            self.availableDevices = discoverySession.devices
            if let defaultDevice = AVCaptureDevice.default(for: .audio), self.selectedDeviceID == nil {
                self.selectedDeviceID = defaultDevice.uniqueID
            }
        }
    }

    func startTranscription() {
        guard !isTranscribing else { return }
        
        socketService.connect()
        startClipboardMonitoring()
        
        sessionQueue.async { [weak self] in
            guard let self = self else { return }

            self.captureSession = AVCaptureSession()
            guard let captureSession = self.captureSession, let deviceId = self.selectedDeviceID else { return }

            guard let audioDevice = AVCaptureDevice(uniqueID: deviceId),
                  let audioInput = try? AVCaptureDeviceInput(device: audioDevice) else {
                DispatchQueue.main.async { self.transcription = "Error: Could not create audio input." }
                return
            }
            
            if captureSession.canAddInput(audioInput) {
                captureSession.addInput(audioInput)
            } else {
                DispatchQueue.main.async { self.transcription = "Error: Could not add audio input." }
                return
            }

            if captureSession.canAddOutput(self.audioOutput) {
                self.audioOutput.setSampleBufferDelegate(self, queue: self.sessionQueue)
                captureSession.addOutput(self.audioOutput)
            } else {
                DispatchQueue.main.async { self.transcription = "Error: Could not add audio output." }
                return
            }
            
            self.recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
            guard let recognitionRequest = self.recognitionRequest else { fatalError("Unable to create request") }
            recognitionRequest.shouldReportPartialResults = true
            recognitionRequest.addsPunctuation = true

            self.recognitionTask = self.speechRecognizer?.recognitionTask(with: recognitionRequest) { result, error in
                if let result = result {
                    let newTranscription = result.bestTranscription.formattedString
                    DispatchQueue.main.async {
                        self.transcription = newTranscription
                        self.socketService.sendTranscript(text: newTranscription)
                    }
                }
                if error != nil || result?.isFinal == true {
                    self.stopTranscription()
                }
            }
            
            captureSession.startRunning()
            
            DispatchQueue.main.async {
                self.isTranscribing = true
                self.transcription = "Listening..."
            }
        }
    }
    
    func stopTranscription() {
        sessionQueue.async { [weak self] in
            guard let self = self, self.isTranscribing else { return }
            
            self.captureSession?.stopRunning()
            if self.audioOutput.sampleBufferDelegate != nil {
                 self.audioOutput.setSampleBufferDelegate(nil, queue: nil)
            }
            self.captureSession = nil
            
            self.recognitionRequest?.endAudio()
            self.recognitionTask?.cancel()
            self.recognitionRequest = nil
            self.recognitionTask = nil
            
            DispatchQueue.main.async {
                self.isTranscribing = false
                self.audioLevel = 0.0
                if self.transcription.isEmpty || self.transcription == "Listening..." {
                    self.transcription = "Press Start to begin."
                }
                self.socketService.disconnect()
            }
        }
    }
    
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pcmBuffer = self.toPCMBuffer(sampleBuffer: sampleBuffer) else {
            return
        }

        self.recognitionRequest?.appendAudioSampleBuffer(sampleBuffer)
        
        self.updateAudioLevel(buffer: pcmBuffer)
    }
    
    // MARK: - Clipboard Methods
    private func startClipboardMonitoring() {
        stopClipboardMonitoring() // Prevent duplicate timers
        lastClipboardContent = NSPasteboard.general.string(forType: .string) ?? ""
        clipboardTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.checkClipboard()
        }
    }
    
    private func stopClipboardMonitoring() {
        clipboardTimer?.invalidate()
        clipboardTimer = nil
    }

    private func checkClipboard() {
        guard let newContent = NSPasteboard.general.string(forType: .string) else { return }
        
        if newContent != lastClipboardContent && !newContent.isEmpty {
            lastClipboardContent = newContent
            socketService.sendClipboard(content: newContent)
        }
    }
    
    private func updateAudioLevel(buffer: AVAudioPCMBuffer) {
        guard let channelData = buffer.floatChannelData else { return }
        let channelDataValue = channelData.pointee
        let channelDataValueArray = UnsafeBufferPointer(start: channelDataValue, count: Int(buffer.frameLength))
        let rms = sqrt(channelDataValueArray.map { $0 * $0 }.reduce(0, +) / Float(buffer.frameLength))
        let avgPower = 20 * log10(rms)
        let meterLevel = self.scaledPower(power: avgPower)
        
        DispatchQueue.main.async { self.audioLevel = meterLevel }
    }
    
    private func scaledPower(power: Float) -> Float {
        guard power.isFinite else { return 0.0 }
        let minDb: Float = -80.0
        if power < minDb { return 0.0 }
        if power >= 0.0 { return 1.0 }
        let root: Float = 2.0
        let minAmp = powf(10.0, 0.05 * minDb)
        let inverseAmpRange = 1.0 / (1.0 - minAmp)
        let amp = powf(10.0, 0.05 * power)
        let adjAmp = (amp - minAmp) * inverseAmpRange
        return powf(adjAmp, 1.0 / root)
    }
    
    private func toPCMBuffer(sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard let format = CMSampleBufferGetFormatDescription(sampleBuffer),
              let pcmBuffer = AVAudioPCMBuffer(pcmFormat: AVAudioFormat(cmAudioFormatDescription: format), frameCapacity: AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))) else {
            return nil
        }
        pcmBuffer.frameLength = pcmBuffer.frameCapacity
        
        do {
            try CMSampleBufferCopyPCMDataIntoAudioBufferList(sampleBuffer, at: 0, frameCount: Int32(pcmBuffer.frameLength), into: pcmBuffer.mutableAudioBufferList)
        } catch {
            print("Error copying PCM data: \(error)")
            return nil
        }
        
        return pcmBuffer
    }
    
    private func toData(sampleBuffer: CMSampleBuffer) -> Data? {
        var audioBufferList = AudioBufferList()
        var blockBuffer: CMBlockBuffer?
        
        do {
            // FIX: Added the missing nil and 0 arguments for the modern API.
            try CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
                sampleBuffer,
                bufferListSizeNeededOut: nil,
                bufferListOut: &audioBufferList,
                bufferListSize: MemoryLayout<AudioBufferList>.size,
                blockBufferAllocator: nil,      // was missing
                blockBufferMemoryAllocator: nil, // was missing
                flags: 0,                       // was missing
                blockBufferOut: &blockBuffer
            )
        } catch {
            print("Failed to get audio buffer list: \(error)")
            return nil
        }

        guard let mData = audioBufferList.mBuffers.mData else {
            return nil
        }
        
        return Data(bytes: mData, count: Int(audioBufferList.mBuffers.mDataByteSize))
    }
    
    func speechRecognizer(_ speechRecognizer: SFSpeechRecognizer, availabilityDidChange available: Bool) {
        if !available {
            DispatchQueue.main.async {
                self.transcription = "Speech recognizer not available."
                self.stopTranscription()
            }
        }
    }
}
