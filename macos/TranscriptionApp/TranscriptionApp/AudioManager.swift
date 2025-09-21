//
//  AudioManager.swift
//  TranscriptionApp
//
//  Created by VTD on 8/16/25.
//


// AudioManager.swift

import SwiftUI
import AVFoundation
import Speech
import Combine

// Manages audio capture, speech recognition, networking, and application state.
class AudioManager: NSObject, ObservableObject, SFSpeechRecognizerDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {

    // MARK: - Published Properties for UI
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
    @Published var isConnected = false
    
    // MARK: - New Diarization Properties
    @Published var transcriptSegments: [TranscriptSegment] = []
    private var currentSegment: TranscriptSegment?
    private var previousSegment: TranscriptSegment?
    private var currentSpeakerID: Int = 1
    private let speakerLabels: [Int: String] = [1: "Interviewer", 2: "Coder"]

    // MARK: - Pause Detection Properties
    private var silenceTimer: Timer?
    private let silenceThreshold: Float = 0 // Slightly increased to avoid noise triggers
    private let significantPauseDuration: TimeInterval = 1.8 // Seconds of silence to trigger a speaker switch
    
    // --- NEW PROPERTY ---
    // Threshold to determine how much louder one channel must be to be considered dominant.
    // A higher value makes it less likely to switch speakers.
    private let speakerChangeThreshold: Float = 0.05

    // MARK: - Private State Properties
    private let socketService = SocketService()
    private var cancellables = Set<AnyCancellable>()
    private var captureSession: AVCaptureSession?
    private let audioOutput = AVCaptureAudioDataOutput()
    private let sessionQueue = DispatchQueue(label: "sessionQueue", qos: .userInitiated)
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var lastProcessedText: String = ""
    private var hotkeyMonitor: Any?
    private var clipboardTimer: Timer?
    private var lastClipboardContent: String = ""


    override init() {
        super.init()
        speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        speechRecognizer?.delegate = self
        self.setupHotkey()
        socketService.$isConnected
            .receive(on: DispatchQueue.main)
            .assign(to: \.isConnected, on: self)
            .store(in: &cancellables)
    }
    
    deinit {
        if let monitor = hotkeyMonitor {
            NSEvent.removeMonitor(monitor)
        }
    }

    // MARK: - Transcription Control
    func startTranscription() {
        guard !isTranscribing else { return }
        
        // Reset state for a new session
        DispatchQueue.main.async {
            self.transcriptSegments.removeAll()
            self.currentSegment = nil
            self.lastProcessedText = ""
            self.currentSpeakerID = 1
            self.transcription = "Listening..."
            self.isTranscribing = true
        }

        socketService.connect()
        startClipboardMonitoring()

        sessionQueue.async { [weak self] in
            guard let self = self else { return }

            self.captureSession = AVCaptureSession()
            guard let captureSession = self.captureSession, let deviceId = self.selectedDeviceID,
                  let audioDevice = AVCaptureDevice(uniqueID: deviceId),
                  let audioInput = try? AVCaptureDeviceInput(device: audioDevice) else {
                DispatchQueue.main.async { self.transcription = "Error: Could not find audio device." }
                return
            }

            if captureSession.canAddInput(audioInput) { captureSession.addInput(audioInput) }
            if captureSession.canAddOutput(self.audioOutput) {
                self.audioOutput.setSampleBufferDelegate(self, queue: self.sessionQueue)
                captureSession.addOutput(self.audioOutput)
            }
            
            // Setup Speech Recognition Request
            self.setupSpeechRecognition()
            
            captureSession.startRunning()
        }
    }

    func stopTranscription() {
        guard isTranscribing else { return }

        sessionQueue.async { [weak self] in
            guard let self = self else { return }

            self.captureSession?.stopRunning()
            if self.audioOutput.sampleBufferDelegate != nil {
                self.audioOutput.setSampleBufferDelegate(nil, queue: nil)
            }
            self.captureSession = nil
            self.recognitionRequest?.endAudio()
            self.recognitionTask?.cancel()
            self.recognitionRequest = nil
            self.recognitionTask = nil
            self.silenceTimer?.invalidate()
            self.silenceTimer = nil
            
            DispatchQueue.main.async {
                self.isTranscribing = false
                self.audioLevel = 0.0
                if self.transcriptSegments.isEmpty {
                    self.transcription = "Press Start to begin."
                }
                self.socketService.disconnect()
            }
        }
    }
    
    // MARK: - Audio Processing and Diarization Logic
    
    // --- HEAVILY MODIFIED FUNCTION ---
    // This function now performs channel analysis to determine the active speaker.
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pcmBuffer = self.toPCMBuffer(sampleBuffer: sampleBuffer) else { return }

        // 1. Analyze the energy of each channel independently.
        let (leftRMS, rightRMS) = self.calculateRMSPerChannel(buffer: pcmBuffer)
        let totalRMS = leftRMS + rightRMS
        
        // 2. Determine the dominant speaker based on channel energy.
        var dominantSpeaker: Int? = nil
        if leftRMS > rightRMS + self.speakerChangeThreshold {
            dominantSpeaker = 1 // Speaker 1 (Interviewer) is dominant
        } else if rightRMS > leftRMS + self.speakerChangeThreshold {
            dominantSpeaker = 2 // Speaker 2 (Coder) is dominant
        }
        
        DispatchQueue.main.async {
            // Update the UI audio meter.
            self.audioLevel = self.scaledPower(power: 20 * log10(totalRMS))

            guard self.isTranscribing else { return }

            // 3. Handle speaker changes.
            if let dominantSpeaker = dominantSpeaker, dominantSpeaker != self.currentSpeakerID {
                // If there's an active speaker and it's different from the current one,
                // finalize the old segment and prepare for a new one.
                self.finalizeSegmentAndPrepareForNext()
                self.currentSpeakerID = dominantSpeaker
            }
            
            // 4. Handle silence detection to finalize segments after a pause.
            if totalRMS < self.silenceThreshold {
                if self.silenceTimer == nil && self.currentSegment != nil {
                    self.silenceTimer = Timer.scheduledTimer(
                        withTimeInterval: self.significantPauseDuration,
                        repeats: false
                    ) { [weak self] _ in
                        print("Silence timer fired. Finalizing segment.")
                        self?.finalizeSegmentAndPrepareForNext()
                    }
                }
            } else {
                // If sound is detected, cancel any pending silence timer.
                self.silenceTimer?.invalidate()
                self.silenceTimer = nil
            }
        }
        
        // 5. Downmix the audio to mono and send it to the speech recognizer.
        // The recognizer gets the combined audio, but we've already tagged who is speaking.
        if let monoBuffer = self.downmix(buffer: pcmBuffer) {
            self.recognitionRequest?.append(monoBuffer)
        }
    }
    
    private func restartTranscription() {
        sessionQueue.async { [weak self] in
            guard let self = self, self.isTranscribing else { return }

            self.recognitionTask?.cancel()
            self.recognitionRequest?.endAudio()
            self.recognitionTask = nil
            self.recognitionRequest = nil

            self.setupSpeechRecognition()
        }
    }
    
    // MARK: - Speech Recognition Handling
    private func setupSpeechRecognition() {
        
        // Vocabulary to improve accuracy for technical terms
        let programmingVocabulary = [
            // --- Kotlin Keywords & Concepts ---
            "fun", "val", "var", "when", "data class", "sealed class", "class", "object",
            "companion object", "lateinit", "by lazy", "inline", "reified", "lambda",
            "extension function", "Kotlin", "Unit", "null", "nullable", "non-null",

            // --- Kotlin Scope & Higher-Order Functions ---
            "let", "run", "with", "apply", "also", "takeIf", "takeUnless",

            // --- Kotlin Collection Functions ---
            "map", "filter", "forEach", "flatMap", "first", "find", "reduce", "fold",
            "groupBy", "associateBy", "zip", "partition",

            // --- Coroutines & Flow ---
            "coroutine", "suspend", "CoroutineScope", "viewModelScope", "lifecycleScope",
            "launch", "async", "await", "withContext", "supervisorScope", "coroutineScope",
            "Job", "Deferred", "Dispatchers.Main", "Dispatchers.IO", "Dispatchers.Default",
            "Flow", "StateFlow", "SharedFlow", "collect", "emit", "flowOn", "catch",
            "onCompletion", "combine", "flatMapLatest", "flatMapMerge", "channelFlow",

            // --- MVVM and Android Architecture ---
            "MVVM", "Model", "View", "ViewModel", "LiveData", "MutableLiveData",
            "repository", "ViewModelFactory", "Jetpack", "Android", "Activity", "Fragment",
            "Composable", "repeatOnLifecycle", "LifecycleObserver",

            // --- Android Jetpack - Hilt (Dependency Injection) ---
            "Hilt", "Dagger", "@Inject", "@Provides", "@Module", "@InstallIn",
            "SingletonComponent", "ViewModelComponent", "@AndroidEntryPoint",

            // --- Android Jetpack - Room (Database) ---
            "Room", "Database", "Entity", "Dao", "@Query", "@Insert", "@Update", "@Delete",

            // --- Android Jetpack - Navigation ---
            "Navigation", "NavController", "NavHostFragment", "NavGraph", "navigate",

            // --- Algorithm & CS Topics ---
            "Ransom Note", "Leetcode", "HashMap", "frequency map", "character", "magazine",
            "Phone Pad", "backtracking", "recursion", "letter combinations", "digits",
            "Big O", "O of 1", "O of n", "O of log n", "O of n log n", "O of n squared",
            "time complexity", "space complexity", "constant time", "linear time", "logarithmic",

            // --- Class comparison terms ---
            "equals", "hashCode", "toString", "copy", "componentN", "inheritance",
            "restricted hierarchy", "exhaustive"
        ]
        
        recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        guard let recognitionRequest = recognitionRequest else { fatalError("Unable to create request") }
        recognitionRequest.shouldReportPartialResults = true
        recognitionRequest.addsPunctuation = true
        recognitionRequest.contextualStrings = programmingVocabulary

        recognitionTask = speechRecognizer?.recognitionTask(with: recognitionRequest) { [weak self] result, error in
            guard let self = self else { return }
            
            if let result = result {
                self.updateLiveTranscript(with: result.bestTranscription.formattedString)
            }

            let isTaskEnded = (result?.isFinal ?? false) || (error != nil)
            
            if isTaskEnded {
                if let nsError = error as NSError? {
                    
                    print("Recognition task cancelled intentionally for restart. " + error!.localizedDescription)
                    return
                }
                
                self.recognitionRequest?.endAudio()
                self.recognitionTask = nil
                self.recognitionRequest = nil
                
                self.sessionQueue.async {
                    if self.isTranscribing {
                        print("Recognition task ended or errored. Starting a new one to continue.")
                        self.setupSpeechRecognition()
                    }
                }
            }
        }
    }

    // MARK: - Transcript Assembly
    private func updateLiveTranscript(with newFullText: String) {
        // Sanitize the incoming text
        let trimmedText = newFullText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedText.isEmpty else { return }

        DispatchQueue.main.async {
            let speakerLabel = self.speakerLabels[self.currentSpeakerID, default: "Speaker"]

            if self.currentSegment == nil {
                let newSegment = TranscriptSegment(timestamp: Date(), speakerLabel: speakerLabel, text: trimmedText)
                self.transcriptSegments.append(newSegment)
                self.currentSegment = newSegment // Keep a reference to the segment we are actively updating
            } else {
                if let index = self.transcriptSegments.firstIndex(where: { $0.id == self.currentSegment!.id }) {
                    // Ensure the speaker label is updated if it changed.
                    self.transcriptSegments[index].speakerLabel = speakerLabel
                    self.transcriptSegments[index].text = trimmedText
                }
            }
            
            // Send partial updates via socket if needed
            self.socketService.sendTranscript(text: self.formattedFullTranscript())
        }
    }
    
    // --- MODIFIED FUNCTION ---
    // This function no longer automatically flip-flops the speaker.
    // The speaker is now determined by the channel analysis.
    private func finalizeSegmentAndPrepareForNext() {
        DispatchQueue.main.async {
            guard self.currentSegment != nil else { return }
            
            self.previousSegment = self.currentSegment
            self.currentSegment = nil
            
            // We no longer switch the speaker ID here. It's set by the dominant channel analysis.
            
            self.silenceTimer?.invalidate()
            self.silenceTimer = nil
            
            self.restartTranscription()
        }
    }
    
    private func finalizeSegmentAndPrepareForNextWithoutSpeakerSwitchover() {
        DispatchQueue.main.async {
            guard self.currentSegment != nil else { return }
            
            self.previousSegment = self.currentSegment
            self.currentSegment = nil
            
            self.silenceTimer?.invalidate()
            self.silenceTimer = nil
            
            self.restartTranscription()
        }
    }
    
    func formattedFullTranscript() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        
        return transcriptSegments.reversed().map { segment in
            "[\(formatter.string(from: segment.timestamp))] (\(segment.speakerLabel)): \(segment.text)"
        }.joined(separator: "\n")
    }

    // MARK: - Hotkey Logic
    private func setupHotkey() {
        // Shared modifier flags
        let modifierFlags: NSEvent.ModifierFlags = [.command, .option, .shift]

        // Hotkey #1: Command + Option + Shift + ,
        // The key code for ',' is 43
        let hotkey1KeyCode: UInt16 = 43

        NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self, event.keyCode == hotkey1KeyCode, event.modifierFlags.contains(modifierFlags) else { return }

            let lastSegmentText = self.transcriptSegments.last?.text ?? ""
            guard !lastSegmentText.isEmpty else {
                print("Hotkey #1 pressed, but no finalized transcriptions available.")
                return
            }
            
            let sentences = lastSegmentText.components(separatedBy: CharacterSet(charactersIn: ".?!"))
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }

            let lastSegmentSentence = sentences.last ?? ""

            var lastTwoSegmentSentences = ""
            if sentences.count >= 2 {
                let secondToLast = sentences[sentences.count - 2]
                lastTwoSegmentSentences = "\(secondToLast). \(lastSegmentSentence)."
            } else {
                lastTwoSegmentSentences = lastSegmentSentence
            }

            print("Hotkey #1 activated. Sending data to AI with last sentence.")
            self.socketService.sendAICommandsLastSentence(
                sentenceV1: lastSegmentSentence,
                sentenceV2: lastTwoSegmentSentences
            )
        }

        // Hotkey #2: Command + Option + Shift + .
        // The key code for '.' is 47
        let hotkey2KeyCode: UInt16 = 47

        NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self, event.keyCode == hotkey2KeyCode, event.modifierFlags.contains(modifierFlags) else { return }

            let lastSegmentText = self.transcriptSegments.last?.text ?? ""
            guard !lastSegmentText.isEmpty else {
                print("Hotkey #2 pressed, but no finalized transcriptions available.")
                return
            }

            let sentences = lastSegmentText.components(separatedBy: CharacterSet(charactersIn: ".?!"))
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }

            let lastSegmentSentence = sentences.last ?? ""

            print("Hotkey #2 activated. Sending data to AI with last segment.")
            self.socketService.sendAICommandsLastSegment(
                sentence: lastSegmentSentence,
                segment: lastSegmentText
            )
        }

        // Hotkey #3: Command + Option + Shift + /
        // The key code for '/' is 44
        let hotkey3KeyCode: UInt16 = 44

        NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self, event.keyCode == hotkey3KeyCode, event.modifierFlags.contains(modifierFlags) else { return }

            let lastSegmentText = self.transcriptSegments.last?.text ?? ""
            
            guard !lastSegmentText.isEmpty else {
                print("Hotkey #3 pressed, but no finalized transcriptions available.")
                return
            }

            let sentences = lastSegmentText.components(separatedBy: CharacterSet(charactersIn: ".?!"))
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }

            let lastSegmentSentence = sentences.last ?? ""

            print("Hotkey #3 activated. Sending data to AI with context.")
            self.socketService.sendAICommandsLastSegmentWithContext(
                sentence: self.lastClipboardContent + "\n" + lastSegmentSentence,
                segment: self.lastClipboardContent + "\n" + lastSegmentText
            )
        }
        
        // Hotkey #4: Command + Option + Shift + L
        let hotkey4KeyCode: UInt16 = 37 // Correct keycode for 'L'

        NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self, event.keyCode == hotkey4KeyCode, event.modifierFlags.contains(modifierFlags) else { return }

            print("Hotkey #4 activated. Finalizing segment.")
            self.finalizeSegmentAndPrepareForNext()
        }
        
        // Hotkey #5: Command + Option + Shift + K
        let hotkey5KeyCode: UInt16 = 40 // Correct keycode for 'K'

        NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self, event.keyCode == hotkey5KeyCode, event.modifierFlags.contains(modifierFlags) else { return }
            
            print("Hotkey #5 (K) activated. Finalizing segment without speaker switchover.")
            self.finalizeSegmentAndPrepareForNextWithoutSpeakerSwitchover()
        }
    }
    
    // MARK: - Utility & Delegate Methods
    
    /// Converts a multi-channel buffer into a single-channel (mono) buffer by averaging the channels.
    private func downmix(buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard buffer.format.channelCount > 1 else { return buffer }
        guard let monoFormat = AVAudioFormat(commonFormat: buffer.format.commonFormat, sampleRate: buffer.format.sampleRate, channels: 1, interleaved: buffer.format.isInterleaved) else { return nil }
        guard let monoBuffer = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: buffer.frameLength) else { return nil }
        monoBuffer.frameLength = buffer.frameLength

        guard let inputChannelData = buffer.floatChannelData, let outputChannelData = monoBuffer.floatChannelData else { return nil }
        let channelCount = Int(buffer.format.channelCount)
        let frameLength = Int(buffer.frameLength)

        for frame in 0..<frameLength {
            var sum: Float = 0.0
            for channel in 0..<channelCount { sum += inputChannelData[channel][frame] }
            outputChannelData[0][frame] = sum / Float(channelCount)
        }
        return monoBuffer
    }
    
    // --- NEW FUNCTION ---
    /// Calculates the Root Mean Square (RMS) for each channel in a stereo buffer.
    /// Assumes channel 0 is Left (Speaker 1) and channel 1 is Right (Speaker 2).
    private func calculateRMSPerChannel(buffer: AVAudioPCMBuffer) -> (left: Float, right: Float) {
        // We need at least 2 channels to perform this analysis.
        guard buffer.format.channelCount >= 2, let channelData = buffer.floatChannelData else {
            return (0.0, 0.0)
        }
        
        let frameLength = Int(buffer.frameLength)
        var leftSumOfSquares: Float = 0.0
        var rightSumOfSquares: Float = 0.0
        
        let leftChannelData = channelData[0]
        let rightChannelData = channelData[1]
        
        for frame in 0..<frameLength {
            let leftSample = leftChannelData[frame]
            let rightSample = rightChannelData[frame]
            leftSumOfSquares += leftSample * leftSample
            rightSumOfSquares += rightSample * rightSample
        }
        
        let leftMean = leftSumOfSquares / Float(frameLength)
        let rightMean = rightSumOfSquares / Float(frameLength)
        
        return (sqrt(leftMean), sqrt(rightMean))
    }
    
    private func toPCMBuffer(sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard let format = CMSampleBufferGetFormatDescription(sampleBuffer),
              let pcmBuffer = AVAudioPCMBuffer(pcmFormat: AVAudioFormat(cmAudioFormatDescription: format), frameCapacity: AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))) else {
            return nil
        }
        pcmBuffer.frameLength = pcmBuffer.frameCapacity
        try? CMSampleBufferCopyPCMDataIntoAudioBufferList(sampleBuffer, at: 0, frameCount: Int32(pcmBuffer.frameLength), into: pcmBuffer.mutableAudioBufferList)
        return pcmBuffer
    }
    
    private func scaledPower(power: Float) -> Float {
        guard power.isFinite, power < 0 else { return power >= 0 ? 1.0 : 0.0 }
        let minDb: Float = -80.0
        if power < minDb { return 0.0 }
        return powf((powf(10.0, 0.05 * power) - powf(10.0, 0.05 * minDb)) * (1.0 / (1.0 - powf(10.0, 0.05 * minDb))), 1.0 / 2.0)
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

    func speechRecognizer(_ speechRecognizer: SFSpeechRecognizer, availabilityDidChange available: Bool) {
        if !available {
            DispatchQueue.main.async {
                self.transcription = "Speech recognizer not available."
                self.stopTranscription()
            }
        }
    }
}
