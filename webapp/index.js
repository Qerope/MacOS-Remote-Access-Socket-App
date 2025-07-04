// index.js
// To run:
// 1. Install dependencies: npm install express socket.io
// 2. Run the server: node main.js
// 3. Access the web app at http://localhost:3000

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Serve the static HTML file for the web user
app.get('/', (req, res) => {
    res.send(HTML_CONTENT);
});

// Store the latest state
let lastClipboardContent = "Welcome to the shared clipboard!";
let lastEmoji = "...";
let lastWord = "Ready";
let lastQuality = 75; // Initial quality setting
let lastFrameRate = 30; // **NEW**: Initial frame rate setting
let macUserSocketId = null;

// Handle WebSocket connections
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Differentiate between the Mac app and web clients
    socket.on('identify', (type) => {
        if (type === 'macos') {
            macUserSocketId = socket.id;
            console.log('macOS app identified:', macUserSocketId);
            io.emit('statusUpdate', { type: 'mac', status: 'connected' });

            // Send the last known settings to the newly connected Mac app
            socket.emit('wordToMac', lastWord);
            socket.emit('qualityChange', lastQuality);
            socket.emit('frameRateChange', lastFrameRate); // **NEW**: Send initial frame rate
        } else { // Web client
            console.log('Web client connected:', socket.id);
            // Send the latest data to the new web client
            socket.emit('clipboardData', lastClipboardContent);
            socket.emit('emojiToWeb', lastEmoji);
            socket.emit('statusUpdate', { type: 'mac', status: macUserSocketId ? 'connected' : 'disconnected' });
        }
    });

    // Listen for screen data from the macOS app
    socket.on('screenData', (data) => {
        // Broadcast the screen data to all web clients
        socket.broadcast.emit('screenData', data);
    });

    // Listen for clipboard changes from either Mac or Web
    socket.on('clipboardData', (content) => {
        lastClipboardContent = content;
        socket.broadcast.emit('clipboardData', content);
    });

    // Listen for a word from the web user to the Mac app
    socket.on('wordToMac', (word) => {
        lastWord = word;
        if (macUserSocketId) {
            io.to(macUserSocketId).emit('wordToMac', word);
        }
    });
    
    // Listen for quality change from the web client
    socket.on('qualityChange', (quality) => {
        lastQuality = parseInt(quality, 10);
        if (macUserSocketId) {
            io.to(macUserSocketId).emit('qualityChange', lastQuality);
        }
    });

    // **NEW**: Listen for frame rate change from the web client
    socket.on('frameRateChange', (frameRate) => {
        lastFrameRate = parseInt(frameRate, 10);
        // Forward the frame rate setting to the macOS app
        if (macUserSocketId) {
            io.to(macUserSocketId).emit('frameRateChange', lastFrameRate);
        }
    });

    // Listen for an emoji from the Mac app to the web users
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
    console.log('Waiting for connections from the macOS app and web clients...');
});

// --- HTML, CSS, and Client-Side JS for the Web App ---
const HTML_CONTENT = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Web Collaboration Interface</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="/socket.io/socket.io.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background-color: #111827; color: #f3f4f6; }
        .status-dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; transition: background-color 0.3s ease; }
        .status-green { background-color: #34d399; box-shadow: 0 0 8px #34d399; }
        .status-red { background-color: #f87171; box-shadow: 0 0 8px #f87171; }
        .word-btn { transition: background-color 0.2s ease; }
        .word-btn:hover { background-color: #4b5563; }
        textarea { background-color: #374151; border-color: #4b5563; }
        
        #screenFeedContainer.fullscreen { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background-color: rgba(0, 0, 0, 0.9); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 2rem; }
        #screenFeedContainer.fullscreen #liveScreenFeed { max-height: 100%; max-width: 100%; object-fit: contain; }
        
        #autoQualityBtn.active { background-color: #2563eb; box-shadow: 0 0 8px #2563eb; }
        
        input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 20px; height: 20px; background: #3b82f6; cursor: pointer; border-radius: 50%; margin-top: -6px; transition: background-color 0.2s ease; }
        input[type="range"]:disabled::-webkit-slider-thumb { background: #4b5563; }
        input[type="range"]:disabled { opacity: 0.5; }
    </style>
</head>
<body class="flex flex-col h-screen items-center justify-center p-4 gap-6">

    <div class="w-full max-w-7xl flex flex-col lg:flex-row gap-6">

        <div class="flex-grow lg:w-2/3 flex flex-col gap-6">
            <div class="bg-gray-800 rounded-xl shadow-lg p-4 flex flex-col">
                <div class="flex justify-between items-center mb-3">
                    <div class="flex items-center gap-4">
                        <h2 class="text-xl font-bold">Live Screen Feed (<span id="fpsCounter">--</span> FPS)</h2>
                        <button id="toggleFullscreenBtn" title="Toggle Fullscreen" class="text-gray-400 hover:text-white transition-colors">
                            <svg id="iconEnlarge" xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1v4m0 0h-4m4 0l-5-5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5-5v4m0 0h-4" /></svg>
                            <svg id="iconShrink" xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-4-4m0 0l-4 4m4-4V3m0 18v-4m-4 4h4m8-12h-4m4 0l-4 4m4-4V3" /></svg>
                        </button>
                    </div>
                    <div class="flex items-center gap-2">
                        <span id="macStatusText" class="text-gray-400">Disconnected</span>
                        <div id="macStatus" class="status-dot status-red"></div>
                    </div>
                </div>
                <div id="screenFeedContainer" class="bg-black rounded-lg aspect-video flex items-center justify-center">
                    <img id="liveScreenFeed" src="https://placehold.co/1280x720/000000/444444?text=Waiting+for+macOS+App..." alt="Live Screen Feed" class="max-w-full max-h-full object-contain rounded-lg">
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 mt-4 px-1">
                    <div class="flex items-center gap-3">
                        <label for="qualitySlider" class="text-sm font-medium text-gray-400 whitespace-nowrap">Quality</label>
                        <input id="qualitySlider" type="range" min="1" max="100" value="75" class="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer">
                        <span id="qualityValue" class="text-sm font-semibold text-white w-10 text-center bg-gray-900 rounded-md py-1">75</span>
                    </div>
                    <div class="flex items-center gap-3">
                        <label for="frameRateSlider" class="text-sm font-medium text-gray-400 whitespace-nowrap">Frame Rate</label>
                        <input id="frameRateSlider" type="range" min="1" max="30" value="10" class="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer">
                        <span id="frameRateValue" class="text-sm font-semibold text-white w-10 text-center bg-gray-900 rounded-md py-1">10</span>
                    </div>
                </div>
                <div class="flex justify-center mt-4">
                     <button id="autoQualityBtn" class="bg-gray-600 hover:bg-gray-500 text-white text-sm font-bold py-2 px-5 rounded-lg transition-colors">Auto Adjust Quality</button>
                </div>
            </div>
            <div class="bg-gray-800 rounded-xl shadow-lg p-4">
                <h2 class="text-xl font-bold mb-3">Shared Clipboard</h2>
                <textarea id="sharedClipboard" class="w-full h-40 p-3 rounded-md text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Live clipboard content will appear here..."></textarea>
            </div>
        </div>

        <div class="lg:w-1/3 flex flex-col gap-6">
            <div class="bg-gray-800 rounded-xl shadow-lg p-4">
                <h2 class="text-xl font-bold mb-3">Send Message to User</h2>
                <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3">
                    <button class="word-btn bg-gray-700 py-2 rounded-md" data-word="About">A</button><button class="word-btn bg-gray-700 py-2 rounded-md" data-word="Back">B</button><button class="word-btn bg-gray-700 py-2 rounded-md" data-word="Close">C</button><button class="word-btn bg-gray-700 py-2 rounded-md" data-word="Duplicate">D</button><button class="word-btn bg-gray-700 py-2 rounded-md" data-word="Extensions">E</button><button class="word-btn bg-gray-700 py-2 rounded-md" data-word="Find">F</button>
                </div>
                <div class="flex gap-2"><input type="text" id="customWordInput" class="flex-grow p-2 rounded-md bg-gray-700 border border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Or type custom text..."><button id="sendCustomWordBtn" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg">Send</button></div>
            </div>
            <div class="bg-gray-800 rounded-xl shadow-lg p-4 flex flex-col items-center justify-center h-full"><h2 class="text-xl font-bold mb-3">Message from User</h2><div id="emojiFromMac" class="text-7xl animate-pulse">...</div></div>
        </div>
    </div>

    <script>
        const socket = io();

        // --- UI Elements ---
        const liveScreenFeed = document.getElementById('liveScreenFeed');
        const sharedClipboard = document.getElementById('sharedClipboard');
        const emojiFromMac = document.getElementById('emojiFromMac');
        const macStatus = document.getElementById('macStatus');
        const macStatusText = document.getElementById('macStatusText');
        const toggleFullscreenBtn = document.getElementById('toggleFullscreenBtn');
        const screenFeedContainer = document.getElementById('screenFeedContainer');
        const iconEnlarge = document.getElementById('iconEnlarge');
        const iconShrink = document.getElementById('iconShrink');
        const fpsCounter = document.getElementById('fpsCounter');
        
        // **NEW & MODIFIED**: Control elements
        const qualitySlider = document.getElementById('qualitySlider');
        const qualityValue = document.getElementById('qualityValue');
        const frameRateSlider = document.getElementById('frameRateSlider');
        const frameRateValue = document.getElementById('frameRateValue');
        const autoQualityBtn = document.getElementById('autoQualityBtn');

        // --- State Variables ---
        let isAutoMode = false;
        let frameCount = 0;
        let lastFpsCheckTime = performance.now();
        
        socket.on('connect', () => {
            socket.emit('identify', 'web');
            // Emit initial values on connect
            socket.emit('qualityChange', qualitySlider.value);
            socket.emit('frameRateChange', frameRateSlider.value);
        });

        // --- Server Data Listeners ---
        socket.on('screenData', (data) => {
            liveScreenFeed.src = 'data:image/jpeg;base64,' + data; // Use JPEG for better performance with quality adjustments
            frameCount++;
        });
        socket.on('clipboardData', (content) => { if (document.activeElement !== sharedClipboard) sharedClipboard.value = content; });
        socket.on('emojiToWeb', (emoji) => { emojiFromMac.textContent = emoji; emojiFromMac.classList.remove('animate-pulse'); });
        socket.on('statusUpdate', (data) => {
            if (data.type === 'mac') {
                const isConnected = data.status === 'connected';
                macStatus.classList.toggle('status-red', !isConnected);
                macStatus.classList.toggle('status-green', isConnected);
                macStatusText.textContent = isConnected ? 'Connected' : 'Connected';
                if (!isConnected) liveScreenFeed.src = 'https://placehold.co/1280x720/000000/444444?text=macOS+App+Disconnected';
            }
        });

        // --- UI Event Handlers ---
        sharedClipboard.addEventListener('input', () => socket.emit('clipboardData', sharedClipboard.value));
        document.querySelectorAll('.word-btn').forEach(b => b.addEventListener('click', () => socket.emit('wordToMac', b.dataset.word)));
        const customWordInput = document.getElementById('customWordInput');
        const sendCustomWordBtn = document.getElementById('sendCustomWordBtn');
        sendCustomWordBtn.addEventListener('click', () => { if (customWordInput.value) { socket.emit('wordToMac', customWordInput.value); customWordInput.value = ''; }});
        customWordInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') sendCustomWordBtn.click(); });

        // --- Fullscreen Logic ---
        function toggleFullscreen() {
            const isFullscreen = screenFeedContainer.classList.toggle('fullscreen');
            iconEnlarge.classList.toggle('hidden', isFullscreen);
            iconShrink.classList.toggle('hidden', !isFullscreen);
        }
        toggleFullscreenBtn.addEventListener('click', toggleFullscreen);
        window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && screenFeedContainer.classList.contains('fullscreen')) toggleFullscreen(); });

        // --- **MODIFIED & NEW**: Quality and Frame Rate Control Logic ---
        function setQuality(newQuality) {
            const q = Math.max(1, Math.min(100, Math.round(newQuality))); // Clamp between 1-100
            qualitySlider.value = q;
            qualityValue.textContent = q;
            socket.emit('qualityChange', q);
        }

        // Quality Slider Events
        qualitySlider.addEventListener('input', () => {
            qualityValue.textContent = qualitySlider.value;
            if (isAutoMode) { isAutoMode = false; autoQualityBtn.classList.remove('active'); }
        });
        qualitySlider.addEventListener('change', () => socket.emit('qualityChange', qualitySlider.value));
        
        // Frame Rate Slider Events
        frameRateSlider.addEventListener('input', () => {
            frameRateValue.textContent = frameRateSlider.value;
            if (isAutoMode) { isAutoMode = false; autoQualityBtn.classList.remove('active'); }
        });
        frameRateSlider.addEventListener('change', () => socket.emit('frameRateChange', frameRateSlider.value));

        // Auto Mode Button
        autoQualityBtn.addEventListener('click', () => {
            isAutoMode = !isAutoMode;
            autoQualityBtn.classList.toggle('active', isAutoMode);
            // Disable sliders when auto mode is on
            qualitySlider.disabled = isAutoMode;
            frameRateSlider.disabled = isAutoMode;
        });
        
        // FPS counter and Auto-adjustment interval (runs every 2 seconds)
        setInterval(() => {
            const now = performance.now();
            const delta = (now - lastFpsCheckTime) / 1000; // time in seconds
            const fps = Math.round(frameCount / delta);
            fpsCounter.textContent = fps;
            
            if (isAutoMode) {
                const currentQuality = parseInt(qualitySlider.value, 10);
                const targetFps = parseInt(frameRateSlider.value, 10);
                const minFpsTarget = targetFps - 5; // A threshold below the target

                let newQuality = currentQuality;

                // If FPS is well below target, decrease quality aggressively.
                if (fps < minFpsTarget && currentQuality > 1) {
                    newQuality = currentQuality - 5; 
                } 
                // If FPS is slightly above target, increase quality cautiously.
                else if (fps > targetFps + 2 && currentQuality < 100) {
                    newQuality = currentQuality + 2; 
                }
                
                if (newQuality !== currentQuality) {
                    setQuality(newQuality); // This will update UI and emit to server
                }
            }
            
            // Reset for next interval
            frameCount = 0;
            lastFpsCheckTime = now;
        }, 2000);

    </script>
</body>
</html>
`;