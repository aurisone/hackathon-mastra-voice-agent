import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { GeminiLiveVoice } from '@mastra/voice-google-gemini-live';
import dotenv from 'dotenv';
import path from 'path';
import { aurisSystemPrompt } from './prompt.js';

// Import Mastra components and tools
import { mastra } from './mastra/index.js';
import { setActiveWs } from './mastra/session.js';
import { weatherTool, createAurisVisitTool, setToolsLogger } from './mastra/tools.js';

// Load environment variables from .env file
dotenv.config();

const project = process.env.GCP_PROJECT || 'auris-app-dev';
const location = process.env.GCP_LOCATION || 'europe-west4';
const PORT = process.env.PORT || 3000;

if (!project) {
  console.error('Error: GCP_PROJECT is not set in environment variables or .env file.');
  process.exit(1);
}

// Get the mastra logger instance for full logging inside Mastra Studio
const logger = mastra.getLogger();

// Wire up the central logger to the tools module
setToolsLogger(logger);

logger.info('=========================================================');
logger.info('Starting Mastra Speech-to-Speech (STS) Web Server');
logger.info(` - GCP Project:  ${project}`);
logger.info(` - GCP Location: ${location}`);
logger.info(` - Model:        gemini-live-2.5-flash-native-audio`);
logger.info(` - Web App URL:  http://localhost:${PORT}`);
logger.info('=========================================================');

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
  const temperatureStr = requestUrl.searchParams.get('temperature') || '0.1';
  const temperature = parseFloat(temperatureStr);
  
  // Set the active WebSocket session for tools to publish updates
  setActiveWs(ws);

  logger.info(`[Server] New client connected. Spawning voice agent session with speaker: ${speaker}, temperature: ${temperature}...`);

  // Initialize a dedicated Gemini Live Voice instance for this client
  const voice = new GeminiLiveVoice({
    vertexAI: true,
    project,
    location,
    model: 'gemini-live-2.5-flash-native-audio' as any,
    speaker: speaker, // Set the speaker initially based on client preference
    instructions: aurisSystemPrompt,
    temperature: isNaN(temperature) ? 0.1 : temperature,
    debug: true,
  } as any) as any;

  // Add the tools and enforce instructions
  voice.addTools({
    getWeather: weatherTool,
    createAurisVisit: createAurisVisitTool,
  });
  voice.addInstructions(aurisSystemPrompt);

  let isConnected = false;

  try {
    logger.info('[Server] Connecting to Gemini Live API...');
    await voice.connect();
    isConnected = true;
    logger.info('[Server] Connected successfully to Gemini Live API!');

    // Notify client that the voice session is connected and ready
    ws.send(JSON.stringify({
      type: 'session',
      state: 'connected',
      speaker: 'Puck',
    }));

    // Start speaking an initial welcome greeting
    logger.info('[Server] Speaking initial greeting...');
    await voice.speak('Ahoj! Jsem Auris One, tvůj inteligentní tichý zapisovatel a hlasový asistent. Jak ti mohu dnes pomoct?');

  } catch (error: any) {
    logger.error('[Server] Failed to connect to Gemini Live API:', error);
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
      // Log transcript to Mastra logger so it's fully inspectable in Mastra Studio
      logger.info(`[Voice Transcript] ${role}: ${text}`);
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
      logger.info(`[Voice Thinking] ${text}`);
      ws.send(JSON.stringify({
        type: 'thinking',
        text,
      }));
    }
  });

  // 4. Interrupts (Barge-in: client spoke over the assistant)
  voice.on('interrupt', (data: any) => {
    logger.info('[Server] User interrupted assistant speaking!');
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
    logger.error('[Server] Gemini Live Voice Error:', err);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'error',
        message: err.message || 'An error occurred during live voice exchange.',
      }));
    }
  });

  // 7. Tool calls (model decided to invoke an external skill)
  voice.on('toolCall', (data: any) => {
    logger.info(`[Server] Model requested tool: ${data.name}`, data.args);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'tool_call',
        name: data.name,
        args: data.args,
        id: data.id,
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
        logger.info('[Server] Received command:', data);

        if (data.type === 'config' && data.speaker) {
          logger.info(`[Server] Speaker config requested: ${data.speaker} (reconnecting client will handle this instead of updateSessionConfig)`);
          ws.send(JSON.stringify({
            type: 'config_success',
            speaker: data.speaker,
          }));
        } else if (data.type === 'speak' && data.text) {
          logger.info(`[Server] Client forced TTS: "${data.text}"`);
          await voice.speak(data.text);
        }
      }
    } catch (err: any) {
      logger.error('[Server] Error handling client WebSocket message:', err);
    }
  });

  // Clean up Mastra session on socket close
  ws.on('close', async () => {
    logger.info('[Server] Client disconnected. Terminating voice session...');
    setActiveWs(null);
    isConnected = false;
    try {
      await voice.disconnect();
      logger.info('[Server] Voice session terminated successfully.');
    } catch (err: any) {
      logger.error('[Server] Error during voice disconnect:', err);
    }
  });
});

// Run the combined server
server.listen(PORT, () => {
  logger.info(`[Server] Web application PoC server listening on http://localhost:${PORT}`);
});
