import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { GeminiLiveVoice } from '@mastra/voice-google-gemini-live';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config();

const project = process.env.GCP_PROJECT || 'auris-app-dev';
const location = process.env.GCP_LOCATION || 'europe-west4';
const PORT = process.env.PORT || 3000;

if (!project) {
  console.error('Error: GCP_PROJECT is not set in environment variables or .env file.');
  process.exit(1);
}

console.log('=========================================================');
console.log('Starting Mastra Speech-to-Speech (STS) Web Server');
console.log(` - GCP Project:  ${project}`);
console.log(` - GCP Location: ${location}`);
console.log(` - Model:        gemini-live-2.5-flash-native-audio`);
console.log(` - Web App URL:  http://localhost:${PORT}`);
console.log('=========================================================');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Serve static assets from the "public" directory
app.use(express.static('public'));

// Keep-alive or check routes
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    project,
    location,
    model: 'gemini-live-2.5-flash-native-audio',
  });
});

// Manage active WebSocket clients and their respective Gemini Live Voice connections
wss.on('connection', async (ws: WebSocket, req) => {
  const requestUrl = new URL(req.url || '', 'http://localhost');
  const speaker = requestUrl.searchParams.get('speaker') || 'Puck';
  console.log(`[Server] New client connected. Spawning voice agent session with speaker: ${speaker}...`);

  // Initialize a dedicated Gemini Live Voice instance for this client
  const voice = new GeminiLiveVoice({
    vertexAI: true,
    project,
    location,
    model: 'gemini-live-2.5-flash-native-audio' as any,
    speaker: speaker, // Set the speaker initially based on client preference
    debug: true,
  } as any) as any;

  let isConnected = false;

  try {
    console.log('[Server] Connecting to Gemini Live API...');
    await voice.connect();
    isConnected = true;
    console.log('[Server] Connected successfully to Gemini Live API!');

    // Notify client that the voice session is connected and ready
    ws.send(JSON.stringify({
      type: 'session',
      state: 'connected',
      speaker: 'Puck',
    }));

    // Start speaking an initial welcome greeting
    console.log('[Server] Speaking initial greeting...');
    await voice.speak('Ahoj! Jak ti mohu dnes pomoct?');

  } catch (error: any) {
    console.error('[Server] Failed to connect to Gemini Live API:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to connect to Vertex AI: ' + (error.message || error),
    }));
    ws.close();
    return;
  }

  // --- Register voice events and relay them to the client ---

  // 1. Audio responses (synthetic speech chunks)
  voice.on('speaking', ({ audio, audioData, sampleRate }: any) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'audio',
        data: audio, // base64 representation of raw PCM
        sampleRate: sampleRate || 24000,
      }));
    }
  });

  // 2. Transcription responses (User/Assistant spoken text)
  voice.on('writing', ({ text, role }: any) => {
    if (text && text.trim() && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'transcript',
        text,
        role,
      }));
    }
  });

  // 3. Chain of Thought / Reasoning reasoning text
  voice.on('thinking', ({ text }: any) => {
    if (text && text.trim() && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'thinking',
        text,
      }));
    }
  });

  // 4. Interrupts (Barge-in: client spoke over the assistant)
  voice.on('interrupt', (data: any) => {
    console.log('[Server] User interrupted assistant speaking!');
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'interrupt',
        timestamp: Date.now(),
      }));
    }
  });

  // 5. Voice activity detection events (for UI indicators)
  voice.on('vad', ({ type }: any) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'vad',
        state: type, // 'start' or 'end'
      }));
    }
  });

  // 6. Voice Errors
  voice.on('error', (err: any) => {
    console.error('[Server] Gemini Live Voice Error:', err);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'error',
        message: err.message || 'An error occurred during live voice exchange.',
      }));
    }
  });

  // --- Register inbound socket messages from client ---
  ws.on('message', async (message: Buffer, isBinary: boolean) => {
    try {
      if (isBinary) {
        // If it's a binary message, it's 16-bit PCM mic audio from the browser
        if (isConnected) {
          // Convert Node.js Buffer to Int16Array safely
          const int16Array = new Int16Array(
            message.buffer,
            message.byteOffset,
            message.byteLength / 2
          );
          await voice.send(int16Array);
        }
      } else {
        // Handle incoming JSON text messages
        const data = JSON.parse(message.toString());
        console.log('[Server] Received command:', data);

        if (data.type === 'config' && data.speaker) {
          console.log(`[Server] Speaker config requested: ${data.speaker} (reconnecting client will handle this instead of updateSessionConfig)`);
          ws.send(JSON.stringify({
            type: 'config_success',
            speaker: data.speaker,
          }));
        } else if (data.type === 'speak' && data.text) {
          console.log(`[Server] Client forced TTS: "${data.text}"`);
          await voice.speak(data.text);
        }
      }
    } catch (err: any) {
      console.error('[Server] Error handling client WebSocket message:', err);
    }
  });

  // Clean up Mastra session on socket close
  ws.on('close', async () => {
    console.log('[Server] Client disconnected. Terminating voice session...');
    isConnected = false;
    try {
      await voice.disconnect();
      console.log('[Server] Voice session terminated successfully.');
    } catch (err) {
      console.error('[Server] Error during voice disconnect:', err);
    }
  });
});

// Run the combined server
server.listen(PORT, () => {
  console.log(`[Server] Web application PoC server listening on http://localhost:${PORT}`);
});
