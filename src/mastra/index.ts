import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { LibSQLStore } from '@mastra/libsql';
import path from 'path';
import { fileURLToPath } from 'url';
import { weatherTool, createAurisVisitTool } from './tools.js';
import { aurisSystemPrompt } from '../prompt.js';

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
});

// Configure the central Mastra instance with our Agent, Tools, and SQLite storage
export const mastra = new Mastra({
  storage: new LibSQLStore({
    id: 'mastra-storage',
    url: dbPath,
  }),
  agents: {
    aurisAgent,
  },
  tools: {
    getWeather: weatherTool,
    createAurisVisit: createAurisVisitTool,
  },
});
