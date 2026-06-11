import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { activeWs } from './session.js';

let logger: any = null;

export function setToolsLogger(l: any) {
  logger = l;
}

export const weatherTool = createTool({
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
    if (logger) {
      logger.info(`[Tool: getWeather] Executing mock weather tool for "${location}"`);
    } else {
      console.log(`[Tool: getWeather] Executing mock weather tool for "${location}"`);
    }
    
    const result = {
      temperature: 20,
      condition: 'Slunečno a bezvětří',
      humidity: 45,
      comment: `Ať jsi v lokalitě ${location} nebo kdekoli jinde, v Auris One je vždy krásných 20 stupňů a slunečno!`,
    };

    if (activeWs && activeWs.readyState === 1 /* WebSocket.OPEN */) {
      activeWs.send(JSON.stringify({
        type: 'tool_response',
        name: 'getWeather',
        args: { location },
        result,
      }));
    }

    return result;
  },
});

export const createAurisVisitTool = createTool({
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
    if (logger) {
      logger.info(`[Tool: createAurisVisit] Building URL: visitType=${visitType}, recording=${recording}, patientName=${patientName}`);
    } else {
      console.log(`[Tool: createAurisVisit] Building URL: visitType=${visitType}, recording=${recording}, patientName=${patientName}`);
    }
    
    const baseUrl = 'https://app.auris.one/?';
    const params: string[] = [];

    const resolvedVisitType = visitType || 'true';
    params.push(`new-visit=${resolvedVisitType}`);

    if (recording) {
      params.push('recording=true');
    }

    if (patientName && patientName.trim()) {
      params.push(`visit-name=${encodeURIComponent(patientName.trim())}`);
    }

    const generatedUrl = baseUrl + params.join('&');
    if (logger) {
      logger.info(`[Tool: createAurisVisit] Generated Deep Link: ${generatedUrl}`);
    } else {
      console.log(`[Tool: createAurisVisit] Generated Deep Link: ${generatedUrl}`);
    }

    const result = {
      url: generatedUrl,
      visitType: resolvedVisitType,
      recording: !!recording,
      patientName: patientName || undefined,
      message: 'Návštěva byla úspěšně připravena k založení v aplikaci Auris One.',
    };

    if (activeWs && activeWs.readyState === 1 /* WebSocket.OPEN */) {
      activeWs.send(JSON.stringify({
        type: 'tool_response',
        name: 'createAurisVisit',
        args: { visitType, recording, patientName },
        result,
      }));
    }

    return result;
  },
});
