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
let lastHtmlSource = `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-family:monospace;color:#ccc; background:#111;">Awaiting HTML render...</div>`;
let macUserSocketId = null;

// --- Queue for offline messages ---
let messageQueue = [];

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

            // Process any queued messages upon reconnection
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

            // Inform new web client about the current queue state
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

// --- Main UI HTML (REDESIGNED) ---
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
            --color-bg: #0d0d0d;
            --color-primary: #ff6600;
            --color-secondary: #00ffff;
            --color-text: #cccccc;
            --color-text-dark: #888888;
            --color-border: #444444;
            --color-panel-bg: #1a1a1a;
            --font-main: 'Fira Code', monospace;
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

        /* Header & Status */
        header { border: 1px solid var(--color-border); background: var(--color-panel-bg); padding: 0.5rem 1rem; display: flex; justify-content: space-between; align-items: center; }
        h1 { font-size: 1.5rem; color: var(--color-primary); text-shadow: 0 0 5px var(--color-primary); margin: 0; }
        .status-indicator { display: flex; align-items: center; gap: 0.75rem; }
        #macStatus { font-weight: bold; transition: color 0.3s, text-shadow 0.3s; }
        #macStatus.connected { color: var(--color-secondary); text-shadow: 0 0 8px var(--color-secondary); }
        #macStatus.disconnected { color: #ff3333; text-shadow: 0 0 8px #ff3333; }
        #queueStatus { color: var(--color-primary); font-weight: bold; }
        
        /* Tabs */
        #tabs { display: flex; gap: 0.5rem; border-bottom: 1px solid var(--color-border); margin-bottom: 1rem; }
        .tab-btn { background: none; border: 1px solid transparent; border-bottom: none; color: var(--color-text-dark); padding: 0.5rem 1rem; font-family: inherit; font-size: 1rem; cursor: pointer; transition: all 0.2s; }
        .tab-btn:hover { color: var(--color-primary); }
        .tab-btn.active { color: var(--color-primary); border-color: var(--color-border); background: var(--color-panel-bg); border-bottom: 1px solid var(--color-panel-bg); transform: translateY(1px); }
        .tab-content { display: none; }
        .tab-content.active { display: block; }

        /* Viewport */
        .viewport { background-color: #000; border: 1px solid var(--color-border); min-height: 480px; display: flex; align-items: center; justify-content: center; overflow: hidden; }
        .viewport img, .viewport iframe { max-width: 100%; max-height: 100%; object-fit: contain; width: 100%; height: 100%; border: none; }
        
        /* Fieldsets & Controls */
        fieldset { border: 1px solid var(--color-border); padding: 1rem; background: var(--color-panel-bg); margin: 0; display: flex; flex-direction: column; gap: 1rem; }
        legend { color: var(--color-secondary); font-weight: bold; padding: 0 0.5rem; text-transform: uppercase; }
        label { display: flex; justify-content: space-between; align-items: center; font-size: 0.9rem; color: var(--color-text-dark); }
        label span:last-child { color: var(--color-secondary); font-weight: bold; }
        
        /* Inputs, Buttons, Textareas */
        input[type="text"], input[type="number"], textarea, .button-grid {
            background-color: var(--color-bg); border: 1px solid var(--color-border); color: var(--color-text);
            padding: 0.5rem; font-family: inherit; font-size: 1rem;
        }
        input:focus, textarea:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 10px var(--color-primary); }
        textarea { resize: vertical; min-height: 80px; }
        .btn {
            background-color: #333; border: 1px solid var(--color-border); color: var(--color-text); padding: 0.5rem 1rem;
            cursor: pointer; text-align: center; transition: all 0.2s; font-family: inherit; font-size: 0.9rem;
        }
        .btn:hover { border-color: var(--color-primary); color: var(--color-primary); }
        .btn.primary { background-color: var(--color-primary); border-color: var(--color-primary); color: var(--color-bg); font-weight: bold; }
        .btn.primary:hover { filter: brightness(1.2); }
        .btn:disabled { background: #222; color: #555; border-color: #333; cursor: not-allowed; }
        .btn-group { display: flex; gap: 0.5rem; }
        
        /* Sliders */
        input[type="range"] { -webkit-appearance: none; appearance: none; width: 100%; height: 3px; background: var(--color-border); outline: none; transition: opacity .2s; cursor: pointer; }
        input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 10px; height: 20px; background: var(--color-secondary); cursor: pointer; border: 1px solid var(--color-bg); }
        input[type="range"]::-moz-range-thumb { width: 10px; height: 20px; background: var(--color-secondary); cursor: pointer; border: 1px solid var(--color-bg); }

        /* Specific Layouts */
        .comm-grid { display: grid; grid-template-columns: auto 1fr; gap: 0.75rem; align-items: flex-end; }
        .button-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; }
        #emojiFromMac { font-size: 2.5rem; text-align: center; }

        /* Fullscreen */
        #screenFeedContainer.fullscreen { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background-color: #000; z-index: 100; padding: 1rem; border: none; }
        
        @media (max-width: 1024px) {
            main { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <main>
        <div class="view-panel">
            <header>
                <h1>> macos_bridge</h1>
                <div class="status-indicator">
                    <span id="macStatus" class="disconnected">[DISCONNECTED]</span>
                    <span id="queueStatus" class="hidden"></span>
                </div>
            </header>
            
            <div>
                <div id="tabs">
                    <button class="tab-btn active" data-tab="stream">UPLINK_STREAM</button>
                    <button class="tab-btn" data-tab="html">HTML_RENDER</button>
                </div>

                <div id="stream" class="tab-content active">
                    <div id="screenFeedContainer" class="viewport">
                        <img id="liveScreenFeed" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOTIwIiBoZWlnaHQ9IjEwODAiIHZpZXdCb3g9IjAgMCAxOTIwIDEwODAiPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9IiMwMDAiLz48dGV4dCB4PSI1MCUiIHk9IjUwJSIgZm9udC1mYW1pbHk9IkZpcmEgQ29kZSwgbW9ub3NwYWNlIiBmb250LXNpemU9IjQwIiBmaWxsPSIjNDQ0IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkb21pbmFudC1iYXNlbGluZT0ibWlkZGxlIj5BSVdBSVRJTkcgU1RSRUFNX0RBVEEuLi48L3RleHQ+PC9zdmc+" alt="Live Screen Feed">
                    </div>
                </div>

                <div id="html" class="tab-content">
                    <div class="viewport">
                        <iframe id="htmlRenderer" sandbox="allow-same-origin allow-scripts"></iframe>
                    </div>
                </div>
            </div>
        </div>

        <div class="controls-panel">
            <fieldset>
                <legend>SYS_CTRL</legend>
                <div class="btn-group">
                    <button id="toggleFullscreenBtn" class="btn" style="flex:1;">[ ] FULLSCREEN</button>
                    <button id="popOutStreamBtn" class="btn" style="flex:1;">[->] POP-OUT STREAM</button>
                </div>
                <button id="popOutHtmlBtn" class="btn">[->] POP-OUT RENDER</button>
            </fieldset>

            <fieldset>
                <legend>STREAM_CONFIG</legend>
                <div>
                    <label for="qualitySlider"><span>QUALITY</span><span id="qualityValue">1</span></label>
                    <input id="qualitySlider" type="range" min="1" max="100" value="1">
                </div>
                <div>
                    <label for="frameRateSlider"><span>FRAME_RATE</span><span id="frameRateValue">16</span></label>
                    <input id="frameRateSlider" type="range" min="1" max="60" value="16">
                </div>
                <button id="autoQualityBtn" class="btn">TOGGLE AUTO QUALITY</button>
            </fieldset>

            <fieldset>
                <legend>SHARED_CLIPBOARD</legend>
                <textarea id="sharedClipboard"></textarea>
            </fieldset>

            <fieldset>
                <legend>COMMS</legend>
                <div class="comm-grid">
                    <div>
                        <label for="numberInput" style="justify-content:flex-start; gap: 0.5rem;"><span>ID</span></label>
                        <input type="number" id="numberInput" value="1" min="1" style="width: 80px; text-align: center;">
                    </div>
                    <div class="button-grid">
                        <button class="btn word-btn" data-word="About">A</button>
                        <button class="btn word-btn" data-word="Back">B</button>
                        <button class="btn word-btn" data-word="Close">C</button>
                        <button class="btn word-btn" data-word="Duplicate">D</button>
                        <button class="btn word-btn" data-word="Extensions">E</button>
                        <button class="btn word-btn" data-word="Find">F</button>
                    </div>
                </div>
                <div class="btn-group">
                    <input type="text" id="customWordInput" placeholder="Custom message... (Shift+Click to add)" style="flex:1;">
                    <button id="sendCustomWordBtn" class="btn primary">SEND</button>
                </div>
                 <div style="text-align:center; padding-top: 0.5rem; border-top: 1px solid var(--color-border); margin-top: 0.5rem;">
                    <span style="color: var(--color-text-dark);">REMOTE_STATUS</span>
                    <div id="emojiFromMac">⌛</div>
                </div>
            </fieldset>

            <fieldset>
                <legend>BATCH_OPS</legend>
                <textarea id="batchJsonInput" placeholder='{ "questions": [ ... ] }'></textarea>
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
        const sharedClipboard = document.getElementById('sharedClipboard');
        const emojiFromMac = document.getElementById('emojiFromMac');
        const macStatus = document.getElementById('macStatus');
        const macStatusText = document.getElementById('macStatusText'); // Note: This element is removed in the new design, but we keep the variable for compatibility.
        const screenFeedContainer = document.getElementById('screenFeedContainer');
        const htmlRenderer = document.getElementById('htmlRenderer');
        const queueStatus = document.getElementById('queueStatus');

        // Controls
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
        
        socket.on('statusUpdate', (data) => {
            if (data.type === 'mac') {
                const isConnected = data.status === 'connected';
                macStatus.textContent = isConnected ? '[CONNECTED]' : '[DISCONNECTED]';
                macStatus.className = isConnected ? 'connected' : 'disconnected';
                if (!isConnected) {
                    liveScreenFeed.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOTIwIiBoZWlnaHQ9IjEwODAiIHZpZXdCb3g9IjAgMCAxOTIwIDEwODAiPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9IiMwMDAiLz48dGV4dCB4PSI1MCUiIHk9IjUwJSIgZm9udC1mYW1pbHk9IkZpcmEgQ29kZSwgbW9ub3NwYWNlIiBmb250LXNpemU9IjQwIiBmaWxsPSIjNDQ0IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkb21pbmFudC1iYXNlbGluZT0ibWlkZGxlIj5ERVZJQ0UgRElTQ09OTkVDVEVELiBNRVNTQUdFUyBXSUxMIEJFIFFVRVVFRC4uLjwvdGV4dD48L3N2Zz4=';
                } else {
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

        // --- UI Interactions ---
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
            autoQualityBtn.style.borderColor = isAutoMode ? 'var(--color-secondary)' : 'var(--color-border)';
            autoQualityBtn.style.color = isAutoMode ? 'var(--color-secondary)' : 'var(--color-text)';
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
            batchStatus.style.color = 'var(--color-text)';

            try {
                data = JSON.parse(batchJsonInput.value);
                if (!data.questions || !Array.isArray(data.questions)) {
                    throw new Error("JSON must contain a 'questions' array.");
                }
            } catch (error) {
                batchStatus.textContent = \`ERR: \${error.message}\`;
                batchStatus.style.color = '#ff3333';
                return;
            }

            startBatchBtn.disabled = true;
            const questions = data.questions;

            for (let i = 0; i < questions.length; i++) {
                const item = questions[i];
                batchStatus.textContent = \`Sending \${i + 1} of \${questions.length}\`;
                
                const { questionNumber, answers } = item;
                if (!questionNumber || !answers || !Array.isArray(answers)) {
                    console.warn('Skipping invalid item in batch:', item);
                    continue; 
                }
                
                const convertedAnswers = answers.map(ans => wordMap[ans.toUpperCase()] || 'Unknown').join(' | ');
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

// --- Minimal HTML for Pop-Out Stream View (Themed) ---
const STREAM_VIEW_HTML = `
<!DOCTYPE html>
<html lang="en"><head><title>Live Stream</title><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>body { margin: 0; background-color: #0d0d0d; display: flex; align-items: center; justify-content: center; height: 100vh; font-family: 'Fira Code', monospace; } img { max-width: 100%; max-height: 100%; object-fit: contain; }</style></head>
<body><img id="liveScreenFeed" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOTIwIiBoZWlnaHQ9IjEwODAiIHZpZXdCb3g9IjAgMCAxOTIwIDEwODAiPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9IiMwMDAiLz48dGV4dCB4PSI1MCUiIHk9IjUwJSIgZm9udC1mYW1pbHk9IkZpcmEgQ29kZSwgbW9ub3NwYWNlIiBmb250LXNpemU9IjQwIiBmaWxsPSIjNDQ0IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkb21pbmFudC1iYXNlbGluZT0ibWlkZGxlIj5DT05ORUNUSU5HIEZPUiBTVFJFQU0uLi48L3RleHQ+PC9zdmc+" alt="Live Stream">
<script src="/socket.io/socket.io.js"></script>
<script>
    const socket = io();
    const feed = document.getElementById('liveScreenFeed');
    socket.on('connect', () => socket.emit('identify', 'web-stream-viewer'));
    socket.on('screenData', (data) => feed.src = 'data:image/jpeg;base64,' + data);
    socket.on('statusUpdate', (data) => { if(data.type === 'mac' && data.status === 'disconnected') feed.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOTIwIiBoZWlnaHQ9IjEwODAiIHZpZXdCb3g9IjAgMCAxOTIwIDEwODAiPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9IiMwMDAiLz48dGV4dCB4PSI1MCUiIHk9IjUwJSIgZm9udC1mYW1pbHk9IkZpcmEgQ29kZSwgbW9ub3NwYWNlIiBmb250LXNpemU9IjQwIiBmaWxsPSIjNDQ0IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkb21pbmFudC1iYXNlbGluZT0ibWlkZGxlIj5ESVNDT05ORUNURUQuPC90ZXh0Pjwvc3ZnPg=='; });
</script>
</body></html>
`;

// --- Minimal HTML for Pop-Out HTML Render View (Themed) ---
const HTML_VIEW_HTML = `
<!DOCTYPE html>
<html lang="en"><head><title>Live HTML Render</title><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>body, html { margin: 0; padding: 0; width: 100%; height: 100%; background: #0d0d0d; } iframe { border: 0; width: 100%; height: 100%; }</style></head>
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