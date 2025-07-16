const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// --- Routes for Web App ---
// Main UI
app.get('/', (req, res) => res.send(MAIN_UI_HTML));
// Pop-out view for the live stream
app.get('/stream-view', (req, res) => res.send(STREAM_VIEW_HTML));
// Pop-out view for the HTML render
app.get('/html-view', (req, res) => res.send(HTML_VIEW_HTML));

// --- State Management ---
let lastClipboardContent = "Welcome to the shared clipboard!";
let lastEmoji = "⌛";
let lastWord = "Ready";
let lastQuality = 1;
let lastFrameRate = 16;
let lastHtmlSource = `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-family:sans-serif;color:#555;">Waiting for HTML content...</div>`;
let macUserSocketId = null;

// --- NEW: Queue for offline messages ---
let messageQueue = [];

// --- NEW: Helper function to send or queue messages for the macOS client ---
/**
 * Sends a message to the macOS client if connected, otherwise queues it.
 * @param {string} event The name of the event to emit.
 * @param {*} data The data to send with the event.
 */
function sendToMac(event, data) {
    if (event != "wordToMac" || (macUserSocketId && messageQueue.length == 0) ) {
        io.to(macUserSocketId).emit(event, data);
    } else {
        console.log(`macOS client disconnected. Queuing message: ${event}`);
        messageQueue.push({ event, data });
        // Warn the user by updating the web UI with the queue status
        io.emit('statusUpdate', {
            type: 'queue',
            status: 'queued',
            count: messageQueue.length
        });
    }
}

// --- WebSocket Connection Handling ---
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('identify', (type) => {
        if (type === 'macos') {
            macUserSocketId = socket.id;
            console.log('macOS app identified:', macUserSocketId);
            io.emit('statusUpdate', { type: 'mac', status: 'connected' });

            // Send initial settings to the Mac app
            socket.emit('wordToMac', lastWord);
            socket.emit('qualityChange', lastQuality);
            socket.emit('frameRateChange', lastFrameRate);

            // --- NEW: Process any queued messages upon reconnection ---
            if (messageQueue.length > 0) {
                console.log(`Sending ${messageQueue.length} queued messages to ${macUserSocketId}`);

                messageQueue.forEach((msg, index) => {
                    setTimeout(() => {
                        io.to(macUserSocketId).emit(msg.event, msg.data);
                        console.log(`Sending ${messageQueue.length - index} queued messages to ${macUserSocketId}`);
                        io.emit('statusUpdate', {
                            type: 'queue',
                            status: 'queued',
                            count: messageQueue.length - index - 1
                        });

                        // After sending the last message, clear the queue and notify
                        if (index === messageQueue.length - 1) {
                            console.log(`Sending queued messages to ${macUserSocketId} completed`);
                            messageQueue = []; // Clear the queue
                            io.emit('statusUpdate', { type: 'queue', status: 'cleared' });
                        }
                    }, index * 2500); // 2.5 seconds per message
                });
            }

        } else { // Web client
            console.log('Web client connected:', socket.id);
            // Send initial state to the new web client
            socket.emit('clipboardData', lastClipboardContent);
            socket.emit('emojiToWeb', lastEmoji);
            socket.emit('renderHTML', lastHtmlSource);
            socket.emit('statusUpdate', { type: 'mac', status: macUserSocketId ? 'connected' : 'disconnected' });

            // --- NEW: Inform new web client about the current queue state ---
            if (messageQueue.length > 0) {
                messageQueue = [];
                socket.emit('statusUpdate', {
                    type: 'queue',
                    status: 'queued',
                    count: messageQueue.length
                });
            }
        }
    });

    socket.on('screenData', (data) => {
        io.emit('screenData', data);
    });

    socket.on('webSourceCode', (source) => {
        lastHtmlSource = source;
        io.emit('renderHTML', source);
    });

    socket.on('clipboardData', (content) => {
        lastClipboardContent = content;
        socket.broadcast.emit('clipboardData', content);
    });

    // --- MODIFIED: Use the sendToMac helper for all macOS-bound messages ---
    socket.on('wordToMac', (word) => {
        console.log(`Received word from web: ${word}`);
        lastWord = word;
        sendToMac('wordToMac', word);
    });

    socket.on('qualityChange', (quality) => {
        lastQuality = parseInt(quality, 10);
        sendToMac('qualityChange', lastQuality);
    });

    socket.on('frameRateChange', (frameRate) => {
        lastFrameRate = parseInt(frameRate, 10);
        sendToMac('frameRateChange', lastFrameRate);
    });

    socket.on('emojiToWeb', (emoji) => {
        lastEmoji = emoji;
        io.emit('emojiToWeb', emoji);
    });

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
});

// --- Main UI HTML (with updated client-side script) ---
const MAIN_UI_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>macOS Bridge - Control Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="/socket.io/socket.io.js"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background-color: #0f172a; color: #f1f5f9; }
        .tab-btn.active { background-color: #1e293b; border-bottom-color: #3b82f6; }
        .tab-content { display: none; }
        .tab-content.active { display: flex; }
        .control-panel { background-color: #1e293b; border: 1px solid #334155; }
        .status-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; transition: background-color 0.3s ease, box-shadow 0.3s ease; }
        .status-green { background-color: #22c55e; box-shadow: 0 0 6px #22c55e; }
        .status-red { background-color: #ef4444; box-shadow: 0 0 6px #ef4444; }
        #screenFeedContainer.fullscreen { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background-color: #000; display: flex; align-items: center; justify-content: center; z-index: 50; padding: 1rem; }
        input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 18px; height: 18px; background: #3b82f6; cursor: pointer; border-radius: 50%; margin-top: -6px; transition: background-color 0.2s ease; }
        input[type="range"]:disabled { opacity: 0.4; }
        input[type="range"]:disabled::-webkit-slider-thumb { background: #4b5563; cursor: not-allowed; }
        #autoQualityBtn.active { background-color: #2563eb; color: white; }
    </style>
</head>
<body class="p-4 lg:p-6">

    <main class="w-full max-w-8xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-6">

        <div class="lg:col-span-2 flex flex-col gap-6">
            <header class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div>
                    <h1 class="text-2xl font-bold text-slate-100">macOS Bridge Dashboard</h1>
                    <div class="flex items-center gap-2 mt-1">
                        <div id="macStatus" class="status-dot status-red"></div>
                        <p id="macStatusText" class="text-sm text-slate-400">Disconnected</p>
                        <p id="queueStatus" class="ml-3 text-sm text-amber-400 font-semibold hidden"></p>
                    </div>
                </div>
                <div id="tabs" class="flex-shrink-0 flex border-b border-slate-700">
                    <button class="tab-btn px-4 py-2 text-sm font-semibold text-slate-300 border-b-2 border-transparent hover:bg-slate-700/50 transition-colors" data-tab="stream">Live Stream</button>
                    <button class="tab-btn px-4 py-2 text-sm font-semibold text-slate-300 border-b-2 border-transparent hover:bg-slate-700/50 transition-colors" data-tab="html">HTML Render</button>
                </div>
            </header>

            <div id="stream" class="tab-content flex-col gap-4">
                <div id="screenFeedContainer" class="bg-black rounded-lg aspect-video flex items-center justify-center overflow-hidden">
                    <img id="liveScreenFeed" src="https://placehold.co/1920x1080/000000/334155?text=Waiting+for+macOS+Stream..." alt="Live Screen Feed" class="max-w-full max-h-full object-contain">
                </div>
            </div>

            <div id="html" class="tab-content h-[calc(100vh-12rem)] min-h-[480px]">
                <div class="bg-white rounded-lg flex-grow w-full h-full">
                    <iframe id="htmlRenderer" class="w-full h-full border-0 rounded-lg" sandbox="allow-same-origin allow-scripts"></iframe>
                </div>
            </div>
        </div>

        <div class="lg:col-span-1 flex flex-col gap-6">
            <div class="control-panel rounded-lg p-4">
                 <h2 class="text-lg font-bold mb-4 border-b border-slate-600 pb-2">Stream & Display</h2>
                <div class="space-y-4">
                    <div class="grid grid-cols-2 gap-3">
                        <button id="toggleFullscreenBtn" class="flex items-center justify-center gap-2 w-full bg-slate-600/50 hover:bg-slate-600 text-slate-200 text-sm font-semibold py-2 px-4 rounded-md transition-colors">Fullscreen</button>
                        <button id="popOutStreamBtn" class="flex items-center justify-center gap-2 w-full bg-slate-600/50 hover:bg-slate-600 text-slate-200 text-sm font-semibold py-2 px-4 rounded-md transition-colors">Pop Out</button>
                    </div>
                     <button id="popOutHtmlBtn" class="w-full bg-slate-600/50 hover:bg-slate-600 text-slate-200 text-sm font-semibold py-2 px-4 rounded-md transition-colors">Pop Out HTML Render</button>

                    <div class="pt-2 space-y-3">
                        <div>
                            <label for="qualitySlider" class="flex justify-between text-sm font-medium text-slate-300 mb-1"><span>Quality</span><span id="qualityValue" class="font-semibold text-blue-400">1</span></label>
                            <input id="qualitySlider" type="range" min="1" max="100" value="1" class="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer">
                        </div>
                        <div>
                            <label for="frameRateSlider" class="flex justify-between text-sm font-medium text-slate-300 mb-1"><span>Frame Rate</span><span id="frameRateValue" class="font-semibold text-blue-400">16</span></label>
                            <input id="frameRateSlider" type="range" min="1" max="60" value="16" class="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer">
                        </div>
                    </div>
                    <button id="autoQualityBtn" class="w-full bg-slate-600/50 hover:bg-slate-600 text-slate-200 text-sm font-bold py-2 px-5 rounded-md transition-colors">Toggle Auto Quality</button>
                </div>
            </div>

            <div class="control-panel rounded-lg p-4">
                <h2 class="text-lg font-bold mb-3">Shared Clipboard</h2>
                <textarea id="sharedClipboard" class="w-full h-32 p-3 rounded-md bg-slate-800 text-slate-200 border border-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"></textarea>
            </div>

            <div class="control-panel rounded-lg p-4">
                <h2 class="text-lg font-bold mb-3">Communication</h2>
                <div class="flex items-center justify-between bg-slate-800/50 p-3 rounded-md">
                    <span class="text-sm text-slate-400">Message from User:</span>
                    <div id="emojiFromMac" class="text-4xl">⌛</div>
                </div>
                <div class="mt-3">
                    <div class="flex items-end gap-3 mb-3">
                        <div>
                            <label for="numberInput" class="block text-sm font-medium text-slate-300 mb-1">ID</label>
                            <input type="number" id="numberInput" class="w-24 p-2 text-center rounded-md bg-slate-800 border border-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500" value="1" min="1">
                        </div>
                        <div class="flex-grow grid grid-cols-3 gap-2">
                            <button class="word-btn bg-slate-700 hover:bg-slate-600 py-2 rounded-md transition-colors" data-word="About">A</button>
                            <button class="word-btn bg-slate-700 hover:bg-slate-600 py-2 rounded-md transition-colors" data-word="Back">B</button>
                            <button class="word-btn bg-slate-700 hover:bg-slate-600 py-2 rounded-md transition-colors" data-word="Close">C</button>
                            <button class="word-btn bg-slate-700 hover:bg-slate-600 py-2 rounded-md transition-colors" data-word="Duplicate">D</button>
                            <button class="word-btn bg-slate-700 hover:bg-slate-600 py-2 rounded-md transition-colors" data-word="Extensions">E</button>
                            <button class="word-btn bg-slate-700 hover:bg-slate-600 py-2 rounded-md transition-colors" data-word="Find">F</button>
                        </div>
                    </div>
                    <div class="flex gap-2">
                        <input type="text" id="customWordInput" class="flex-grow p-2 rounded-md bg-slate-800 border border-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Custom message... (Shift+Click to add)">
                        <button id="sendCustomWordBtn" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg transition-colors">Send</button>
                    </div>
                </div>
            </div>

            <div class="control-panel rounded-lg p-4">
                <h2 class="text-lg font-bold mb-3">Batch Communication</h2>
                <div class="space-y-3">
                    <div>
                        <label for="batchJsonInput" class="block text-sm font-medium text-slate-300 mb-1">JSON Input</label>
                        <textarea id="batchJsonInput" class="w-full h-40 p-3 rounded-md bg-slate-800 text-slate-200 border border-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm" placeholder='{ "questions": [ ... ] }'></textarea>
                    </div>
                    <div class="flex items-center gap-4">
                        <button id="startBatchBtn" class="flex-grow bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg transition-colors disabled:bg-slate-500 disabled:cursor-not-allowed">Start Batch</button>
                        <div id="batchStatus" class="text-sm text-slate-400 font-medium">Idle</div>
                    </div>
                </div>
            </div>
        </div>
    </main>

    <script>
        const socket = io();

        // --- UI Elements ---
        const liveScreenFeed = document.getElementById('liveScreenFeed');
        const sharedClipboard = document.getElementById('sharedClipboard');
        const emojiFromMac = document.getElementById('emojiFromMac');
        const macStatus = document.getElementById('macStatus');
        const macStatusText = document.getElementById('macStatusText');
        const screenFeedContainer = document.getElementById('screenFeedContainer');
        const htmlRenderer = document.getElementById('htmlRenderer');
        const queueStatus = document.getElementById('queueStatus'); // NEW

        // Controls (no changes to element selections)
        const qualitySlider = document.getElementById('qualitySlider');
        const qualityValue = document.getElementById('qualityValue');
        const frameRateSlider = document.getElementById('frameRateSlider');
        const frameRateValue = document.getElementById('frameRateValue');
        const autoQualityBtn = document.getElementById('autoQualityBtn');
        const toggleFullscreenBtn = document.getElementById('toggleFullscreenBtn');
        const popOutStreamBtn = document.getElementById('popOutStreamBtn');
        const popOutHtmlBtn = document.getElementById('popOutHtmlBtn');
        const numberInput = document.getElementById('numberInput');
        const customWordInput = document.getElementById('customWordInput');
        const sendCustomWordBtn = document.getElementById('sendCustomWordBtn');
        const batchJsonInput = document.getElementById('batchJsonInput');
        const startBatchBtn = document.getElementById('startBatchBtn');
        const batchStatus = document.getElementById('batchStatus');

        // --- State & Utilities ---
        let isAutoMode = false;
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const wordMap = {};
        document.querySelectorAll('.word-btn').forEach(btn => {
            wordMap[btn.textContent] = btn.dataset.word;
        });

        // --- Socket Connection & Listeners ---
        socket.on('connect', () => {
            socket.emit('identify', 'web');
            socket.emit('qualityChange', qualitySlider.value);
            socket.emit('frameRateChange', frameRateSlider.value);
        });

        socket.on('screenData', (data) => liveScreenFeed.src = 'data:image/jpeg;base64,' + data);
        socket.on('renderHTML', (source) => htmlRenderer.srcdoc = source);
        socket.on('clipboardData', (content) => { if (document.activeElement !== sharedClipboard) sharedClipboard.value = content; });
        socket.on('emojiToWeb', (emoji) => emojiFromMac.textContent = emoji);
        
        // --- MODIFIED: Handle status updates for connection and message queue ---
        socket.on('statusUpdate', (data) => {
            if (data.type === 'mac') {
                const isConnected = data.status === 'connected';
                macStatus.classList.toggle('status-red', !isConnected);
                macStatus.classList.toggle('status-green', isConnected);
                macStatusText.textContent = isConnected ? 'macOS App Connected' : 'Disconnected. Messages will be queued.';
                if (!isConnected) {
                    liveScreenFeed.src = 'https://placehold.co/1920x1080/000000/334155?text=macOS+App+Disconnected';
                } else {
                    // When reconnected, hide the queue status as it's being processed
                    queueStatus.classList.add('hidden');
                }
            } else if (data.type === 'queue') {
                if (data.status === 'queued' && data.count > 0) {
                    queueStatus.textContent = \`(\${data.count} Queued)\`;
                    queueStatus.classList.remove('hidden');
                } else if (data.status === 'cleared') {
                    queueStatus.classList.add('hidden');
                }
            }
        });

        // --- UI Interactions (No changes below this line) ---
        // Tabs
        const tabs = document.getElementById('tabs');
        const tabContents = document.querySelectorAll('.tab-content');
        tabs.addEventListener('click', (e) => {
            if (e.target.matches('.tab-btn')) {
                tabs.querySelector('.active')?.classList.remove('active');
                e.target.classList.add('active');
                tabContents.forEach(c => c.classList.remove('active'));
                document.getElementById(e.target.dataset.tab).classList.add('active');
            }
        });
        document.querySelector('.tab-btn[data-tab="stream"]').click(); // Activate first tab by default

        // Clipboard
        sharedClipboard.addEventListener('input', () => socket.emit('clipboardData', sharedClipboard.value));

        // Communication
        document.querySelectorAll('.word-btn').forEach(button => {
            button.addEventListener('click', (e) => {
                const word = button.dataset.word;
                if (e.shiftKey) {
                    e.preventDefault();
                    if (customWordInput.value) {
                        customWordInput.value += \` | \${word}\`;
                    } else {
                        const numberVal = parseInt(numberInput.value, 10);
                        if (isNaN(numberVal) || numberVal < 1) {
                            customWordInput.value = word;
                        } else {
                            customWordInput.value = \`\${numberVal}% \${word}\`;
                        }
                    }
                } else {
                    const numberVal = parseInt(numberInput.value, 10);
                    if (isNaN(numberVal) || numberVal < 1) {
                        socket.emit('wordToMac', word);
                        return;
                    }
                    const message = \`\${numberVal}% \${word}\`;
                    socket.emit('wordToMac', message);
                    numberInput.value = numberVal + 1;
                }
            });
        });
        
        const sendWord = () => { if (customWordInput.value) { socket.emit('wordToMac', customWordInput.value); customWordInput.value = ''; }};
        sendCustomWordBtn.addEventListener('click', sendWord);
        customWordInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') sendWord(); });

        // Stream Controls
        const updateQuality = () => { qualityValue.textContent = qualitySlider.value; socket.emit('qualityChange', qualitySlider.value); };
        const updateFrameRate = () => { frameRateValue.textContent = frameRateSlider.value; socket.emit('frameRateChange', frameRateSlider.value); };
        qualitySlider.addEventListener('input', () => qualityValue.textContent = qualitySlider.value);
        qualitySlider.addEventListener('change', updateQuality);
        frameRateSlider.addEventListener('input', () => frameRateValue.textContent = frameRateSlider.value);
        frameRateSlider.addEventListener('change', updateFrameRate);
        
        autoQualityBtn.addEventListener('click', () => {
            isAutoMode = !isAutoMode;
            autoQualityBtn.classList.toggle('active', isAutoMode);
            qualitySlider.disabled = isAutoMode;
            frameRateSlider.disabled = isAutoMode;
        });

        // Window Controls
        function toggleFullscreen() {
            if (!document.fullscreenElement) {
                screenFeedContainer.requestFullscreen().catch(err => alert(\`Error: \${err.message}\`));
            } else {
                document.exitFullscreen();
            }
        }
        toggleFullscreenBtn.addEventListener('click', toggleFullscreen);
        popOutStreamBtn.addEventListener('click', () => window.open('/stream-view', '_blank', 'popup,width=1280,height=720'));
        popOutHtmlBtn.addEventListener('click', () => window.open('/html-view', '_blank', 'popup,width=1280,height=800'));
        
        // Batch Communication Logic
        startBatchBtn.addEventListener('click', async () => {
            let data;
            batchStatus.textContent = 'Processing...';
            batchStatus.classList.remove('text-red-400');

            try {
                data = JSON.parse(batchJsonInput.value);
                if (!data.questions || !Array.isArray(data.questions)) {
                    throw new Error("JSON must contain a 'questions' array.");
                }
            } catch (error) {
                batchStatus.textContent = \`Error: \${error.message}\`;
                batchStatus.classList.add('text-red-400');
                return;
            }

            startBatchBtn.disabled = true;
            const questions = data.questions;

            for (let i = 0; i < questions.length; i++) {
                const item = questions[i];
                batchStatus.textContent = \`Sending \${i + 1} of \${questions.length}...\`;
                
                const { questionNumber, answers } = item;
                if (!questionNumber || !answers || !Array.isArray(answers)) {
                    console.warn('Skipping invalid item in batch:', item);
                    continue; 
                }
                
                const convertedAnswers = answers.map(ans => wordMap[ans.toUpperCase()] || 'Unknown').join(' | ');
                const message = \`\${questionNumber}% \${convertedAnswers}\`;
                
                socket.emit('wordToMac', message);
                
                if (i < questions.length - 1) {
                    batchStatus.textContent = \`Q\${questionNumber} - Wait (4s)...\`;
                    await sleep(4000);
                }
            }
            
            batchStatus.textContent = 'Batch Complete!';
            startBatchBtn.disabled = false;
        });
    </script>
</body>
</html>
`;

// --- Minimal HTML for Pop-Out Stream View (No changes needed) ---
const STREAM_VIEW_HTML = `
<!DOCTYPE html>
<html lang="en"><head><title>Live Stream</title><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>body { margin: 0; background-color: #000; display: flex; align-items: center; justify-content: center; height: 100vh; } img { max-width: 100%; max-height: 100%; object-fit: contain; }</style></head>
<body><img id="liveScreenFeed" src="https://placehold.co/1920x1080/000000/333?text=Connecting..." alt="Live Stream">
<script src="/socket.io/socket.io.js"></script>
<script>
    const socket = io();
    socket.on('connect', () => socket.emit('identify', 'web-stream-viewer'));
    socket.on('screenData', (data) => document.getElementById('liveScreenFeed').src = 'data:image/jpeg;base64,' + data);
    socket.on('statusUpdate', (data) => { if(data.type === 'mac' && data.status === 'disconnected') document.getElementById('liveScreenFeed').src = 'https://placehold.co/1920x1080/000000/333?text=Disconnected'; });
</script>
</body></html>
`;

// --- Minimal HTML for Pop-Out HTML Render View (No changes needed) ---
const HTML_VIEW_HTML = `
<!DOCTYPE html>
<html lang="en"><head><title>Live HTML Render</title><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>body, html { margin: 0; padding: 0; width: 100%; height: 100%; } iframe { border: 0; width: 100%; height: 100%; }</style></head>
<body><iframe id="htmlRenderer" sandbox="allow-same-origin allow-scripts"></iframe>
<script src="/socket.io/socket.io.js"></script>
<script>
    const socket = io();
    const iframe = document.getElementById('htmlRenderer');
    socket.on('connect', () => socket.emit('identify', 'web-html-viewer'));
    socket.on('renderHTML', (source) => { iframe.srcdoc = source; });
</script>
</body></html>
`;