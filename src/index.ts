import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { GeminiLiveVoice } from '@mastra/voice-google-gemini-live';
import dotenv from 'dotenv';
import path from 'path';
import { aurisSystemPrompt } from './prompt.js';

// Import Mastra components and tools
import { mastra, aurisAgent } from './mastra/index.js';
import { setActiveWs, activeWs } from './mastra/session.js';
import { setToolsLogger } from './mastra/tools.js';

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

// Get the default observability instance from Mastra
const telemetryInstance = mastra.observability.getDefaultInstance();
if (!telemetryInstance) {
  throw new Error('Telemetry instance is not initialized on Mastra');
}

// Manage active WebSocket clients and their respective Gemini Live Voice connections
wss.on('connection', async (ws: WebSocket, req) => {
  const requestUrl = new URL(req.url || '', 'http://localhost');
  const speaker = requestUrl.searchParams.get('speaker') || 'Kore';
  const temperatureStr = requestUrl.searchParams.get('temperature') || '0.1';
  const temperature = parseFloat(temperatureStr);
  
  // Set the active WebSocket session for tools to publish updates
  setActiveWs(ws);

  // Start a manual Span for this connection session
  const span = telemetryInstance.startSpan({
    name: 'Auris Voice Session',
    type: 'GENERIC' as any,
  });
  const contextLogger = (telemetryInstance as any).getLoggerContext(span);

  contextLogger.info(`[Server] New client connected. Spawning voice agent session with speaker: ${speaker}, temperature: ${temperature}...`);

  // Retrieve the pre-configured GeminiLiveVoice from our Mastra aurisAgent
  const voice = (aurisAgent as any).voice;

  // Dynamically update speaker/temperature based on client search params
  if (voice.updateSessionConfig) {
    try {
      await voice.updateSessionConfig({
        speaker: speaker,
        temperature: isNaN(temperature) ? 0.1 : temperature,
      });
    } catch (err) {
      contextLogger.warn('[Server] Could not update session configuration:', err);
    }
  }

  let isConnected = false;

  try {
    contextLogger.info('[Server] Connecting to Gemini Live API...');
    await voice.connect();
    isConnected = true;
    contextLogger.info('[Server] Connected successfully to Gemini Live API!');

    // Notify client that the voice session is connected and ready
    ws.send(JSON.stringify({
      type: 'session',
      state: 'connected',
      speaker: speaker,
    }));

    // Start speaking an initial welcome greeting
    contextLogger.info('[Server] Speaking initial greeting...');
    await voice.speak('Ahoj! Jsem Auris One, tvá inteligentní tichá zapisovatelka a AI asistentka. Jak ti mohu dnes pomoct?');

  } catch (error: any) {
    contextLogger.error('[Server] Failed to connect to Gemini Live API:', error);
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
      contextLogger.info(`[Voice Transcript] ${role}: ${text}`);
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
      contextLogger.info(`[Voice Thinking] ${text}`);
      ws.send(JSON.stringify({
        type: 'thinking',
        text,
      }));
    }
  });

  // 4. Interrupts (Barge-in: client spoke over the assistant)
  voice.on('interrupt', (data: any) => {
    contextLogger.info('[Server] User interrupted assistant speaking!');
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
    contextLogger.error('[Server] Gemini Live Voice Error:', err);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'error',
        message: err.message || 'An error occurred during live voice exchange.',
      }));
    }
  });

  // 7. Tool calls (model decided to invoke an external skill)
  voice.on('toolCall', (data: any) => {
    contextLogger.info(`[Server] Model requested tool: ${data.name}`, data.args);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'tool_call',
        name: data.name,
        args: data.args,
        id: data.id,
      }));
    }
  });

  // 8. Model usage statistics (cumulative session token metrics)
  voice.on('usage', (usage: any) => {
    contextLogger.info(`[Server] Model usage update: Input=${usage.inputTokens}, Output=${usage.outputTokens}, Total=${usage.totalTokens}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'usage',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        modality: usage.modality,
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
          try {
            await voice.send(int16Array);
          } catch (sendErr: any) {
            if (sendErr.message && sendErr.message.includes('Not connected')) {
              isConnected = false;
              contextLogger.info('[Server] Voice disconnected asynchronously. Disabling binary audio forwarding.');
            }
            throw sendErr;
          }
        }
      } else {
        // Handle incoming JSON text messages
        const data = JSON.parse(message.toString());
        contextLogger.info('[Server] Received command:', data);

        if (data.type === 'config' && data.speaker) {
          contextLogger.info(`[Server] Speaker config requested: ${data.speaker} (reconnecting client will handle this instead of updateSessionConfig)`);
          ws.send(JSON.stringify({
            type: 'config_success',
            speaker: data.speaker,
          }));
        } else if (data.type === 'speak' && data.text) {
          contextLogger.info(`[Server] Client forced TTS: "${data.text}"`);
          await voice.speak(data.text);
        } else if (data.type === 'scribe_update') {
          contextLogger.info(`[Server] Received scribe dialogue history update, turns: ${data.history?.length || 0}`);
          const history = data.history || [];
          
          // Execute native Mastra Workflow asynchronously so as not to block WS thread
          (async () => {
            try {
              const transcriptText = history
                .map((item: any) => `${item.speaker === 'doctor' ? 'Lékař' : 'Pacient'}: ${item.text}`)
                .join('\n');

              contextLogger.info('[Server] Triggering native Mastra Workflow clinicalWorkflow...');
              
              const workflow = mastra.getWorkflow('clinicalWorkflow');
              const run = await workflow.createRun();
              const result = await run.start({ inputData: { transcriptText } });

              if (result.status !== 'success') {
                throw new Error(result.status === 'failed' ? (result.error?.message || 'Workflow execution failed') : `Workflow did not succeed: status is ${result.status}`);
              }

              const output = result.result as any;

              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: 'soap_update',
                  html: output.html,
                  fhir: output.fhir,
                  codes: output.codes,
                }));
              }
            } catch (pipelineErr: any) {
              contextLogger.error('[Server] Scribe agent pipeline execution failed:', pipelineErr);
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: 'soap_update_error',
                  message: pipelineErr.message || String(pipelineErr),
                }));
              }
            }
          })();
        }
      }
    } catch (err: any) {
      contextLogger.error('[Server] Error handling client WebSocket message:', err);
    }
  });

  // Clean up Mastra session on socket close
  ws.on('close', async () => {
    contextLogger.info('[Server] Client disconnected. Cleaning up socket session...');
    
    // Check if this closing connection is the active session
    if (activeWs === ws) {
      contextLogger.info('[Server] Active connection closed. Terminating active voice session...');
      setActiveWs(null);
      isConnected = false;
      try {
        await voice.disconnect();
        contextLogger.info('[Server] Voice session terminated successfully.');
      } catch (err: any) {
        contextLogger.error('[Server] Error during voice disconnect:', err);
      }
    } else {
      contextLogger.info('[Server] closed old/superseded connection. Keeping newer session active.');
    }

    // Ensure the manual Span is ended and telemetry is pushed immediately to SQLite
    span.end();
    try {
      await telemetryInstance.flush();
    } catch (flushErr) {
      // Ignore flush errors during rapid reconnects
    }
  });
});

// Run the combined server
server.listen(PORT, () => {
  logger.info(`[Server] Web application PoC server listening on http://localhost:${PORT}`);
});
