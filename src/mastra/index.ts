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
import crypto from 'crypto';

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

// Create a robust Proxy wrapper for LibSQL observability to safely intercept
// unsupported OLAP features (metrics, entity discovery) and return safe default values,
// while implementing a custom SQLite log store inside mastra_ai_logs.
const proxiedObservability = new Proxy(observabilityStore, {
  get(target, prop, receiver) {
    if (prop === 'init') {
      return async (...args: any[]) => {
        const initFn = Reflect.get(target, prop, receiver);
        if (typeof initFn === 'function') {
          await (initFn as any).apply(target, args);
        }
        // Initialize our custom SQLite log table
        await (persistentStore as any).client.execute(`
          CREATE TABLE IF NOT EXISTS mastra_ai_logs (
            logId TEXT PRIMARY KEY,
            traceId TEXT,
            spanId TEXT,
            message TEXT NOT NULL,
            level TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            serviceName TEXT,
            environment TEXT,
            data TEXT,
            metadata TEXT,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP
          )
        `);
      };
    }
    if (prop === 'batchCreateLogs') {
      return async (args: any) => {
        const logs = args?.logs || [];
        for (const log of logs) {
          const logId = log.logId || crypto.randomUUID();
          await (persistentStore as any).client.execute({
            sql: `
              INSERT OR REPLACE INTO mastra_ai_logs (
                logId, traceId, spanId, message, level, timestamp, serviceName, environment, data, metadata
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            args: [
              logId,
              log.traceId || null,
              log.spanId || null,
              log.message,
              log.level,
              new Date(log.timestamp).toISOString(),
              log.serviceName || null,
              log.environment || null,
              log.data ? JSON.stringify(log.data) : null,
              log.metadata ? JSON.stringify(log.metadata) : null,
            ],
          });
        }
      };
    }
    if (prop === 'listLogs') {
      return async (args: any) => {
        console.log('[Mastra Observability Proxy] listLogs called with args:', JSON.stringify(args, null, 2));

        // Mastra Studio pagination is 0-indexed. Safe handling prevents negative offsets which crash SQLite.
        const page = args?.pagination?.page ?? 0;
        const perPage = args?.pagination?.perPage ?? 50;
        const offset = Math.max(0, page * perPage);

        let sql = `SELECT * FROM mastra_ai_logs`;
        const conditions: string[] = [];
        const sqlArgs: any[] = [];

        if (args?.filters?.traceId) {
          conditions.push(`traceId = ?`);
          sqlArgs.push(args.filters.traceId);
        }
        if (args?.filters?.spanId) {
          conditions.push(`spanId = ?`);
          sqlArgs.push(args.filters.spanId);
        }
        if (args?.filters?.serviceName) {
          conditions.push(`serviceName = ?`);
          sqlArgs.push(args.filters.serviceName);
        }
        if (args?.filters?.environment) {
          conditions.push(`environment = ?`);
          sqlArgs.push(args.filters.environment);
        }
        if (args?.filters?.level) {
          if (Array.isArray(args.filters.level)) {
            if (args.filters.level.length > 0) {
              const placeholders = args.filters.level.map(() => '?').join(', ');
              conditions.push(`level IN (${placeholders})`);
              sqlArgs.push(...args.filters.level);
            }
          } else {
            conditions.push(`level = ?`);
            sqlArgs.push(args.filters.level);
          }
        }
        if (args?.filters?.timestamp) {
          const { start, end, startExclusive, endExclusive } = args.filters.timestamp;
          if (start) {
            const op = startExclusive ? '>' : '>=';
            conditions.push(`timestamp ${op} ?`);
            sqlArgs.push(new Date(start).toISOString());
          }
          if (end) {
            const op = endExclusive ? '<' : '<=';
            conditions.push(`timestamp ${op} ?`);
            sqlArgs.push(new Date(end).toISOString());
          }
        }

        if (conditions.length > 0) {
          sql += ` WHERE ` + conditions.join(` AND `);
        }

        sql += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
        
        // Exact copy of current arguments for count query before appending limit/offset
        const countSqlArgs = [...sqlArgs];
        
        sqlArgs.push(perPage, offset);

        let countSql = `SELECT COUNT(*) as total FROM mastra_ai_logs`;
        if (conditions.length > 0) {
          countSql += ` WHERE ` + conditions.join(` AND `);
        }

        try {
          const countRes = await (persistentStore as any).client.execute({
            sql: countSql,
            args: countSqlArgs,
          });
          const total = Number(countRes.rows[0]?.total ?? 0);

          const res = await (persistentStore as any).client.execute({ sql, args: sqlArgs });

          const logs = res.rows.map((row: any) => ({
            logId: row.logId,
            traceId: row.traceId,
            spanId: row.spanId,
            message: row.message,
            level: row.level,
            timestamp: new Date(row.timestamp),
            serviceName: row.serviceName,
            environment: row.environment,
            data: row.data ? JSON.parse(row.data) : null,
            metadata: row.metadata ? JSON.parse(row.metadata) : null,
          }));

          console.log(`[Mastra Observability Proxy] listLogs returning ${logs.length} logs of ${total} total`);

          return {
            logs,
            pagination: {
              total,
              page,
              perPage,
              hasMore: offset + logs.length < total,
            },
          };
        } catch (err: any) {
          console.error('[Mastra Observability Proxy] listLogs error:', err);
          return {
            logs: [],
            pagination: {
              total: 0,
              page,
              perPage,
              hasMore: false,
            },
          };
        }
      };
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
