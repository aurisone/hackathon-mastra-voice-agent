/**
 * Auris Voice — Client side Speech-to-Speech Controller
 */

// UI Elements
const statusBadge = document.getElementById('status-badge');
const statusText = document.getElementById('status-text');
const voiceOrb = document.getElementById('voice-orb');
const orbOuterGlow = document.getElementById('orb-glow-outer');
const orbInnerGlow = document.getElementById('orb-glow-inner');
const orbStatusDisplay = document.getElementById('orb-status-display');
const connectBtn = document.getElementById('connect-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const speakerSelect = document.getElementById('speaker-select');
const chatBoard = document.getElementById('chat-board');
const thinkingConsole = document.getElementById('thinking-console');
const clearChatBtn = document.getElementById('clear-chat-btn');

// Audio Context & Streaming variables
let audioContext = null;
let micStream = null;
let scriptProcessor = null;
let micSource = null;
let ws = null;

// Assistant Playback Scheduling variables
let nextPlayTime = 0;
let activeAudioSources = [];
let assistantAnalyser = null;
let assistantAnimationId = null;

// Chat message tracking to update in-place instead of duplicates
let currentUserBubble = null;
let currentAssistantBubble = null;

// Initialize Web Socket Connection
async function startSession() {
    updateStatus('CONNECTING', 'connecting');
    setOrbState('thinking', 'Získávám přístup k mikrofonu...');

    // Security context check
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showError('Přístup k mikrofonu není v tomto prohlížeči dostupný. Prohlížeče vyžadují zabezpečené připojení (HTTPS nebo localhost). Ujistěte se, že web otevíráte na adrese http://localhost:3000 a nikoli přes IP adresu.');
        closeSession();
        return;
    }

    try {
        // 1. Initialize AudioContext and request Microphone permission DIRECTLY in the user gesture click handler!
        await initAudio();
        
        // This will trigger the browser permission prompt immediately and synchronously on click
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        
        console.log('[Audio] Microphone access granted directly.');
    } catch (err) {
        console.error('[Audio] Failed to initialize hardware devices:', err);
        showError('Nelze získat přístup k mikrofonu: ' + err.message);
        closeSession();
        return;
    }

    setOrbState('thinking', 'Připojování k serveru...');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const speaker = speakerSelect.value || 'Puck';
    const wsUrl = `${protocol}//${window.location.host}?speaker=${speaker}`;
    
    ws = new WebSocket(wsUrl);
    
    // Crucial: Handle binary data as ArrayBuffer for PCM mic chunks
    ws.binaryType = 'arraybuffer';

    ws.onopen = async () => {
        console.log('[WS] WebSocket connection opened with backend.');
        try {
            // Connect microphone and start streaming using already active micStream
            await startRecording();
        } catch (err) {
            console.error('[Audio] Failed to initialize recording pipeline:', err);
            showError('Chyba při startu nahrávání: ' + err.message);
            closeSession();
        }
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            
            switch (msg.type) {
                case 'session':
                    console.log('[WS] Voice session connected to Gemini Live!');
                    updateStatus('CONNECTED', 'connected');
                    setOrbState('idle', 'Připraven. Mluv...');
                    
                    // Sync is handled initially via WS query parameter
                    
                    connectBtn.classList.add('hidden');
                    disconnectBtn.classList.remove('hidden');
                    break;

                case 'audio':
                    // Received audio chunk (base64 PCM, 24kHz) from assistant
                    if (msg.data) {
                        playAssistantChunk(msg.data, msg.sampleRate || 24000);
                    }
                    break;

                case 'transcript':
                    // Received live spoken dialogue text
                    handleTranscriptUpdate(msg.role, msg.text);
                    break;

                case 'thinking':
                    // Received reasoning/thoughts from Gemini
                    handleThinkingUpdate(msg.text);
                    break;

                case 'interrupt':
                    // User spoke over assistant! Stop speaking instantly (barge-in)
                    handleInterruption();
                    break;

                case 'vad':
                    // User started/stopped speaking (VAD indicator)
                    if (msg.state === 'start') {
                        setOrbState('listening', 'Slyším tě...');
                        // Clear active assistant bubble when user starts new turn
                        currentAssistantBubble = null;
                    } else if (msg.state === 'end') {
                        setOrbState('thinking', 'Přemýšlím...');
                        // Clear active user bubble when user finishes turn
                        currentUserBubble = null;
                    }
                    break;

                case 'tool_call':
                    // Server notified us that the model requested a tool execution
                    handleToolCall(msg.name, msg.args, msg.id);
                    break;

                case 'tool_response':
                    // Server completed tool execution and returned result
                    handleToolResponse(msg.name, msg.args, msg.result);
                    break;

                case 'config_success':
                    console.log(`[WS] Speaker successfully updated to: ${msg.speaker}`);
                    break;

                case 'error':
                    console.error('[WS] Server error:', msg.message);
                    showError(msg.message);
                    break;
            }
        } catch (err) {
            console.error('[WS] Error processing message:', err);
        }
    };

    ws.onerror = (err) => {
        console.error('[WS] Socket error:', err);
        showError('Chyba síťového připojení.');
    };

    ws.onclose = () => {
        console.log('[WS] WebSocket connection closed.');
        closeSession();
    };
}

// Close current Web and Gemini session
function closeSession() {
    stopRecording();
    stopAssistantPlayback();
    
    if (ws) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
        }
        ws = null;
    }

    updateStatus('DISCONNECTED', 'disconnected');
    setOrbState('idle', 'Klikni na Připojit');
    
    connectBtn.classList.remove('hidden');
    disconnectBtn.classList.add('hidden');
    
    currentUserBubble = null;
    currentAssistantBubble = null;
}

// --- Audio Hardware Management (Web Audio API) ---

async function initAudio() {
    if (!audioContext) {
        try {
            // Enforce 16000Hz (16kHz) for microphone input, standard for speech models
            audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 16000
            });
        } catch (e) {
            console.warn('[Audio] Failed to create AudioContext with 16kHz sample rate, falling back to default:', e);
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        console.log('[Audio] AudioContext created with sample rate:', audioContext.sampleRate);
    }
    
    if (audioContext.state === 'suspended') {
        await audioContext.resume();
    }

    // Reset playback clock scheduler
    nextPlayTime = 0;
}

// Access microphone and stream downsampled PCM 16-bit binary
async function startRecording() {
    if (!micStream) {
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
    }

    micSource = audioContext.createMediaStreamSource(micStream);
    
    // Create ScriptProcessorNode with 4096 buffer size
    scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
    
    scriptProcessor.onaudioprocess = (event) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        const inputBuffer = event.inputBuffer.getChannelData(0); // Float32 samples
        const sampleCount = inputBuffer.length;
        
        // Convert Float32 [-1.0, 1.0] samples to Int16 [-32768, 32767] (PCM 16-bit)
        const pcmData = new Int16Array(sampleCount);
        let volumeSum = 0;

        for (let i = 0; i < sampleCount; i++) {
            const sample = Math.max(-1, Math.min(1, inputBuffer[i])); // clamp
            pcmData[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            volumeSum += sample * sample;
        }

        // Send binary ArrayBuffer of PCM chunks
        ws.send(pcmData.buffer);

        // Modulate visual orb if we are in listening state
        const rms = Math.sqrt(volumeSum / sampleCount);
        if (voiceOrb.classList.contains('listening')) {
            modulateVisuals(rms, 'listening');
        }
    };

    micSource.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);
    console.log('[Audio] Microphone recording & binary downsampling active.');
}

function stopRecording() {
    if (scriptProcessor) {
        scriptProcessor.disconnect();
        scriptProcessor = null;
    }
    if (micSource) {
        micSource.disconnect();
        micSource = null;
    }
    if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
        micStream = null;
    }
    console.log('[Audio] Microphone streaming stopped.');
}

// --- Assistant Playback & Gapless Scheduling ---

// Play received base64-encoded Int16 PCM chunk
function playAssistantChunk(base64Data, sampleRate) {
    if (!audioContext) return;

    // 1. Decode base64 to array buffer
    const binaryString = atob(base64Data);
    const bytesLength = binaryString.length;
    const bytes = new Uint8Array(bytesLength);
    for (let i = 0; i < bytesLength; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    
    // 2. Cast buffer to Int16Array
    const int16Data = new Int16Array(bytes.buffer, bytes.byteOffset, bytesLength / 2);
    const sampleCount = int16Data.length;
    
    // 3. Convert Int16 PCM back to Float32 array for Web Audio API
    const float32Data = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
        float32Data[i] = int16Data[i] / 32768.0;
    }

    // 4. Create an AudioBuffer
    const audioBuffer = audioContext.createBuffer(1, sampleCount, sampleRate);
    audioBuffer.copyToChannel(float32Data, 0);

    // 5. Schedule chunk gaplessly using precise scheduling clock
    const duration = audioBuffer.duration;
    const currentTime = audioContext.currentTime;

    if (nextPlayTime < currentTime) {
        // Queue was empty or lagged, reset playback clock with a tiny 40ms safety offset
        nextPlayTime = currentTime + 0.04;
    }

    // Create player source node
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;

    // Setup an AnalyserNode to capture assistant voice volume for visual animation
    if (!assistantAnalyser) {
        assistantAnalyser = audioContext.createAnalyser();
        assistantAnalyser.fftSize = 64;
        
        // Pipe visual feedback loops
        animateAssistantSpeaking();
    }

    source.connect(assistantAnalyser);
    assistantAnalyser.connect(audioContext.destination);

    // Track active source nodes to allow instant cancellation on barge-in (interruption)
    activeAudioSources.push(source);
    
    // Callback when chunk finishes playing
    source.onended = () => {
        activeAudioSources = activeAudioSources.filter(s => s !== source);
        if (activeAudioSources.length === 0) {
            // Once assistant finishes speaking entirely, reset orb to idle
            if (voiceOrb.classList.contains('speaking')) {
                setOrbState('idle', 'Připraven. Mluv...');
            }
        }
    };

    // Schedule exact absolute start time
    source.start(nextPlayTime);
    
    // Transition Orb state to speaking
    if (!voiceOrb.classList.contains('speaking') && !voiceOrb.classList.contains('listening')) {
        setOrbState('speaking', 'Odpovídám...');
    }

    // Advance scheduling clock for next chunk
    nextPlayTime += duration;
}

// Instantly stops all queued audio nodes (barge-in interruption)
function handleInterruption() {
    console.log('[Audio] Interruption detected! Flashing active speakers.');
    stopAssistantPlayback();
    
    // Reset scheduling clock to immediate
    if (audioContext) {
        nextPlayTime = audioContext.currentTime;
    }
    
    setOrbState('listening', 'Slyším tě...');
    
    // Mark interruption in Chat Transcript
    if (currentAssistantBubble) {
        const textElem = currentAssistantBubble.querySelector('.bubble-text');
        if (textElem && !textElem.innerHTML.includes('<em>[přerušeno]</em>')) {
            textElem.innerHTML += ' <em>[přerušeno]</em>';
        }
        currentAssistantBubble = null;
    }
}

function stopAssistantPlayback() {
    // Call stop() on all playing audio source nodes
    activeAudioSources.forEach(source => {
        try {
            source.stop();
        } catch (e) {
            // Already ended
        }
    });
    activeAudioSources = [];
    
    if (assistantAnimationId) {
        cancelAnimationFrame(assistantAnimationId);
        assistantAnimationId = null;
    }
    assistantAnalyser = null;
}

// Analyser feedback loop for Assistant voice ripples
function animateAssistantSpeaking() {
    if (!assistantAnalyser || !voiceOrb.classList.contains('speaking')) {
        assistantAnimationId = null;
        return;
    }

    const dataArray = new Uint8Array(assistantAnalyser.frequencyBinCount);
    assistantAnalyser.getByteTimeDomainData(dataArray);

    // Calculate RMS amplitude
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
        const sample = (dataArray[i] - 128) / 128; // convert to [-1, 1]
        sum += sample * sample;
    }
    const rms = Math.sqrt(sum / dataArray.length);

    modulateVisuals(rms, 'speaking');

    // Loop
    assistantAnimationId = requestAnimationFrame(animateAssistantSpeaking);
}

// --- Dynamic Web UI Management ---

function updateStatus(text, className) {
    statusText.innerText = text;
    statusBadge.className = `status-badge ${className}`;
}

function setOrbState(state, message) {
    voiceOrb.className = `voice-orb ${state}`;
    orbOuterGlow.className = `orb-glow-outer ${state}`;
    orbInnerGlow.className = `orb-glow-inner ${state}`;
    orbStatusDisplay.innerText = message;
    
    // Reset sizes to baseline when transition
    voiceOrb.style.transform = '';
    orbOuterGlow.style.transform = '';
    orbInnerGlow.style.transform = '';
}

// Modulate Orb shadow glow and size dynamically based on speech volumes
function modulateVisuals(volume, state) {
    // Map volume [0, 0.5] to scale multipliers
    const intensity = Math.min(1.0, volume * 4.0); // clamp at 1
    
    if (state === 'speaking') {
        const scale = 1.0 + intensity * 0.22;
        voiceOrb.style.transform = `scale(${scale})`;
        
        const glowSpread = 40 + intensity * 60;
        voiceOrb.style.boxShadow = `0 0 ${glowSpread}px rgba(${getComputedStyle(document.documentElement).getPropertyValue('--secondary-hsl')}, ${0.5 + intensity * 0.4})`;
    } else if (state === 'listening') {
        const scale = 1.1 + intensity * 0.25;
        voiceOrb.style.transform = `scale(${scale})`;
        
        const glowSpread = 30 + intensity * 50;
        voiceOrb.style.boxShadow = `0 0 ${glowSpread}px rgba(${getComputedStyle(document.documentElement).getPropertyValue('--primary-hsl')}, ${0.4 + intensity * 0.5})`;
    }
}

// Live dialogue transcription rendering
function handleTranscriptUpdate(role, text) {
    // If it's system/first load, remove boilerplate text
    const boilerplate = chatBoard.querySelector('.system-message');
    if (boilerplate) boilerplate.remove();

    if (role === 'user') {
        // User speech
        if (!currentUserBubble) {
            currentUserBubble = createChatBubble('user', 'Já');
            chatBoard.appendChild(currentUserBubble);
        }
        
        const textElem = currentUserBubble.querySelector('.bubble-text');
        textElem.innerText = text;
        
    } else if (role === 'assistant') {
        // Assistant speech
        if (!currentAssistantBubble) {
            currentAssistantBubble = createChatBubble('assistant', 'Hlasový asistent');
            chatBoard.appendChild(currentAssistantBubble);
        }
        
        const textElem = currentAssistantBubble.querySelector('.bubble-text');
        textElem.innerText = text;
    }

    // Auto-scroll chat board
    chatBoard.scrollTop = chatBoard.scrollHeight;
}

function createChatBubble(role, label) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${role}`;
    
    bubble.innerHTML = `
        <span class="bubble-meta">${label}</span>
        <span class="bubble-text"></span>
    `;
    
    return bubble;
}

// Live reasoning (Chain of Thought) logger
let accumulatedThinkingText = "";
function handleThinkingUpdate(text) {
    // If it's a new session or we were idle, clear console
    if (accumulatedThinkingText === "") {
        thinkingConsole.innerText = "";
    }

    accumulatedThinkingText += text;
    thinkingConsole.innerText = accumulatedThinkingText;
    
    // Auto-scroll console
    const container = document.getElementById('thinking-body');
    container.scrollTop = container.scrollHeight;
}

// Handle WebSocket tool call events
function handleToolCall(name, args, id) {
    // If it's first load, remove boilerplate text
    const boilerplate = chatBoard.querySelector('.system-message');
    if (boilerplate) boilerplate.remove();

    // Generate unique card ID if none provided
    const cardId = id || `tool-${Date.now()}`;
    
    const toolCard = document.createElement('div');
    toolCard.className = 'tool-card-container';
    toolCard.id = `card-${cardId}`;
    
    // Stringify args cleanly
    let argsString = '';
    if (args && typeof args === 'object') {
        argsString = Object.entries(args).map(([k, v]) => `<strong>${k}:</strong> ${v}`).join(', ');
    } else if (args) {
        argsString = JSON.stringify(args);
    }

    toolCard.innerHTML = `
        <div class="tool-card pending">
            <div class="tool-card-header">
                <span class="tool-icon">⚡</span>
                <span class="tool-title">Spouštím funkci: <strong>${name}</strong></span>
            </div>
            <div class="tool-card-body">
                <p class="tool-args">${argsString}</p>
                <div class="tool-status">
                    <span class="pulse-spinner"></span>
                    <span class="status-text">Auris One komunikuje s externím API...</span>
                </div>
            </div>
        </div>
    `;

    chatBoard.appendChild(toolCard);
    chatBoard.scrollTop = chatBoard.scrollHeight;

    // Log to the reasoning console as well
    handleThinkingUpdate(`\n>>> [SYSTEM CALL] Spouštím nástroj: ${name} s parametry: ${JSON.stringify(args)}\n`);
}

// Handle WebSocket tool response events
function handleToolResponse(name, args, result) {
    // Find the pending card. If name is getWeather, we can look for any active pending cards.
    const toolCard = chatBoard.querySelector('.tool-card.pending');
    if (!toolCard) {
        console.warn(`[UI] No pending tool card found to update for response from tool: ${name}`);
        return;
    }

    toolCard.classList.remove('pending');
    toolCard.classList.add('success');

    const icon = toolCard.querySelector('.tool-icon');
    if (icon) icon.innerText = '✅';

    const statusDiv = toolCard.querySelector('.tool-status');
    if (statusDiv) {
        statusDiv.innerHTML = `
            <span class="success-badge">Dokončeno úspěšně</span>
        `;
    }

    const cardBody = toolCard.querySelector('.tool-card-body');
    if (cardBody && name === 'getWeather') {
        cardBody.innerHTML = `
            <div class="weather-result-display">
                <div class="weather-temp-block">
                    <span class="weather-temp">${result.temperature}°C</span>
                    <span class="weather-cond">${result.condition}</span>
                </div>
                <div class="weather-comment">
                    "${result.comment}"
                </div>
                <div class="weather-meta">
                    Vlhkost vzduchu: ${result.humidity}% | Připojení: Šifrované (Vertex AI SSL)
                </div>
            </div>
        `;
    }

    chatBoard.scrollTop = chatBoard.scrollHeight;

    // Log to the reasoning console
    handleThinkingUpdate(`>>> [SYSTEM RESPONSE] Nástroj ${name} vrátil: ${JSON.stringify(result)}\n`);
}

function showError(message) {
    updateStatus('ERROR', 'error-state');
    setOrbState('idle', 'CHYBA');
    
    // Print error block in chat
    const errorBubble = document.createElement('div');
    errorBubble.className = 'system-message';
    errorBubble.style.borderColor = 'var(--error)';
    errorBubble.style.color = 'var(--error)';
    errorBubble.style.backgroundColor = 'rgba(var(--error-hsl), 0.08)';
    errorBubble.innerText = `Chyba: ${message}`;
    
    chatBoard.appendChild(errorBubble);
    chatBoard.scrollTop = chatBoard.scrollHeight;
}

function sendSpeakerConfig(speaker) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'config',
            speaker: speaker
        }));
    }
}

// --- Event Listeners ---

connectBtn.addEventListener('click', startSession);
disconnectBtn.addEventListener('click', closeSession);

speakerSelect.addEventListener('change', () => {
    // If session is active, disconnect and reconnect to apply the new speaker selection
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        console.log('[Speaker] Reconnecting session to apply new speaker...');
        closeSession();
        startSession();
    }
    
    // Clean bubble histories when changing characters to keep context clean
    currentUserBubble = null;
    currentAssistantBubble = null;
});

clearChatBtn.addEventListener('click', () => {
    chatBoard.innerHTML = `
        <div class="system-message">
            <p>Historie vymazána. Můžeš začít znovu mluvit.</p>
        </div>
    `;
    thinkingConsole.innerText = "Čekám na zahájení myšlení modelu...";
    accumulatedThinkingText = "";
    currentUserBubble = null;
    currentAssistantBubble = null;
});

// Setup collapsible thinking card handler
const thinkingHeader = document.getElementById('thinking-header');
const thinkingCard = document.querySelector('.reasoning-card');
thinkingHeader.addEventListener('click', () => {
    thinkingCard.classList.toggle('collapsed');
    const body = document.getElementById('thinking-body');
    body.classList.toggle('hidden');
});
