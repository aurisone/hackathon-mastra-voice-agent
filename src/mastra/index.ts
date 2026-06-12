import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { LibSQLStore } from '@mastra/libsql';
import { Observability, MastraStorageExporter } from '@mastra/observability';
import path from 'path';
import { fileURLToPath } from 'url';
import { weatherTool, createAurisVisitTool } from './tools.js';
import { aurisSystemPrompt } from '../prompt.js';
import { GeminiLiveVoice } from '@mastra/voice-google-gemini-live';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = `file:${path.resolve(__dirname, '../../mastra.db')}`;

// Define a dedicated Mastra Agent so it shows up beautifully inside Mastra Studio
export const aurisAgent = new Agent({
  id: 'AurisOneAgent',
  name: 'Auris One Voice Agent',
  instructions: aurisSystemPrompt,
  model: {
    id: 'google/gemini-2.5-flash',
  },
  tools: {
    getWeather: weatherTool,
    createAurisVisit: createAurisVisitTool,
  },
  voice: new GeminiLiveVoice({
    vertexAI: true,
    project: process.env.GCP_PROJECT || 'auris-app-dev',
    location: process.env.GCP_LOCATION || 'europe-west4',
    model: 'gemini-live-2.5-flash-native-audio' as any,
    speaker: 'Kore',
    instructions: aurisSystemPrompt,
    debug: true,
  } as any) as any,
});

const persistentStore = new LibSQLStore({
  id: 'mastra-sqlite',
  url: dbPath,
});

// Configure the central Mastra instance with our Agent, Tools, and SQLite storage
export const mastra = new Mastra({
  storage: persistentStore,
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'AurisOneVoiceAgent',
        exporters: [new MastraStorageExporter()],
        logging: {
          enabled: true,
          level: 'info',
        },
      },
    },
  }),
  agents: {
    aurisAgent,
  },
  tools: {
    getWeather: weatherTool,
    createAurisVisit: createAurisVisitTool,
  },
});
