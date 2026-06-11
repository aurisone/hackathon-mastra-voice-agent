import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { GeminiLiveVoice } from '@mastra/voice-google-gemini-live';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import { aurisSystemPrompt } from './prompt.js';

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
  const temperatureStr = requestUrl.searchParams.get('temperature') || '0.1';
  const temperature = parseFloat(temperatureStr);
  console.log(`[Server] New client connected. Spawning voice agent session with speaker: ${speaker}, temperature: ${temperature}...`);

  // Define weather tool inside the connection block to capture this client's specific socket 'ws'
  const weatherTool = createTool({
    id: 'getWeather',
    description: 'Získá aktuální počasí pro zadané město či lokalitu.',
    inputSchema: z.object({
      location: z.string().describe('Název města nebo lokality, pro kterou zjišťuješ počasí (např. "Praha", "Brno")'),
    }),
    outputSchema: z.object({
      temperature: z.number(),
      condition: z.string(),
      humidity: z.number(),
      comment: z.string(),
    }),
    execute: async ({ location }) => {
      console.log(`[Tool: getWeather] Executing mock weather tool for "${location}"`);
      
      const result = {
        temperature: 20,
        condition: 'Slunečno a bezvětří',
        humidity: 45,
        comment: `Ať jsi v lokalitě ${location} nebo kdekoli jinde, v Auris One je vždy krásných 20 stupňů a slunečno!`,
      };

      // Notify the specific client WebSocket immediately that the tool completed execution
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'tool_response',
          name: 'getWeather',
          args: { location },
          result,
        }));
      }

      return result;
    },
  });

  // Define createAurisVisit tool inside connection block to capture 'ws' in closure
  const createAurisVisitTool = createTool({
    id: 'createAurisVisit',
    description: 'Založí novou lékařskou návštěvu v aplikaci Auris One na základě zadaných parametrů (např. spuštěné nahrávání, jméno pacienta, typ návštěvy).',
    inputSchema: z.object({
      visitType: z.string().optional().default('true').describe('ID nebo typ návštěvy. Výchozí je "true" (poslední použitá). Pro sesterskou návštěvu nastav "3".'),
      recording: z.boolean().optional().default(false).describe('Zda má být v aplikaci automaticky zahájeno nahrávání (true/false).'),
      patientName: z.string().optional().describe('Jméno pacienta, kterým se má nově vytvořená návštěva pojmenovat.'),
    }),
    outputSchema: z.object({
      url: z.string(),
      visitType: z.string(),
      recording: z.boolean(),
      patientName: z.string().optional(),
      message: z.string(),
    }),
    execute: async ({ visitType, recording, patientName }) => {
      console.log(`[Tool: createAurisVisit] Building URL: visitType=${visitType}, recording=${recording}, patientName=${patientName}`);
      
      const baseUrl = 'https://app.auris.one/?';
      const params: string[] = [];

      // Add new-visit parameter
      const resolvedVisitType = visitType || 'true';
      params.push(`new-visit=${resolvedVisitType}`);

      // Add recording if true
      if (recording) {
        params.push('recording=true');
      }

      // Add patient name if provided
      if (patientName && patientName.trim()) {
        params.push(`visit-name=${encodeURIComponent(patientName.trim())}`);
      }

      const generatedUrl = baseUrl + params.join('&');
      console.log(`[Tool: createAurisVisit] Generated Deep Link: ${generatedUrl}`);

      const result = {
        url: generatedUrl,
        visitType: resolvedVisitType,
        recording: !!recording,
        patientName: patientName || undefined,
        message: 'Návštěva byla úspěšně připravena k založení v aplikaci Auris One.',
      };

      // Notify the specific client WebSocket immediately of the completed tool execution
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'tool_response',
          name: 'createAurisVisit',
          args: { visitType, recording, patientName },
          result,
        }));
      }

      return result;
    },
  });

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
    await voice.speak('Ahoj! Jsem Auris One, tvůj inteligentní tichý zapisovatel a hlasový asistent. Jak ti mohu dnes pomoct?');

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

  // 7. Tool calls (model decided to invoke an external skill)
  voice.on('toolCall', (data: any) => {
    console.log(`[Server] Model requested tool: ${data.name}`, data.args);
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
