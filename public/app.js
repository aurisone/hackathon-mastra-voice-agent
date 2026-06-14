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
const tempSlider = document.getElementById('temperature-slider');
const tempValueDisplay = document.getElementById('temperature-value');
const chatBoard = document.getElementById('chat-board');
const thinkingConsole = document.getElementById('thinking-console');
const clearChatBtn = document.getElementById('clear-chat-btn');
const sessionCostDisplay = document.getElementById('session-cost');
const inputTokensDisplay = document.getElementById('input-tokens-display');
const outputTokensDisplay = document.getElementById('output-tokens-display');
const totalTokensDisplay = document.getElementById('total-tokens-display');
const modeSelect = document.getElementById('mode-select');

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

// Scribe Mode (v0.5) state variables
let isScribeModeActive = false;
let lastScribeSpeaker = 'patient'; // patient starts, so doctor is classified first unless overridden
let activeScribeBubble = null;
let scribeHistory = [];
let scribeEndTimer = null;
let userEndTimer = null;

// SOAP & Scribe (v0.11) state variables
let lastSoapHtml = '';
let lastSoapFhir = { conditions: [], observations: [], medications: [] };
let lastSoapCodes = [];


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
    const speaker = speakerSelect.value || 'Kore';
    const temp = tempSlider ? tempSlider.value : '0.1';
    const wsUrl = `${protocol}//${window.location.host}?speaker=${speaker}&temperature=${temp}`;
    
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
                    if (modeSelect && modeSelect.value === 'scribe') {
                        startScribeMode();
                    } else {
                        setOrbState('idle', 'Připraven. Mluv...');
                    }
                    
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
                        if (isScribeModeActive) {
                            setOrbState('recording', 'Auris Scribe nahrává...');
                            if (scribeEndTimer) {
                                clearTimeout(scribeEndTimer);
                                scribeEndTimer = null;
                            }
                        } else {
                            setOrbState('listening', 'Slyším tě...');
                            if (userEndTimer) {
                                clearTimeout(userEndTimer);
                                userEndTimer = null;
                            }
                        }
                        // Clear active assistant bubble when user starts new turn
                        currentAssistantBubble = null;
                    } else if (msg.state === 'end') {
                        if (isScribeModeActive) {
                            setOrbState('recording', 'Auris Scribe nahrává...');
                            // Debounce finalizing the scribe turn to ensure all final transcripts are fully processed
                            if (scribeEndTimer) clearTimeout(scribeEndTimer);
                            scribeEndTimer = setTimeout(finalizeScribeTurn, 1000); // 1-second debounce is ideal for final transcript safety
                        } else {
                            setOrbState('thinking', 'Přemýšlím...');
                            // Debounce clearing user bubble so late transcripts don't split bubbles
                            if (userEndTimer) clearTimeout(userEndTimer);
                            userEndTimer = setTimeout(() => {
                                currentUserBubble = null;
                                userEndTimer = null;
                            }, 1000);
                        }
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

                case 'usage':
                    // Server returned token usage updates for the session
                    handleUsageUpdate(msg);
                    break;

                case 'config_success':
                    console.log(`[WS] Speaker successfully updated to: ${msg.speaker}`);
                    break;

                case 'soap_update':
                    // Real-time medical report payload update from clinical agents (v0.11)
                    handleSoapUpdate(msg.html, msg.fhir, msg.codes);
                    break;

                case 'soap_update_error':
                    console.error('[SOAP] Error in real-time agent processing:', msg.message);
                    const soapStatusText = document.getElementById('soap-status-text');
                    if (soapStatusText) {
                        soapStatusText.innerText = 'Chyba analýzy';
                    }
                    const soapStatusBadge = document.getElementById('soap-status-badge');
                    if (soapStatusBadge) {
                        soapStatusBadge.style.color = 'var(--error)';
                    }
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
    activeScribeBubble = null;

    if (scribeEndTimer) {
        clearTimeout(scribeEndTimer);
        scribeEndTimer = null;
    }
    if (userEndTimer) {
        clearTimeout(userEndTimer);
        userEndTimer = null;
    }

    // Reset usage metrics on session close
    if (inputTokensDisplay) inputTokensDisplay.innerText = '0';
    if (outputTokensDisplay) outputTokensDisplay.innerText = '0';
    if (totalTokensDisplay) totalTokensDisplay.innerText = '0';
    if (sessionCostDisplay) sessionCostDisplay.innerText = '$0.000000';
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
    if (isScribeModeActive) return; // Mute assistant audio completely in scribe mode!

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

// Robust Czech phrase matching helpers for Scribe Mode triggers
function normalizeCzechText(txt) {
    if (!txt) return '';
    return txt.toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // strip diacritics (accents)
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "") // strip punctuation
        .replace(/\s+/g, " ") // collapse multiple spaces
        .trim();
}

function shouldStartScribeMode(text) {
    const clean = normalizeCzechText(text);
    return clean.includes("takze dobry den") || 
           clean.includes("takze dobri den") || 
           clean.includes("tak dobry den") || 
           clean.includes("dobry den takze");
}

function shouldEndScribeMode(text) {
    const clean = normalizeCzechText(text);
    return clean.includes("tak to je konec") || 
           clean.includes("takto je konec") || 
           clean.includes("konec nahravani") || 
           clean.includes("konec rozhovoru") ||
           clean.includes("ukoncit nahravani");
}

// Live dialogue transcription rendering
function handleTranscriptUpdate(role, text) {
    // If it's system/first load, remove boilerplate text
    const boilerplate = chatBoard.querySelector('.system-message');
    if (boilerplate) boilerplate.remove();

    if (isScribeModeActive) {
        if (role === 'assistant') {
            // Suppress assistant transcripts in scribe mode
            return;
        }
        
        if (role === 'user') {
            // Start or reset scribe end timer since user transcript is actively updating
            if (scribeEndTimer) {
                clearTimeout(scribeEndTimer);
            }
            scribeEndTimer = setTimeout(finalizeScribeTurn, 2000);

            if (shouldEndScribeMode(text)) {
                let cleanText = text;
                const textLower = text.toLowerCase();
                const endKeywords = [
                    'tak to je konec', 'tak to je konec.', 'tak, to je konec', 
                    'konec nahrávání', 'konec nahravani', 'konec rozhovoru', 
                    'ukončit nahrávání', 'ukoncit nahravani'
                ];
                for (const kw of endKeywords) {
                    const endIdx = textLower.indexOf(kw);
                    if (endIdx !== -1) {
                        cleanText = text.substring(0, endIdx).trim();
                        break;
                    }
                }
                if (cleanText) {
                    if (!activeScribeBubble) {
                        const speaker = diarizeSpeaker(cleanText);
                        activeScribeBubble = createScribeBubble(speaker, cleanText);
                        const placeholder = document.querySelector('.scribe-placeholder');
                        if (placeholder) placeholder.remove();
                        document.getElementById('scribe-body').appendChild(activeScribeBubble);
                    } else {
                        activeScribeBubble.querySelector('.scribe-text').innerText = cleanText;
                    }
                }
                endScribeMode();
                return;
            }

            // Normal scribe update
            if (!activeScribeBubble) {
                const speaker = diarizeSpeaker(text);
                activeScribeBubble = createScribeBubble(speaker, text);
                const placeholder = document.querySelector('.scribe-placeholder');
                if (placeholder) placeholder.remove();
                document.getElementById('scribe-body').appendChild(activeScribeBubble);
            } else {
                activeScribeBubble.querySelector('.scribe-text').innerText = text;
            }
            
            const scribeBody = document.getElementById('scribe-body');
            if (scribeBody) scribeBody.scrollTop = scribeBody.scrollHeight;
        }
        return;
    }

    if (role === 'user') {
        // Start or reset user end timer since user transcript is actively updating
        if (userEndTimer) {
            clearTimeout(userEndTimer);
        }
        userEndTimer = setTimeout(() => {
            currentUserBubble = null;
            userEndTimer = null;
        }, 2000);

        if (shouldStartScribeMode(text)) {
            startScribeMode();
            return;
        }

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

// Handle WebSocket usage / token events and compute cost
function handleUsageUpdate(data) {
    const inputTokens = data.inputTokens || 0;
    const outputTokens = data.outputTokens || 0;
    const totalTokens = data.totalTokens || 0;

    // Calculate cost based on Gemini 2.5 Flash pricing
    // Input tokens: $0.075 per 1M tokens ($0.000000075 / token)
    // Output tokens: $0.30 per 1M tokens ($0.00000030 / token)
    const cost = (inputTokens * 0.000000075) + (outputTokens * 0.00000030);

    // Update UI elements with formatted values
    if (inputTokensDisplay) {
        inputTokensDisplay.innerText = inputTokens;
    }
    if (outputTokensDisplay) {
        outputTokensDisplay.innerText = outputTokens;
    }
    if (totalTokensDisplay) {
        totalTokensDisplay.innerText = totalTokens;
    }
    if (sessionCostDisplay) {
        sessionCostDisplay.innerText = `$${cost.toFixed(6)}`;
        
        // Visual feedback trigger (pulse glow) when values update
        sessionCostDisplay.classList.add('updated');
        setTimeout(() => {
            sessionCostDisplay.classList.remove('updated');
        }, 300);
    }
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
    } else if (cardBody && name === 'createAurisVisit') {
        const visitLabel = result.visitType === '3' ? 'Sesterská návštěva (ID 3)' : 'Běžná návštěva (Výchozí)';
        const recordingLabel = result.recording ? 'Zahájit nahrávání (Aktivní 🎙️)' : 'Bez nahrávání';
        const nameLabel = result.patientName ? result.patientName : 'Nepojmenováno';

        cardBody.innerHTML = `
            <div class="auris-result-display">
                <div class="visit-details">
                    <div class="detail-row">
                        <span class="detail-label">Typ návštěvy:</span>
                        <span class="detail-val font-highlight">${visitLabel}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Jméno pacienta:</span>
                        <span class="detail-val font-highlight">${nameLabel}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Nahrávání v aplikaci:</span>
                        <span class="detail-val font-highlight">${recordingLabel}</span>
                    </div>
                </div>
                
                <a href="${result.url}" target="_blank" class="auris-link-btn">
                    <span class="btn-glow-effect"></span>
                    <span class="btn-text">Spustit Auris One ➔</span>
                </a>
                
                <div class="visit-meta">
                    <strong>Hluboký odkaz:</strong> <span class="url-text">${result.url}</span>
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

// Update temperature value readout as user slides
if (tempSlider) {
    tempSlider.addEventListener('input', () => {
        if (tempValueDisplay) {
            tempValueDisplay.innerText = tempSlider.value;
        }
    });

    // Reconnect session on change release to apply new temperature
    tempSlider.addEventListener('change', () => {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            console.log('[Temperature] Reconnecting session to apply new temperature...');
            closeSession();
            startSession();
        }
    });
}

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

const manualEndScribeBtn = document.getElementById('manual-end-scribe-btn');
if (manualEndScribeBtn) {
    manualEndScribeBtn.addEventListener('click', () => {
        if (isScribeModeActive) {
            endScribeMode();
        }
    });
}

// Setup collapsible thinking card handler
const thinkingHeader = document.getElementById('thinking-header');
const thinkingCard = document.querySelector('.reasoning-card');
thinkingHeader.addEventListener('click', () => {
    thinkingCard.classList.toggle('collapsed');
    const body = document.getElementById('thinking-body');
    body.classList.toggle('hidden');
});

// Setup SOAP tab switching handlers (v0.11)
document.addEventListener('DOMContentLoaded', () => {
    // We register these listeners so that they hook into the DOM cleanly
    const registerSoapTabs = () => {
        const soapTabButtons = document.querySelectorAll('.soap-tab-btn');
        soapTabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                // Deactivate all tab buttons in this card
                soapTabButtons.forEach(b => b.classList.remove('active'));
                
                // Hide all tab contents in the SOAP card
                document.querySelectorAll('.soap-tab-content').forEach(content => {
                    content.classList.remove('active');
                });
                
                // Activate clicked button
                btn.classList.add('active');
                
                // Show corresponding content panel
                const targetTabId = btn.getAttribute('data-tab');
                const targetPanel = document.getElementById(targetTabId);
                if (targetPanel) {
                    targetPanel.classList.add('active');
                }
            });
        });
    };
    registerSoapTabs();
});

// --- Auris Scribe (Verze 0.5) Helpers ---

function playSynthesizedChime(type) {
    if (!audioContext) return;
    try {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.connect(gain);
        gain.connect(audioContext.destination);
        
        const now = audioContext.currentTime;
        if (type === 'start') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(523.25, now); // C5
            gain.gain.setValueAtTime(0.08, now);
            osc.start(now);
            osc.frequency.setValueAtTime(659.25, now + 0.12); // E5
            osc.frequency.setValueAtTime(783.99, now + 0.24); // G5
            gain.gain.setValueAtTime(0.08, now + 0.24);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
            osc.stop(now + 0.45);
        } else if (type === 'stop') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(783.99, now); // G5
            gain.gain.setValueAtTime(0.08, now);
            osc.start(now);
            osc.frequency.setValueAtTime(659.25, now + 0.12); // E5
            osc.frequency.setValueAtTime(523.25, now + 0.24); // C5
            gain.gain.setValueAtTime(0.08, now + 0.24);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
            osc.stop(now + 0.5);
        }
    } catch (e) {
        console.warn('[Chime] Failed to play synthesized chime:', e);
    }
}

function startScribeMode() {
    console.log('[Scribe] Starting Auris Scribe Mode...');
    isScribeModeActive = true;
    lastScribeSpeaker = 'patient'; // so doctor is classified first unless overridden
    activeScribeBubble = null;
    scribeHistory = [];

    if (scribeEndTimer) {
        clearTimeout(scribeEndTimer);
        scribeEndTimer = null;
    }
    if (userEndTimer) {
        clearTimeout(userEndTimer);
        userEndTimer = null;
    }

    lastSoapHtml = '';
    lastSoapFhir = { conditions: [], observations: [], medications: [] };
    lastSoapCodes = [];

    // Clear report fields and show empty states
    const reportContainer = document.getElementById('soap-report-container');
    if (reportContainer) {
        reportContainer.innerHTML = `
            <div class="soap-empty-state">
                <p>Zde se bude průběžně vytvářet strukturovaná zpráva ve formátu SOAP...</p>
            </div>
        `;
    }
    const fhirContainer = document.getElementById('soap-fhir-container');
    if (fhirContainer) {
        fhirContainer.innerText = '{}';
    }
    const codesContainer = document.getElementById('soap-codes-container');
    if (codesContainer) {
        codesContainer.innerHTML = `
            <div class="soap-empty-state">
                <p>Zde se zobrazí klasifikované kódy ICPC-2 a MKN-10...</p>
            </div>
        `;
    }
    const statusText = document.getElementById('soap-status-text');
    if (statusText) {
        statusText.innerText = 'Čekám na dialog...';
    }

    // Clear and display Scribe dialogue
    const scribeBody = document.getElementById('scribe-body');
    if (scribeBody) {
        scribeBody.innerHTML = `
            <div class="scribe-placeholder">
                <p>Nahrávání spuštěno. Začněte mluvit...</p>
            </div>
        `;
    }
    
    // Hide standard chat & reasoning panels to focus on patient visit
    const chatCard = document.querySelector('.chat-card');
    const reasoningCard = document.querySelector('.reasoning-card');
    if (chatCard) chatCard.classList.add('hidden');
    if (reasoningCard) reasoningCard.classList.add('hidden');

    // Show dual clinical Scribe & SOAP container
    const scribeContainer = document.getElementById('scribe-container-row');
    if (scribeContainer) {
        scribeContainer.classList.remove('hidden');
    }

    // Update voice orb visual state to "recording"
    setOrbState('recording', 'Auris Scribe aktivní — Poslouchám rozhovor...');
    voiceOrb.classList.add('recording');

    // Play tactile sound effect
    playSynthesizedChime('start');
}

function endScribeMode() {
    console.log('[Scribe] Ending Auris Scribe Mode...');
    isScribeModeActive = false;
    
    // Save any active bubble to history before ending
    finalizeScribeTurn();

    // Hide Scribe container row and restore normal chat layout
    const scribeContainer = document.getElementById('scribe-container-row');
    if (scribeContainer) {
        scribeContainer.classList.add('hidden');
    }
    const chatCard = document.querySelector('.chat-card');
    const reasoningCard = document.querySelector('.reasoning-card');
    if (chatCard) chatCard.classList.remove('hidden');
    if (reasoningCard) reasoningCard.classList.remove('hidden');

    voiceOrb.classList.remove('recording');
    setOrbState('thinking', 'Zpracovávám lékařskou zprávu...');

    // Play tactical sound effect
    playSynthesizedChime('stop');

    // Append beautiful loading spinner card to Chat Board
    const loadingCard = document.createElement('div');
    loadingCard.className = 'scribe-loading-card';
    loadingCard.id = 'scribe-loading-card';
    loadingCard.innerHTML = `
        <div class="scribe-loading-spinner"></div>
        <div class="scribe-loading-text">Finalizuji lékařskou zprávu pomocí AI agentů...</div>
    `;
    chatBoard.appendChild(loadingCard);
    chatBoard.scrollTop = chatBoard.scrollHeight;

    // Wait 2.5 seconds to receive the final update from the sequential clinical pipeline,
    // then display the real formatted HTML SOAP report!
    setTimeout(() => {
        // Remove loading card
        const cardToRemove = document.getElementById('scribe-loading-card');
        if (cardToRemove) cardToRemove.remove();

        // Use the actual generated HTML, fallback if not ready or empty
        const finalHTML = lastSoapHtml || generateMedicalReport(scribeHistory);
        const reportWrapper = document.createElement('div');
        reportWrapper.innerHTML = finalHTML;
        chatBoard.appendChild(reportWrapper);
        chatBoard.scrollTop = chatBoard.scrollHeight;

        // Reset orb state to idle conversational mode
        setOrbState('idle', 'Připraven. Mluv...');

        // Force Gemini Live to speak a professional Czech completion response!
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'speak',
                text: 'Lékařská zpráva byla úspěšně vygenerována a připravena v rozhraní. Přejete si provést nějaké úpravy nebo odeslat recept?'
            }));
        }
    }, 2500);
}

function finalizeScribeTurn() {
    if (scribeEndTimer) {
        clearTimeout(scribeEndTimer);
        scribeEndTimer = null;
    }
    if (activeScribeBubble) {
        const text = activeScribeBubble.querySelector('.scribe-text').innerText;
        if (text && text.trim()) {
            const finalSpeaker = diarizeSpeaker(text);
            
            // Update UI of the bubble to reflect the correct speaker
            activeScribeBubble.className = `scribe-line ${finalSpeaker}`;
            const labelSpan = activeScribeBubble.querySelector('.scribe-speaker');
            if (labelSpan) {
                labelSpan.className = `scribe-speaker ${finalSpeaker}`;
                labelSpan.innerText = finalSpeaker === 'doctor' ? 'Lékař' : 'Pacient';
            }
            
            scribeHistory.push({ speaker: finalSpeaker, text });
            
            // Trigger real-time clinical agent pipeline over WS! (v0.11)
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'scribe_update', history: scribeHistory }));
                
                const soapStatusText = document.getElementById('soap-status-text');
                if (soapStatusText) {
                    soapStatusText.innerText = 'Zpracovávám...';
                }
            }
        }
        activeScribeBubble = null;
    }
}

function diarizeSpeaker(text) {
    const textLower = text.toLowerCase();
    
    // Strong doctor indicators in Czech medical conversations
    const doctorKeywords = [
        'dobrý den', 'dneska', 'poslechnu', 'dýchejte', 'odkašlete', 'vysvlečte', 'lehněte', 
        'předepíšu', 'recept', 'zprávu', 'diagnóza', 'jak se cítíte', 'co vás trápí', 
        'kartičku', 'pojišťovny', 'tlak', 'sestřičko', 'otevřete ústa', 'řekněte á', 'poslechnout', 'plíce'
    ];
    
    // Strong patient indicators in Czech medical conversations
    const patientKeywords = [
        'bolí mě', 'mám rýmu', 'kašlu', 'horečku', 'teplotu', 'doktore', 'paní doktorko', 
        'nemůžu spát', 'pálí mě', 'píchá mě', 'cítím se špatně', 'včera jsem', 'od té doby', 'teploty'
    ];
    
    let doctorScore = 0;
    let patientScore = 0;
    
    doctorKeywords.forEach(kw => { if (textLower.includes(kw)) doctorScore += 2; });
    patientKeywords.forEach(kw => { if (textLower.includes(kw)) patientScore += 2; });
    
    // Questions are typically asked by the Doctor
    if (textLower.endsWith('?')) {
        doctorScore += 1;
    }
    
    if (doctorScore > patientScore) {
        lastScribeSpeaker = 'doctor';
        return 'doctor';
    } else if (patientScore > doctorScore) {
        lastScribeSpeaker = 'patient';
        return 'patient';
    }
    
    // Fallback: alternate speaker
    const resolved = lastScribeSpeaker === 'doctor' ? 'patient' : 'doctor';
    lastScribeSpeaker = resolved;
    return resolved;
}

function createScribeBubble(speaker, text) {
    const line = document.createElement('div');
    line.className = `scribe-line ${speaker}`;
    
    const label = speaker === 'doctor' ? 'Lékař' : 'Pacient';
    
    line.innerHTML = `
        <span class="scribe-speaker ${speaker}">${label}</span>
        <span class="scribe-text">${text}</span>
    `;
    return line;
}

function generateMedicalReport(history) {
    let symptoms = [];
    let treatment = "Klidový režim, dostatek tekutin.";
    
    const historyText = history.map(h => h.text).join(' ').toLowerCase();
    
    if (historyText.includes('kašel') || historyText.includes('kašlu')) symptoms.push('suchý, dráždivý kašel');
    if (historyText.includes('teplot') || historyText.includes('horečk')) symptoms.push('zvýšená tělesná teplota (subfebrilie)');
    if (historyText.includes('krk') || historyText.includes('polyk')) symptoms.push('bolest v krku při polykání');
    if (historyText.includes('hlav')) symptoms.push('tenzní bolest hlavy v čelní oblasti');
    if (historyText.includes('břich')) symptoms.push('difúzní bolest břicha');
    if (historyText.includes('tlak')) symptoms.push('pocit tlaku na hrudi');
    
    if (symptoms.length === 0) {
        symptoms.push('obecná slabost, únava, nespecifické respirační příznaky');
    }
    
    if (historyText.includes('kašel') || historyText.includes('kašlu')) treatment += " Stoptussin gtt 3x8 kapek, inhalace Vincentky.";
    if (historyText.includes('teplot') || historyText.includes('horečk') || historyText.includes('hlav')) treatment += " Paralen 500mg při teplotě nad 38°C (max 4x denně).";
    if (historyText.includes('krk')) treatment += " Strepsils orální sprej 3x denně po jídle.";
    
    const dateStr = new Date().toLocaleDateString('cs-CZ');
    const timeStr = new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
    
    return `
        <div class="medical-report-card">
            <div class="medical-report-header">
                <div class="medical-report-title">
                    <span>📋</span>
                    <span>Lékařská zpráva — Návrh draftu</span>
                </div>
                <span class="medical-report-badge">Auris v0.5</span>
            </div>
            
            <div class="medical-report-grid">
                <div class="medical-report-section">
                    <div class="medical-report-section-title">👤 Pacient</div>
                    <div class="medical-report-section-content">Anonymní pacient</div>
                </div>
                <div class="medical-report-section">
                    <div class="medical-report-section-title">📅 Datum a čas</div>
                    <div class="medical-report-section-content">${dateStr} o ${timeStr}</div>
                </div>
            </div>
            
            <div class="medical-report-section full-width">
                <div class="medical-report-section-title">🩺 Subjektivní obtíže (Anamnéza)</div>
                <div class="medical-report-section-content">
                    Pacient přichází k vyšetření pro následující obtíže: ${symptoms.join(', ')}. Trvání příznaků cca od včerejšího dne. Cítí se unavený a slabý.
                </div>
            </div>
            
            <div class="medical-report-section full-width">
                <div class="medical-report-section-title">👁️ Obj. Nález a Vyšetření</div>
                <div class="medical-report-section-content">
                    Dýchání čisté, alveolární, bez vedlejších fenoménů. Poklep plný, jasný. Hrdlo: prosáklé, zarudlé, tonsily bez povlaků. Krevní tlak orientačně v normě.
                </div>
            </div>
            
            <div class="medical-report-section full-width">
                <div class="medical-report-section-title">💊 Doporučená terapie a plán</div>
                <div class="medical-report-section-content">
                    ${treatment} Režimová opatření: klid na lůžku, šetřící dieta. V případě zhoršení stavu nebo přetrvávání horeček nad 3 dni kontrola v ambulanci.
                </div>
            </div>
            
            <div class="visit-meta">
                <strong>AI Záznamník:</strong> Detekována diarizace (Lékař / Pacient). Zpráva byla automaticky vygenerována na základě real-time přepisu návštěvy.
            </div>
        </div>
    `;
}

// Render real-time clinical SOAP updates from Mastra multi-agent pipeline (v0.11)
function handleSoapUpdate(html, fhir, codes) {
    console.log('[SOAP] Processing live multi-agent update...', {
        hasHtml: !!html,
        fhirConditions: fhir?.conditions?.length || 0,
        codings: codes?.length || 0
    });

    // Cache latest state
    lastSoapHtml = html || '';
    lastSoapFhir = fhir || { conditions: [], observations: [], medications: [] };
    lastSoapCodes = codes || [];

    // 1. Render beautiful HTML report draft
    const reportContainer = document.getElementById('soap-report-container');
    if (reportContainer && lastSoapHtml) {
        reportContainer.innerHTML = lastSoapHtml;
    }

    // 2. Format and render FHIR R4 JSON Payload
    const fhirContainer = document.getElementById('soap-fhir-container');
    if (fhirContainer) {
        fhirContainer.innerText = JSON.stringify(lastSoapFhir, null, 2);
    }

    // 3. Build medical coding badges dynamically
    const codesContainer = document.getElementById('soap-codes-container');
    if (codesContainer) {
        if (lastSoapCodes.length === 0) {
            codesContainer.innerHTML = `
                <div class="soap-empty-state">
                    <p>Zde se zobrazí klasifikované kódy ICPC-2 a MKN-10...</p>
                </div>
            `;
        } else {
            codesContainer.innerHTML = '';
            lastSoapCodes.forEach(item => {
                const row = document.createElement('div');
                row.className = 'coding-row';

                let icpcHtml = '';
                if (item.icpc2) {
                    icpcHtml = `
                        <div class="coding-badge-wrapper">
                            <span class="coding-badge-title">ICPC-2 Standard</span>
                            <span class="coding-badge-code">${item.icpc2.code}</span>
                            <span class="coding-badge-display">${item.icpc2.display}</span>
                        </div>
                    `;
                } else {
                    icpcHtml = `
                        <div class="coding-badge-wrapper">
                            <span class="coding-badge-title">ICPC-2 Standard</span>
                            <span class="coding-badge-null">Nenalezen kód pro primární péči</span>
                        </div>
                    `;
                }

                let icdHtml = '';
                if (item.icd10) {
                    icdHtml = `
                        <div class="coding-badge-wrapper">
                            <span class="coding-badge-title">MKN-10 (ICD-10)</span>
                            <span class="coding-badge-code">${item.icd10.code}</span>
                            <span class="coding-badge-display">${item.icd10.display}</span>
                        </div>
                    `;
                } else {
                    icdHtml = `
                        <div class="coding-badge-wrapper">
                            <span class="coding-badge-title">MKN-10 (ICD-10)</span>
                            <span class="coding-badge-null">Nenalezena diagnostická shoda</span>
                        </div>
                    `;
                }

                row.innerHTML = `
                    <div class="coding-entity-text">${item.entityText}</div>
                    <div class="coding-systems">
                        ${icpcHtml}
                        ${icdHtml}
                    </div>
                `;
                codesContainer.appendChild(row);
            });
        }
    }

    // 4. Update the card header badge and status
    const statusText = document.getElementById('soap-status-text');
    if (statusText) {
        statusText.innerText = 'Zpráva připravena';
    }

    // 5. Trigger glowing visual confirmation effect
    const soapCard = document.getElementById('soap-card');
    if (soapCard) {
        soapCard.classList.remove('soap-card-updated-glow');
        void soapCard.offsetWidth; // Force reflow to allow animation reset
        soapCard.classList.add('soap-card-updated-glow');
    }
}


