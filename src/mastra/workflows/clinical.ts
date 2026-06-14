import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import {
  clinicalExtractionAgent,
  clinicalClassificationAgent,
  clinicalSoapAgent,
  FHIRExtractionOutputSchema,
  ClinicalClassificationOutputSchema,
} from '../agents/clinical.js';

// Define Step 1: extractionStep
const extractionStep = createStep({
  id: 'extractionStep',
  inputSchema: z.object({
    transcriptText: z.string(),
  }),
  outputSchema: FHIRExtractionOutputSchema,
  execute: async ({ inputData }) => {
    console.log('[Clinical Workflow] Running Extraction Step...');
    const response = await clinicalExtractionAgent.generate(
      `Analyzuj následující přepis klinického rozhovoru a extrahuj Conditions, Observations a Medications podle schématu:\n\n${inputData.transcriptText}`,
      {
        structuredOutput: {
          schema: FHIRExtractionOutputSchema,
        },
      }
    );

    if (!response.object) {
      throw new Error('Extraction response did not return a structured object');
    }

    console.log('[Clinical Workflow] Extraction successful. Conditions count:', response.object.conditions?.length || 0);
    return response.object as any;
  },
});

// Define Step 2: classificationStep
const classificationStep = createStep({
  id: 'classificationStep',
  inputSchema: z.any().optional(),
  outputSchema: ClinicalClassificationOutputSchema,
  execute: async ({ getStepResult }) => {
    console.log('[Clinical Workflow] Running Classification Step...');

    const extractionResult = getStepResult<z.infer<typeof FHIRExtractionOutputSchema>>('extractionStep');
    if (!extractionResult) {
      throw new Error('Extraction result not found in workflow context');
    }

    const codableEntities: string[] = [];
    extractionResult.conditions?.forEach((c) => {
      if (c.code?.text) codableEntities.push(c.code.text);
    });
    extractionResult.observations?.forEach((o) => {
      if (o.code?.text) codableEntities.push(o.code.text);
    });

    let classifiedCodes: any[] = [];
    if (codableEntities.length > 0) {
      console.log('[Clinical Workflow] Classifying entities:', codableEntities);
      const response = await clinicalClassificationAgent.generate(
        `Přiřaď ICPC-2 a MKN-10 kódy k následujícím extrahovaným klinickým pojmům:\n${JSON.stringify(codableEntities, null, 2)}`,
        {
          structuredOutput: {
            schema: ClinicalClassificationOutputSchema,
          },
        }
      );
      if (response.object?.codings) {
        classifiedCodes = response.object.codings;
      }
    } else {
      console.log('[Clinical Workflow] Skipping classification (no codable entities found).');
    }

    return { codings: classifiedCodes };
  },
});

// Define Step 3: soapStep
const soapStep = createStep({
  id: 'soapStep',
  inputSchema: z.any().optional(),
  outputSchema: z.object({
    html: z.string(),
    fhir: FHIRExtractionOutputSchema,
    codes: z.array(z.any()),
  }),
  execute: async ({ getStepResult }) => {
    console.log('[Clinical Workflow] Running SOAP Writer Step...');

    const triggerInput = getStepResult<{ transcriptText: string }>('trigger');
    const extractionResult = getStepResult<z.infer<typeof FHIRExtractionOutputSchema>>('extractionStep');
    const classificationResult = getStepResult<{ codings: any[] }>('classificationStep');

    const transcriptText = triggerInput?.transcriptText || '';
    const fhirResources = extractionResult || { conditions: [], observations: [], medications: [] };
    const classifiedCodes = classificationResult?.codings || [];

    const response = await clinicalSoapAgent.generate(
      `Zkompiluj finální lékařskou zprávu (HTML kontejner) na základě následujících vstupů:
      
### 1. Přepis klinického rozhovoru:
${transcriptText}

### 2. Extrahované FHIR R4 zdroje:
${JSON.stringify(fhirResources, null, 2)}

### 3. Klasifikované medicínské kódy (ICPC-2 & MKN-10):
${JSON.stringify(classifiedCodes, null, 2)}

Zajisti splnění všech pravidel ohledně zabránění halucinacím a formátování HTML.`
    );

    return {
      html: response.text || '',
      fhir: fhirResources,
      codes: classifiedCodes,
    };
  },
});

// Compose the Workflow DAG sequentially: Extraction -> Classification -> SOAP Compilation
export const clinicalWorkflow = createWorkflow({
  id: 'clinicalWorkflow',
  inputSchema: z.object({
    transcriptText: z.string(),
  }),
  outputSchema: z.object({
    html: z.string(),
    fhir: FHIRExtractionOutputSchema,
    codes: z.array(z.any()),
  }),
})
  .then(extractionStep)
  .then(classificationStep)
  .then(soapStep)
  .commit();
