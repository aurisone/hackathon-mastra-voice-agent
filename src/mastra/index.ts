import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { weatherTool, createAurisVisitTool } from './tools.js';
import { aurisSystemPrompt } from '../prompt.js';

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

// Configure the central Mastra instance with our Agent and Tools
export const mastra = new Mastra({
  agents: {
    aurisAgent,
  },
  tools: {
    getWeather: weatherTool,
    createAurisVisit: createAurisVisitTool,
  },
});
