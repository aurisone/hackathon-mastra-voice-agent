import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { MastraCompositeStore } from '@mastra/core/storage';
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

const observabilityStore = persistentStore.stores.observability;
if (!observabilityStore) {
  throw new Error('LibSQLStore observability storage is not initialized');
}

// A minimal, robust Proxy wrapper to intercept unsupported OLAP methods in LibSQLStore
// and return safe default values, completely preventing 500 errors in Mastra Studio.
const proxiedObservability = new Proxy(observabilityStore, {
  get(target, prop, receiver) {
    if (prop === 'listLogs') {
      return async (args: any) => {
        const page = args?.pagination?.page ?? 1;
        const perPage = args?.pagination?.perPage ?? 50;
        return {
          logs: [],
          pagination: {
            total: 0,
            page,
            perPage,
            hasMore: false,
          },
        };
      };
    }
    if (prop === 'batchCreateLogs') {
      return async () => {};
    }
    if (prop === 'getEntityNames') {
      return async () => ({ names: [] });
    }
    if (prop === 'getEntityTypes') {
      return async () => ({ entityTypes: [] });
    }
    if (prop === 'getServiceNames') {
      return async () => ({ serviceNames: [] });
    }
    if (prop === 'getEnvironments') {
      return async () => ({ environments: [] });
    }
    if (prop === 'getTags') {
      return async () => ({ tags: [] });
    }
    if (prop === 'getMetricNames') {
      return async () => ({ names: [] });
    }
    if (prop === 'getMetricLabelKeys') {
      return async () => ({ keys: [] });
    }
    if (prop === 'getMetricLabelValues') {
      return async () => ({ values: [] });
    }
    if (prop === 'getMetricAggregate') {
      return async () => ({ value: null });
    }
    if (prop === 'getMetricBreakdown') {
      return async () => ({ groups: [] });
    }
    if (prop === 'getMetricTimeSeries') {
      return async () => ({ series: [] });
    }
    if (prop === 'getMetricPercentiles') {
      return async () => ({ series: [] });
    }
    if (prop === 'listMetrics') {
      return async () => ({ metrics: [] });
    }
    if (prop === 'batchCreateMetrics') {
      return async () => {};
    }

    const value = Reflect.get(target, prop, receiver);
    if (typeof value === 'function') {
      return value.bind(target);
    }
    return value;
  },
});

// Configure the central Mastra instance with our Agent, Tools, and SQLite storage
export const mastra = new Mastra({
  storage: new MastraCompositeStore({
    id: 'mastra-composite-storage',
    default: persistentStore,
    domains: {
      observability: proxiedObservability as any,
    },
  }),
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
