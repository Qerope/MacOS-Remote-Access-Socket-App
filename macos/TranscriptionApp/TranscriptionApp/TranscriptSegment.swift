//
//  TranscriptSegment.swift
//  TranscriptionApp
//
//  Created by VTD on 8/16/25.
//


// TranscriptSegment.swift

import Foundation

// Data structure for a single piece of transcribed text with its metadata.
struct TranscriptSegment: Identifiable, Hashable {
    let id = UUID()
    let timestamp: Date
    var speakerLabel: String
    var text: String
}