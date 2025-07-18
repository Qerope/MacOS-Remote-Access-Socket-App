const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const IMAGE_DIRECTORY = "./data"; // Directory for exam images

// --- Routes for Web App ---
app.get('/', (req, res) => res.send(MAIN_UI_HTML));
app.get('/stream-view', (req, res) => res.send(STREAM_VIEW_HTML));
app.get('/html-view', (req, res) => res.send(HTML_VIEW_HTML));

// --- State Management ---
let lastClipboardContent = "Welcome to the shared clipboard!";
let lastEmoji = "⌛";
let lastWord = "Ready";
let lastQuality = 1;
let lastFrameRate = 8;
let lastHtmlSource = ``; // Set to empty to allow placeholder to show
let macUserSocketId = null;
let messageQueue = [];

/**
 * Sends a message to the macOS client if connected, otherwise queues it.
 * @param {string} event The name of the event to emit.
 * @param {*} data The data to send with the event.
 */
function sendToMac(event, data) {
    if (event != "wordToMac" || (macUserSocketId && messageQueue.length == 0)) {
        io.to(macUserSocketId).emit(event, data);
    } else {
        console.log(`macOS client disconnected. Queuing message: ${event}`);
        messageQueue.push({ event, data });
        io.emit('statusUpdate', { type: 'queue', status: 'queued', count: messageQueue.length });
    }
}

// --- Gemini AI Exam Processor ---
const systemInstruction = `
**Objective:** To correctly answer a UI/UX course exam.
- Some questions might have multiple choices.

**my Role:** You are an expert assistant.

**Workflow:**
1.  **I Provide Questions & File List:** I will start by giving you a batch of exam questions AND a complete list of available PNG image files.
2.  **You Request Files:** Your first response is CRITICAL. Analyze my questions and the list of available files. You MUST respond ONLY with a single JSON object. This object will contain one key, "requested_files", which is an array of the exact string filenames you need to see. For example: \`{"requested_files": ["CourseVideo-Qualitative.png", "CourseVideo-CommunicationVisuelle.png"]}\`
3.  **I Provide Files:** My code will automatically read your JSON response and upload the specific files you requested.
4.  **You Provide Answers:** Once you have the images, provide the final answers in the specified JSON format, and do not add explanations unless asked.
5.  **Accuracy Clause:** Use the documents and your knowledge to be 100% correct. If ambiguous, state that you have a doubt.
6.  **Final Response Format:**
{
  "questions": [
    { "questionNumber": 11, "answers": ["A"] },
    { "questionNumber": 12, "answers": ["C", "D"] }
  ]
}
`;

function fileToGenerativePart(filePath, mimeType) {
    try {
        return {
            inlineData: { data: Buffer.from(fs.readFileSync(filePath)).toString("base64"), mimeType },
        };
    } catch (error) {
        console.error(`Error reading file ${filePath}:`, error);
        return null;
    }
}

async function processExamWithGemini(socket, examQuestions, apiKey, modelName) {
    const emitStatus = (message) => {
        console.log("[geminiStatus] " + message)
        socket.emit('geminiStatus', { message });
    };
    const emitResult = (data) => {
        console.log("[geminiResult] " + data)
    };

    try {
        emitStatus(`🔎 Reading files from "${IMAGE_DIRECTORY}"...`);
        let availableImages = [];
        if (fs.existsSync(IMAGE_DIRECTORY)) {
            availableImages = fs.readdirSync(IMAGE_DIRECTORY).filter(file => path.extname(file).toLowerCase() === '.png');
        }
        emitStatus(`✅ Found ${availableImages.length} image(s).`);

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
        const chat = model.startChat();

        const initialPrompt = `${examQuestions}\n\n--- AVAILABLE FILES ---\n${availableImages.join("\n")}`;

        emitStatus("➡️ Sending request to Gemini...");
        const result1 = await chat.sendMessage(initialPrompt);
        let geminiFileRequestText = result1.response.text().replace(/```json\n?/g, "").replace(/```/g, "");
        
        emitStatus("📝 Gemini requested files...");
        let requestedFiles = JSON.parse(geminiFileRequestText).requested_files || [];
        
        if (!Array.isArray(requestedFiles)) throw new Error("Invalid file request from AI.");

        let imageParts = [];
        if (requestedFiles.length > 0) {
            imageParts = requestedFiles
                .map(fileName => {
                    const fullPath = path.join(IMAGE_DIRECTORY, fileName);
                    if (fs.existsSync(fullPath)) return fileToGenerativePart(fullPath, "image/png");
                    emitStatus(`⚠️ File not found: ${fileName}`);
                    return null;
                })
                .filter(part => part !== null);
            emitStatus(`🖼️ Loading ${imageParts} image(s)...`);
        }

        const followUpMessage = imageParts.length > 0
            ? "Here are the files you requested. Please provide the final JSON answer."
            : "You requested no files. Please answer based on the initial prompt.";

        emitStatus("➡️ Sending follow-up...");
        const result2 = await chat.sendMessage([followUpMessage, ...imageParts]);
        let finalJsonResponse = result2.response.text().replace(/```json\n?/g, "").replace(/```/g, "");
        
        emitStatus("🎉 Complete! Populating Batch Ops.");
        emitResult({ success: true, data: finalJsonResponse });

    } catch (e) {
        console.error("Gemini processing error:", e);
        emitResult({ success: false, error: e.message });
    }
}


// --- WebSocket Connection Handling ---
io.on('connection', (socket) => {
    socket.on('startGeminiExam', async (data) => {
        const { questions, modelName } = data;
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) {
            socket.emit('geminiResult', { success: false, error: 'GEMINI_API_KEY not set on server .env file.' });
            return;
        }
        if (!questions) {
            socket.emit('geminiResult', { success: false, error: 'Exam questions cannot be empty.' });
            return;
        }

        await processExamWithGemini(socket, questions, apiKey, modelName);
    });

    socket.on('identify', (type) => {
        if (type === 'macos') {
            macUserSocketId = socket.id;
            console.log('macOS app identified:', macUserSocketId);
            io.emit('statusUpdate', { type: 'mac', status: 'connected' });
            socket.emit('wordToMac', lastWord);
            socket.emit('qualityChange', lastQuality);
            socket.emit('frameRateChange', lastFrameRate);
            if (messageQueue.length > 0) {
                messageQueue.forEach((msg, index) => {
                    setTimeout(() => {
                        io.to(macUserSocketId).emit(msg.event, msg.data);
                        io.emit('statusUpdate', { type: 'queue', status: 'queued', count: messageQueue.length - index - 1 });
                        if (index === messageQueue.length - 1) {
                            messageQueue = [];
                            io.emit('statusUpdate', { type: 'queue', status: 'cleared' });
                        }
                    }, index * 2500);
                });
            }
        } else {
            console.log('Web client connected:', socket.id);
            socket.emit('clipboardData', lastClipboardContent);
            socket.emit('emojiToWeb', lastEmoji);
            socket.emit('renderHTML', lastHtmlSource);
            socket.emit('statusUpdate', { type: 'mac', status: macUserSocketId ? 'connected' : 'disconnected' });
            if (messageQueue.length > 0) {
                messageQueue = [];
                socket.emit('statusUpdate', { type: 'queue', status: 'queued', count: messageQueue.length });
            }
        }
    });

    socket.on('screenData', (data) => io.emit('screenData', data));
    socket.on('webSourceCode', (source) => { lastHtmlSource = source; io.emit('renderHTML', source); });
    socket.on('clipboardData', (content) => { lastClipboardContent = content; socket.broadcast.emit('clipboardData', content); });
    socket.on('wordToMac', (word) => { console.log(`Received word from web: ${word}`); lastWord = word; sendToMac('wordToMac', word); });
    socket.on('qualityChange', (quality) => { lastQuality = parseInt(quality, 10); sendToMac('qualityChange', lastQuality); });
    socket.on('frameRateChange', (frameRate) => { lastFrameRate = parseInt(frameRate, 10); sendToMac('frameRateChange', lastFrameRate); });
    socket.on('emojiToWeb', (emoji) => { lastEmoji = emoji; io.emit('emojiToWeb', emoji); });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        if (socket.id === macUserSocketId) {
            macUserSocketId = null;
            console.log('macOS app disconnected.');
            io.emit('statusUpdate', { type: 'mac', status: 'disconnected' });
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    if (!fs.existsSync(IMAGE_DIRECTORY)) {
        console.log(`Creating image directory at: ${IMAGE_DIRECTORY}`);
        fs.mkdirSync(IMAGE_DIRECTORY, { recursive: true });
    }
});

// --- Styled SVG Placeholders ---
const SVG_PLACEHOLDER_STREAM = `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><defs><style>.txt{font-family:"Fira Code",monospace;font-size:48px;fill:%23444;text-anchor:middle;}.bg{fill:%23000;}</style></defs><rect class="bg" width="100%" height="100%"/><g opacity="0.5"><path fill="%23111" d="M0 0h1920v2L0 3zM0 1078h1920v2L0 1077z"/><rect fill="%231a1a1a" x="880" y="460" width="160" height="160" opacity="0.2"/></g><text class="txt" x="50%" y="50%" dominant-baseline="middle">AWAITING UPLINK STREAM</text></svg>`).toString('base64')}`;
const SVG_PLACEHOLDER_STREAM_DISCONNECTED = `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><defs><style>.txt{font-family:"Fira Code",monospace;font-size:48px;fill:%23800;text-anchor:middle;}.bg{fill:%23000;}</style></defs><rect class="bg" width="100%" height="100%"/><g opacity="0.5"><path fill="%23111" d="M0 0h1920v2L0 3zM0 1078h1920v2L0 1077z"/><path stroke="%23800" stroke-width="4" d="M880 460l160 160m0-160L880 620"/></g><text class="txt" x="50%" y="50%" dominant-baseline="middle">macOS CLIENT DISCONNECTED</text></svg>`).toString('base64')}`;
const SVG_PLACEHOLDER_HTML = `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><defs><style>.txt{font-family:"Fira Code",monospace;font-size:48px;fill:%23444;text-anchor:middle;}.bg{fill:%23111;}</style></defs><rect class="bg" width="100%" height="100%"/><g opacity="0.5"><path fill="%23222" d="M860 520h200v40H860z m0 60h200v40H860z"/></g><text class="txt" x="50%" y="50%" dominant-baseline="middle">&lt;NO_HTML_RENDER /&gt;</text></svg>`).toString('base64')}`;

// --- Main UI HTML (Fully Functional & Redesigned) ---
const MAIN_UI_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>macOS Bridge</title>
    <script src="/socket.io/socket.io.js"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --color-bg: #0d0d0d; --color-primary: #ff6600; --color-secondary: #00ffff;
            --color-text: #cccccc; --color-text-dark: #888888; --color-border: #444444;
            --color-panel-bg: #1a1a1a; --font-main: 'Fira Code', monospace;
        }
        *, *::before, *::after { box-sizing: border-box; }
        body { 
            background-color: var(--color-bg); color: var(--color-text); font-family: var(--font-main);
            margin: 0; padding: 1rem; font-size: 14px;
            background-image: linear-gradient(var(--color-border) 1px, transparent 1px), linear-gradient(to right, var(--color-border) 1px, var(--color-bg) 1px);
            background-size: 20px 20px;
        }
        main { display: grid; grid-template-columns: 2fr 1fr; gap: 1rem; max-width: 1600px; margin: auto; }
        .view-panel, .controls-panel { display: flex; flex-direction: column; gap: 1rem; }
        header { border: 1px solid var(--color-border); background: var(--color-panel-bg); padding: 0.5rem 1rem; display: flex; justify-content: space-between; align-items: center; grid-column: 1 / -1; margin-bottom: 1rem; }
        h1 { font-size: 1.5rem; color: var(--color-primary); text-shadow: 0 0 5px var(--color-primary); margin: 0; }
        .status-indicator { display: flex; align-items: center; gap: 0.75rem; }
        #macStatus { font-weight: bold; transition: color 0.3s, text-shadow 0.3s; }
        #macStatus.connected { color: var(--color-secondary); text-shadow: 0 0 8px var(--color-secondary); }
        #macStatus.disconnected { color: #ff3333; text-shadow: 0 0 8px #ff3333; }
        #queueStatus { color: var(--color-primary); font-weight: bold; }
        .tabs-and-controls { display: flex; flex-direction: column; gap: 0.5rem; }
        #tabs { display: flex; gap: 0.5rem; border-bottom: 1px solid var(--color-border); }
        .tab-btn { background: none; border: 1px solid transparent; border-bottom: none; color: var(--color-text-dark); padding: 0.5rem 1rem; font-family: inherit; font-size: 1rem; cursor: pointer; transition: all 0.2s; }
        .tab-btn:hover { color: var(--color-primary); }
        .tab-btn.active { color: var(--color-primary); border-color: var(--color-border); background: var(--color-panel-bg); border-bottom: 1px solid var(--color-panel-bg); transform: translateY(1px); }
        .viewport-controls { display: flex; gap: 0.5rem; padding: 0.25rem 0; }
        .tab-content { display: none; } .tab-content.active { display: block; }
        .viewport { background-color: #000; border: 1px solid var(--color-border); min-height: 480px; display: flex; align-items: center; justify-content: center; overflow: hidden; }
        .viewport img, .viewport iframe { max-width: 100%; max-height: 100%; object-fit: contain; width: 100%; height: 650px; border: none; }
        fieldset { border: 1px solid var(--color-border); padding: 1rem; background: var(--color-panel-bg); margin: 0; display: flex; flex-direction: column; gap: 1rem; }
        legend { color: var(--color-secondary); font-weight: bold; padding: 0 0.5rem; text-transform: uppercase; }
        label { display: flex; justify-content: space-between; align-items: center; font-size: 0.9rem; color: var(--color-text-dark); }
        input[type="text"], input[type="number"], textarea, select {
            background-color: var(--color-bg); border: 1px solid var(--color-border); color: var(--color-text);
            padding: 0.5rem; font-family: inherit; font-size: 1rem;
        }
        input:focus, textarea:focus, select:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 10px var(--color-primary); }
        textarea { resize: vertical; min-height: 100px; }
        .btn { background-color: #333; border: 1px solid var(--color-border); color: var(--color-text); padding: 0.5rem 1rem; cursor: pointer; text-align: center; transition: all 0.2s; font-family: inherit; font-size: 0.9rem; flex-grow: 1; }
        .word-btn { height: 55px; }
        .btn:hover { border-color: var(--color-primary); color: var(--color-primary); }
        .btn.primary { background-color: var(--color-primary); border-color: var(--color-primary); color: var(--color-bg); font-weight: bold; }
        .btn.primary:hover { filter: brightness(1.2); }
        .btn:disabled { background: #222; color: #555; border-color: #333; cursor: not-allowed; }
        .btn-group { display: flex; gap: 0.5rem; }
        .comm-grid { display: grid; grid-template-columns: auto 1fr; gap: 0.75rem; align-items: flex-end; }
        .button-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; }
        .stream-config-row { display: flex; gap: 1rem; align-items: center; }
        .stream-config-row > div { flex: 1; }
        input[type="range"] { -webkit-appearance: none; width: 100%; height: 3px; background: var(--color-border); cursor: pointer; }
        input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 10px; height: 20px; background: var(--color-secondary); cursor: pointer; border: 1px solid var(--color-bg); }
        #screenFeedContainer.fullscreen { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background-color: #000; z-index: 100; padding: 1rem; border: none; }
        @media (max-width: 1024px) { main { grid-template-columns: 1fr; } }
    </style>
</head>
<body>
    <header>
        <h1>> macos_bridge</h1>
        <div class="status-indicator">
            <span id="macStatus" class="disconnected">[DISCONNECTED]</span>
            <span id="queueStatus" class="hidden"></span>
        </div>
    </header>
    <main>
        <div class="view-panel">
            <div class="tabs-and-controls">
                <div id="tabs">
                    <button class="tab-btn active" data-tab="stream">UPLINK_STREAM</button>
                    <button class="tab-btn" data-tab="html">HTML_RENDER</button>
                </div>
                <div class="viewport-controls">
                    <button id="toggleFullscreenBtn" class="btn">[ ] FULLSCREEN</button>
                    <button id="popOutStreamBtn" class="btn">[->] POP-OUT STREAM</button>
                    <button id="popOutHtmlBtn" class="btn">[->] POP-OUT RENDER</button>
                </div>
            </div>

            <div id="stream" class="tab-content active">
                <div id="screenFeedContainer" class="viewport">
                    <img id="liveScreenFeed" alt="Live Screen Feed">
                </div>
            </div>
            <div id="html" class="tab-content">
                <div class="viewport">
                    <iframe id="htmlRenderer" sandbox="allow-same-origin allow-scripts"></iframe>
                </div>
            </div>
        </div>

        <div class="controls-panel">
            <fieldset>
                <legend>STREAM_CONFIG</legend>
                <div class="stream-config-row">
                    <div>
                        <label for="qualitySlider"><span>QUALITY</span><span id="qualityValue">1</span></label>
                        <input id="qualitySlider" type="range" min="1" max="100" value="1">
                    </div>
                    <div>
                        <label for="frameRateSlider"><span>FRAME_RATE</span><span id="frameRateValue">16</span></label>
                        <input id="frameRateSlider" type="range" min="1" max="60" value="16">
                    </div>
                </div>
                <button id="autoQualityBtn" class="btn">TOGGLE AUTO QUALITY</button>
            </fieldset>

            <fieldset><legend>SHARED_CLIPBOARD</legend><textarea id="sharedClipboard"></textarea></fieldset>

            <fieldset>
                <legend>COMMS</legend>
                <div class="comm-grid">
                    <div>
                        <label for="numberInput" style="justify-content:flex-start; gap: 0.5rem;"><span>Remote</span></label>
                        <input type="text" disabled id="emojiFromMac" value="⌛" style="margin-bottom: 5px; width: 80px; text-align: center;">
                        <label for="numberInput" style="justify-content:flex-start; gap: 0.5rem;"><span>Question</span></label>
                        <input type="number" id="numberInput" value="1" min="1" style="width: 80px; text-align: center;">
                    </div>
                    <div class="button-grid">
                        <button class="btn word-btn" data-word="About">A</button><button class="btn word-btn" data-word="Back">B</button><button class="btn word-btn" data-word="Close">C</button>
                        <button class="btn word-btn" data-word="Duplicate">D</button><button class="btn word-btn" data-word="Extensions">E</button><button class="btn word-btn" data-word="Find">F</button>
                    </div>
                </div>
            </fieldset>
            
            <fieldset>
                <legend>GEMINI_EXAM_PROCESSOR</legend>
                <div>
                    <label for="modelSelect" style="justify-content:flex-start;">MODEL</label>
                    <select id="modelSelect" style="width: 100%;">
                        <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                        <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                        <option value="gemini-2.5-flash-lite-preview-06-17">Gemini 2.5 Flash Lite (Preview)</option>
                    </select>
                </div>
                <textarea id="examQuestionsInput" placeholder="Paste exam questions from clipboard here..."></textarea>
                <div class="btn-group">
                    <button id="startExamBtn" class="btn primary" style="flex:1;">GET ANSWERS</button>
                    <div id="examStatus" style="padding: 0.5rem; border: 1px solid var(--color-border); background: var(--color-bg); width: 180px; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Idle</div>
                </div>
            </fieldset>

            <fieldset>
                <legend>BATCH_OPS</legend>
                <textarea id="batchJsonInput" placeholder='Results from "GET ANSWERS" will appear here.'></textarea>
                <div class="btn-group">
                    <button id="startBatchBtn" class="btn primary" style="flex:1;">EXECUTE BATCH</button>
                    <div id="batchStatus" style="padding: 0.5rem; border: 1px solid var(--color-border); background: var(--color-bg); width: 150px; text-align:center;">Idle</div>
                </div>
            </fieldset>
        </div>
    </main>

    <script>
        const socket = io();

        // --- UI Elements ---
        const liveScreenFeed = document.getElementById('liveScreenFeed');
        const htmlRenderer = document.getElementById('htmlRenderer');
        const sharedClipboard = document.getElementById('sharedClipboard');
        const macStatus = document.getElementById('macStatus');
        const queueStatus = document.getElementById('queueStatus');
        const emojiFromMac = document.getElementById('emojiFromMac');
        
        // View Controls
        const tabs = document.getElementById('tabs');
        const tabContents = document.querySelectorAll('.tab-content');
        const screenFeedContainer = document.getElementById('screenFeedContainer');
        const toggleFullscreenBtn = document.getElementById('toggleFullscreenBtn');
        const popOutStreamBtn = document.getElementById('popOutStreamBtn');
        const popOutHtmlBtn = document.getElementById('popOutHtmlBtn');

        // Stream Config
        const qualitySlider = document.getElementById('qualitySlider');
        const qualityValue = document.getElementById('qualityValue');
        const frameRateSlider = document.getElementById('frameRateSlider');
        const frameRateValue = document.getElementById('frameRateValue');
        const autoQualityBtn = document.getElementById('autoQualityBtn');

        // Comms
        const numberInput = document.getElementById('numberInput');

        // Gemini Processor
        const modelSelect = document.getElementById('modelSelect');
        const examQuestionsInput = document.getElementById('examQuestionsInput');
        const startExamBtn = document.getElementById('startExamBtn');
        const examStatus = document.getElementById('examStatus');

        // Batch Ops
        const batchJsonInput = document.getElementById('batchJsonInput');
        const startBatchBtn = document.getElementById('startBatchBtn');
        const batchStatus = document.getElementById('batchStatus');

        // --- Initial State & Utilities ---
        liveScreenFeed.src = \`${SVG_PLACEHOLDER_STREAM}\`;
        htmlRenderer.src = \`${SVG_PLACEHOLDER_HTML}\`;
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const wordMap = {};
        document.querySelectorAll('.word-btn').forEach(btn => { wordMap[btn.textContent] = btn.dataset.word; });
        let isAutoMode = false;

        // --- Socket Listeners ---
        socket.on('connect', () => {
            socket.emit('identify', 'web');
            socket.emit('qualityChange', qualitySlider.value);
            socket.emit('frameRateChange', frameRateSlider.value);
        });
        socket.on('screenData', (data) => liveScreenFeed.src = 'data:image/jpeg;base64,' + data);
        socket.on('renderHTML', (source) => { htmlRenderer.srcdoc = source || ''; if (!source) htmlRenderer.src = \`${SVG_PLACEHOLDER_HTML}\`; });
        socket.on('clipboardData', (content) => { 
            if (document.activeElement !== sharedClipboard) sharedClipboard.value = content; 
            if (document.activeElement !== examQuestionsInput) examQuestionsInput.value = content;
        });
        socket.on('emojiToWeb', (emoji) => emojiFromMac.textContent = emoji);
        socket.on('statusUpdate', (data) => {
            if (data.type === 'mac') {
                const isConnected = data.status === 'connected';
                macStatus.textContent = isConnected ? '[CONNECTED]' : '[DISCONNECTED]';
                macStatus.className = isConnected ? 'connected' : 'disconnected';
                if (!isConnected) liveScreenFeed.src = \`${SVG_PLACEHOLDER_STREAM_DISCONNECTED}\`;
            } else if (data.type === 'queue') {
                queueStatus.textContent = (data.status === 'queued' && data.count > 0) ? \`(\${data.count} Queued)\` : '';
                queueStatus.classList.toggle('hidden', !(data.status === 'queued' && data.count > 0));
            }
        });
        
        socket.on('geminiStatus', (data) => {
            examStatus.textContent = data.message;
            examStatus.style.color = 'var(--color-text)';
        });
        socket.on('geminiResult', (result) => {
            startExamBtn.disabled = false;
            if (result.success) {
                examStatus.textContent = '✅ Success!';
                examStatus.style.color = '#00ff00';
                try {
                    const formattedJson = JSON.stringify(JSON.parse(result.data), null, 2);
                    sharedClipboard.value = formattedJson;
                    batchJsonInput.value = formattedJson;
                    socket.emit('clipboardData', formattedJson);
                } catch {
                    sharedClipboard.value = result.data;
                    batchJsonInput.value = result.data;
                }
            } else {
                examStatus.textContent = \`Error: \${result.error}\`;
                examStatus.style.color = '#ff3333';
            }
        });

        // --- UI Event Listeners ---
        // View Controls
        tabs.addEventListener('click', (e) => {
            if (e.target.matches('.tab-btn')) {
                tabs.querySelector('.active')?.classList.remove('active');
                e.target.classList.add('active');
                tabContents.forEach(c => c.classList.remove('active'));
                document.getElementById(e.target.dataset.tab).classList.add('active');
            }
        });
        toggleFullscreenBtn.addEventListener('click', () => {
            const activeViewport = document.querySelector('.tab-content.active .viewport');
            if(activeViewport) activeViewport.requestFullscreen().catch(err => alert(\`Error: \${err.message}\`));
        });
        popOutStreamBtn.addEventListener('click', () => window.open('/stream-view', '_blank', 'popup,width=1280,height=720'));
        popOutHtmlBtn.addEventListener('click', () => window.open('/html-view', '_blank', 'popup,width=1280,height=800'));

        // Stream Config
        const updateQuality = () => { qualityValue.textContent = qualitySlider.value; socket.emit('qualityChange', qualitySlider.value); };
        const updateFrameRate = () => { frameRateValue.textContent = frameRateSlider.value; socket.emit('frameRateChange', frameRateSlider.value); };
        qualitySlider.addEventListener('input', () => qualityValue.textContent = qualitySlider.value);
        qualitySlider.addEventListener('change', updateQuality);
        frameRateSlider.addEventListener('input', () => frameRateValue.textContent = frameRateSlider.value);
        frameRateSlider.addEventListener('change', updateFrameRate);
        autoQualityBtn.addEventListener('click', () => {
            isAutoMode = !isAutoMode;
            autoQualityBtn.style.borderColor = isAutoMode ? 'var(--color-secondary)' : 'var(--color-border)';
            qualitySlider.disabled = isAutoMode;
            frameRateSlider.disabled = isAutoMode;
        });
        
        // Comms
        sharedClipboard.addEventListener('input', () => socket.emit('clipboardData', sharedClipboard.value));
        document.querySelectorAll('.word-btn').forEach(button => {
            button.addEventListener('click', (e) => {
                const word = button.dataset.word;
                const numberVal = parseInt(numberInput.value, 10);
                if (isNaN(numberVal) || numberVal < 1) {
                    socket.emit('wordToMac', word);
                    return;
                }
                socket.emit('wordToMac', \`\${numberVal}% \${word}\`);
                numberInput.value = numberVal + 1;
            });
        });
        
        // Gemini Logic
        startExamBtn.addEventListener('click', () => {
            const questions = examQuestionsInput.value;
            if (!questions.trim()) {
                examStatus.textContent = 'Questions empty!';
                examStatus.style.color = '#ff3333';
                return;
            }
            startExamBtn.disabled = true;
            examStatus.textContent = 'Initiating...';
            examStatus.style.color = 'var(--color-primary)';
            socket.emit('startGeminiExam', { questions, modelName: modelSelect.value });
        });

        // Batch Ops Logic
        startBatchBtn.addEventListener('click', async () => {
            let data;
            batchStatus.textContent = 'Processing...';
            try {
                data = JSON.parse(batchJsonInput.value);
                if (!data.questions || !Array.isArray(data.questions)) throw new Error("JSON needs a 'questions' array.");
            } catch (error) {
                batchStatus.textContent = \`ERR: \${error.message}\`;
                batchStatus.style.color = '#ff3333';
                return;
            }
            startBatchBtn.disabled = true;
            const questions = data.questions;
            for (let i = 0; i < questions.length; i++) {
                const item = questions[i];
                batchStatus.textContent = \`Sending \${i + 1}/\${questions.length}\`;
                const { questionNumber, answers } = item;
                if (typeof questionNumber === 'undefined' || !answers || !Array.isArray(answers)) {
                    console.warn('Skipping invalid item in batch:', item);
                    continue;
                }
                const convertedAnswers = answers.map(ans => wordMap[ans.toUpperCase()] || ans).join(' | ');
                const message = \`\${questionNumber}% \${convertedAnswers}\`;
                socket.emit('wordToMac', message);
                if (i < questions.length - 1) {
                    batchStatus.textContent = \`Q\${questionNumber} - Wait (4s)\`;
                    await sleep(4000);
                }
            }
            batchStatus.textContent = 'Batch Complete';
            startBatchBtn.disabled = false;
        });
    </script>
</body>
</html>
`;

// --- Minimal HTML for Pop-Out Views ---
const STREAM_VIEW_HTML = `<!DOCTYPE html><html lang="en"><head><title>Live Stream</title><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body{margin:0;background-color:#0d0d0d;display:flex;align-items:center;justify-content:center;height:100vh;font-family:'Fira Code',monospace}img{max-width:100%;max-height:100%;object-fit:contain}</style></head><body><img id="liveScreenFeed" alt="Live Stream"><script src="/socket.io/socket.io.js"></script><script>const socket=io(),feed=document.getElementById("liveScreenFeed");feed.src=\`${SVG_PLACEHOLDER_STREAM}\`;socket.on("connect",()=>socket.emit("identify","web-stream-viewer"));socket.on("screenData",e=>feed.src="data:image/jpeg;base64,"+e);socket.on("statusUpdate",e=>{if(e.type==="mac"&&e.status==="disconnected")feed.src=\`${SVG_PLACEHOLDER_STREAM_DISCONNECTED}\`});</script></body></html>`;
const HTML_VIEW_HTML = `<!DOCTYPE html><html lang="en"><head><title>Live HTML Render</title><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body,html{margin:0;padding:0;width:100%;height:100%;background:#0d0d0d}iframe{border:0;width:100%;height:100%}</style></head><body><iframe id="htmlRenderer" sandbox="allow-same-origin allow-scripts"></iframe><script src="/socket.io/socket.io.js"></script><script>const socket=io(),iframe=document.getElementById("htmlRenderer");iframe.src=\`${SVG_PLACEHOLDER_HTML}\`;socket.on("connect",()=>socket.emit("identify","web-html-viewer"));socket.on("renderHTML",e=>{iframe.srcdoc=e||"";if(!e)iframe.src=\`${SVG_PLACEHOLDER_HTML}\`});</script></body></html>`;