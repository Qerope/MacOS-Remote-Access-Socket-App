// SocketService.swift

import Foundation
import SocketIO
import Combine

class SocketService: ObservableObject {
    @Published var isConnected = false

    private var manager: SocketManager!
    private var socket: SocketIOClient!

    init() {
        //manager = SocketManager(socketURL: URL(string: "http://localhost:3000")!, config: [.log(false), .compress])
        manager = SocketManager(socketURL: URL(string: "http://204.216.106.35:3000")!, config: [.log(false), .compress])
        socket = manager.defaultSocket

        socket.on(clientEvent: .connect) { [weak self] _, _ in
            print("Socket: Connected")
            self?.socket.emit("identify", "macos")
            DispatchQueue.main.async {
                self?.isConnected = true
            }
        }

        socket.on(clientEvent: .disconnect) { [weak self] _, _ in
            print("Socket: Disconnected")
            DispatchQueue.main.async {
                self?.isConnected = false
            }
        }
        
        socket.on(clientEvent: .error) { [weak self] data, _ in
            print("Socket Error: \(data)")
            DispatchQueue.main.async {
                self?.isConnected = false
            }
        }
    }

    func connect() {
        if socket.status != .connected && socket.status != .connecting {
            socket.connect()
        }
    }

    func disconnect() {
        socket.disconnect()
    }
    
    func sendAudio(data: Data) {
        guard isConnected else { return }
        // socket.emit("audioData", data)
    }
    
    func sendTranscript(text: String) {
        guard isConnected else { return }
        socket.emit("liveClipboardUpdate", text)
    }
    
    func sendClipboard(content: String) {
        guard isConnected else { return }
        socket.emit("clipboardData", content)
    }
    
    func sendAICommandsLastSentence(sentenceV1: String, sentenceV2: String) {
        guard isConnected else { return }
        let data: [String: [String]] = ["commands": [sentenceV1, sentenceV2]]
        socket.emit("runAiCommand", data)
    }
    
    func sendAICommandsLastSegment(sentence: String, segment: String) {
        guard isConnected else { return }
        let data: [String: [String]] = ["commands": [sentence, segment]]
        socket.emit("runAiCommand", data)
    }
    
    func sendAICommandsLastSegmentWithContext(sentence: String, segment: String) {
        guard isConnected else { return }
        let data: [String: [String]] = ["commands": [sentence, segment]]
        socket.emit("runAiCommand", data)
    }
}
