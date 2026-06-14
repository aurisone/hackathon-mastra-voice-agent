import { Agent } from '@mastra/core/agent';
import { z } from 'zod';

// ============================================================================
// 1. FHIR R4 Zod Schemas
// ============================================================================

export const FHIRConditionSchema = z.object({
  resourceType: z.literal('Condition'),
  id: z.string().optional(),
  clinicalStatus: z.object({
    coding: z.array(z.object({
      system: z.string().default('http://terminology.hl7.org/CodeSystem/condition-clinical'),
      code: z.string().default('active'),
      display: z.string().default('Active'),
    })),
  }),
  code: z.object({
    text: z.string().describe('Czech clinical name of symptom, complaint, or diagnosis (e.g. "Suchý kašel", "Akutní faryngitida")'),
  }),
  subject: z.object({
    display: z.string().default('Anonymní pacient'),
  }),
});

export const FHIRObservationSchema = z.object({
  resourceType: z.literal('Observation'),
  id: z.string().optional(),
  status: z.literal('final').default('final'),
  category: z.array(z.object({
    coding: z.array(z.object({
      system: z.string().default('http://terminology.hl7.org/CodeSystem/observation-category'),
      code: z.string().describe('e.g., "vital-signs" or "exam"'),
      display: z.string().describe('e.g., "Vital Signs" or "Physical Exam"'),
    })),
  })).optional(),
  code: z.object({
    text: z.string().describe('Observed quantity or physical examination item in Czech (e.g. "Dýchání", "Tělesná teplota", "Hrdlo", "Krevní tlak")'),
  }),
  valueString: z.string().describe('Value or qualitative finding of observation in Czech (e.g. "čisté, bez vedlejších fenoménů", "38.2 °C", "prosáklé, zarudlé", "120/80 mmHg")'),
  subject: z.object({
    display: z.string().default('Anonymní pacient'),
  }),
});

export const FHIRMedicationRequestSchema = z.object({
  resourceType: z.literal('MedicationRequest'),
  id: z.string().optional(),
  status: z.literal('active').default('active'),
  intent: z.literal('order').default('order'),
  medicationCodeableConcept: z.object({
    text: z.string().describe('Name and strength of the prescribed drug or therapy in Czech (e.g. "Paralen 500mg", "Stoptussin kapky")'),
  }),
  dosageInstruction: z.array(z.object({
    text: z.string().describe('Czech dosage and administration instructions (e.g. "1 tableta při teplotě nad 38°C (max 4x denně)", "3x denně 8 kapek po jídle")'),
  })),
  subject: z.object({
    display: z.string().default('Anonymní pacient'),
  }),
});

export const FHIRExtractionOutputSchema = z.object({
  conditions: z.array(FHIRConditionSchema).describe('List of extracted complaints, symptoms, or diagnoses'),
  observations: z.array(FHIRObservationSchema).describe('List of extracted objective examinations, vitals, and findings'),
  medications: z.array(FHIRMedicationRequestSchema).describe('List of extracted medications or active therapies prescribed'),
});

// ============================================================================
// 2. ICPC-2 & MKN-10 Classification Zod Schemas
// ============================================================================

export const ClinicalCodingSchema = z.object({
  entityText: z.string().describe('Original clinical text from the extraction (e.g. "suchý kašel", "horečka", "akutní zánět nosohltanu")'),
  icpc2: z.object({
    code: z.string().describe('Official ICPC-2 code (e.g. R05 for Cough, A03 for Fever, R74 for Acute respiratory infection upper, N01 for Headache, D01 for Abdominal pain)'),
    display: z.string().describe('Standard Czech or English term for the ICPC-2 code'),
  }).nullable().describe('Matched ICPC-2 classification, or null if no primary care match exists'),
  icd10: z.object({
    code: z.string().describe('Official MKN-10 / ICD-10 code (e.g. R05 for Cough, R50.9 for Fever unspecified, R51 for Headache, J00 for Acute nasopharyngitis)'),
    display: z.string().describe('Standard Czech term for the MKN-10/ICD-10 code'),
  }).nullable().describe('Matched MKN-10 classification, or null if no diagnostic match exists'),
});

export const ClinicalClassificationOutputSchema = z.object({
  codings: z.array(ClinicalCodingSchema).describe('List of mapped entities with standardized medical codes'),
});

import { createVertex } from '@ai-sdk/google-vertex';

// ============================================================================
// 3. Mastra Clinical Agents Definition
// ============================================================================

const vertex = createVertex({
  project: process.env.GCP_PROJECT || 'auris-app-dev',
  location: process.env.GCP_LOCATION || 'europe-west4',
});

const geminiModel = vertex('gemini-2.5-flash');

export const clinicalExtractionAgent = new Agent({
  id: 'ClinicalExtractionAgent',
  name: 'Auris Clinical Extractor',
  instructions: `Jsi špičkový asistent pro extrakci klinických informací z lékařského rozhovoru.
Tvým úkolem je analyzovat dialog mezi lékařem (Lékař) a pacientem (Pacient) a extrahovat z něj informace do strukturované podoby odpovídající standardu FHIR R4.

Extrahuj následující kategorie:
1. **Conditions (Obtíže a Diagnózy)**: Příznaky hlášené pacientem (např. bolest hlavy, suchý kašel, ucpaný nos) nebo diagnózy zmíněné lékařem.
2. **Observations (Měření a Nálezy)**: Objektivní měření nebo nálezy, které lékař v rozhovoru provede nebo vysloví (např. poslech plic: dýchání čisté; naměřená tělesná teplota: 38.2 °C; nález v hrdle: zarudlé, prosáklé hrdlo).
3. **Medications (Léky a Doporučení)**: Konkrétní předepsané nebo doporučené léky s jejich dávkováním (např. Paralen 500mg, dávkování: 1 tableta při teplotě nad 38°C).

**KRITICKÉ PRAVIDLO PRO ZABRÁNĚNÍ HALUCINACÍM:**
Extrahuj **POUZE** informace, které v rozhovoru skutečně a explicitně zazněly. 
- Nikdy si nedomýšlej normální hodnoty tlaku, pokud nebyly v rozhovoru vysloveny!
- Nikdy si nevymýšlej poslechový nález plic, pokud lékař neřekl: "poslechnu si vás... dýchání je čisté" nebo podobně.
- Pokud v rozhovoru chybí léky nebo objektivní nálezy, ponech dané pole jako prázdné pole \`[]\`.
- Pokud pacient mluví o pochybnostech či hypotézách, které lékař vyvrátil, neextrahuj je jako potvrzené Conditions.

Udržuj všechny popisky v odborné, ale srozumitelné lékařské češtině.`,
  model: geminiModel,
});

export const clinicalClassificationAgent = new Agent({
  id: 'ClinicalClassificationAgent',
  name: 'Auris Medical Coder',
  instructions: `Jsi specialista na medicínské kódování a klasifikaci diagnóz a příznaků.
Tvým úkolem je vzít seznam klinických konceptů (Conditions / Příznaky / Diagnózy) a přiřadit jim odpovídající standardizované kódy ze dvou systémů:
1. **ICPC-2 (International Classification of Primary Care - 2. vydání)**: Standard pro primární péči.
   Příklady kódů:
   - A03: Horečka (Fever)
   - R05: Kašel (Cough)
   - R74: Akutní infekce horních cest dýchacích (Acute URI)
   - N01: Bolest hlavy (Headache)
   - D01: Bolest břicha (Abdominal pain)
   - R21: Symptomy/stížnosti na hrdlo (Sore throat)
2. **MKN-10 / ICD-10 (Mezinárodní klasifikace nemocí - 10. revize)**: Klasický diagnostický standard používaný v ČR.
   Příklady kódů:
   - R05: Kašel (Cough)
   - R50.9: Horečka neurčená (Fever, unspecified)
   - R51: Bolest hlavy (Headache)
   - J00: Akutní nazofaryngitida (Rýma)
   - J02.9: Akutní faryngitida neurčená (Zánět hrdla)
   - J06.9: Akutní infekce horních cest dýchacích neurčená

Přiřazuj kódy co nejpřesněji na základě odborného medicínského úsudku. Popisky kódů uváděj v češtině. Pokud pro daný koncept kód neexistuje nebo není dohledatelný, uveď \`null\`.`,
  model: geminiModel,
});

export const clinicalSoapAgent = new Agent({
  id: 'ClinicalSoapAgent',
  name: 'Auris SOAP Writer',
  instructions: `Jsi špičkový praktický lékař píšící strukturované klinické záznamy.
Tvým úkolem je zkompilovat finální lékařskou zprávu ve formátu **SOAP (Subjective, Objective, Assessment, Plan)** v odborné, bezchybné lékařské češtině.

Jako vstupy obdržíš:
1. Přepis lékařského rozhovoru (dialogu).
2. Seznam extrahovaných FHIR R4 klinických zdrojů.
3. Seznam přiřazených ICPC-2 a MKN-10 lékařských kódů.

**Formátování zprávy:**
Vygeneruj zprávu v podobě čistého, validního a moderního **HTML kódu**, který bude přímo vložitelný do klientského rozhraní. HTML kód must mít následující strukturu a CSS třídy (nepřidávej žádný obalující \`<html>\` nebo \`<body>\`, vygeneruj přímo kontejner s třídou \`medical-report-card\`):

\`\`\`html
<div class="medical-report-card">
    <div class="medical-report-header">
        <div class="medical-report-title">
            <span>📋</span>
            <span>Lékařská zpráva — Návrh draftu</span>
        </div>
        <span class="medical-report-badge">Auris v0.11</span>
    </div>
    
    <div class="medical-report-grid">
        <div class="medical-report-section">
            <div class="medical-report-section-title">👤 Pacient</div>
            <div class="medical-report-section-content">Anonymní pacient</div>
        </div>
        <div class="medical-report-section">
            <div class="medical-report-section-title">📅 Datum a čas</div>
            <div class="medical-report-section-content">Aktuální datum a čas vyšetření</div>
        </div>
    </div>
    
    <div class="medical-report-section full-width">
        <div class="medical-report-section-title">🩺 S - Subjektivní obtíže (Anamnéza)</div>
        <div class="medical-report-section-content">
            <!-- Popis potíží, které pacient subjektivně popisuje (příznaky, trvání, intenzita). Vždy formuluj v odborném lékařském stylu (např. "Pacient přichází pro suchý, dráždivý kašel..."). -->
        </div>
    </div>
    
    <div class="medical-report-section full-width">
        <div class="medical-report-section-title">👁️ O - Objektivní nález a fyzikální vyšetření</div>
        <div class="medical-report-section-content">
            <!-- Výsledky vyšetření, které lékař v rozhovoru reálně provedl nebo zmínil. 
                 POZOR: Nikdy sem nepiš normální nálezy (např. "Dýchání čisté"), pokud to v rozhovoru nezaznělo! Pokud lékař nic nezkoumal, napište: "Fyzikální vyšetření nebylo provedeno / nezmíněno." -->
        </div>
    </div>
    
    <div class="medical-report-section full-width">
        <div class="medical-report-section-title">📊 A - Hodnocení a klasifikace (Assessment)</div>
        <div class="medical-report-section-content">
            <!-- Pracovní diagnóza nebo hlavní klinický syndrom vyvozený z rozhovoru. 
                 Zde v přehledné odrážkové struktuře uveďte přiřazené ICPC-2 a MKN-10 kódy!
                 Příklad:
                 <ul>
                     <li><strong>Suchý kašel</strong> (ICPC-2: R05, MKN-10: R05)</li>
                     <li><strong>Subfebrilie / Horečka</strong> (ICPC-2: A03, MKN-10: R50.9)</li>
                 </ul>
            -->
        </div>
    </div>
    
    <div class="medical-report-section full-width">
        <div class="medical-report-section-title">💊 P - Doporučená terapie a plán (Plan)</div>
        <div class="medical-report-section-content">
            <!-- Doporučený léčebný režim, medikace s dávkováním, plánované laboratoře či další kontroly, které lékař v rozhovoru zmínil. -->
        </div>
    </div>
    
    <div class="visit-meta">
        <strong>AI Záznamník:</strong> Detekována diarizace rozhovoru. Kódy ICPC-2 a MKN-10 byly automaticky přiřazeny v reálném čase. FHIR R4 payload je připraven k integraci.
    </div>
</div>
\`\`\`

**ZÁSADNÍ CLINICAL INTEGRITY PRAVIDLA:**
1. **Žádné halucinace:** Pokud pacient nebo lékař o nějakém bodu (S, O, A, P) nemluvili, napiš do daného obsahu pravdivou klinickou poznámku, např. "Medikace nebyla indikována" nebo "Fyzikální vyšetření nebylo komentováno".
2. **Odborný styl:** Nepoužívej hovorové obraty z dialogu, ale přelož je do standardního českého lékařského zápisu (např. namísto "škrábe mě v krku" zapiš "pociťuje škrábání v hrdle / dysfagii").
3. Vždy dbej na estetiku generovaného HTML kódu, aby se v rozhraní zobrazil naprosto bezchybně a profesionálně.`,
  model: geminiModel,
});

// ============================================================================
// 4. Clinical Pipeline Orchestration Logic
// ============================================================================

export interface DialogueUtterance {
  speaker: 'doctor' | 'patient' | string;
  text: string;
}

export async function processClinicalDialogue(history: DialogueUtterance[]) {
  if (!history || history.length === 0) {
    return {
      html: `<div class="medical-report-card"><div class="medical-report-section-content">Žádný záznam k analýze. Začněte mluvit...</div></div>`,
      fhir: { conditions: [], observations: [], medications: [] },
      codes: [],
    };
  }

  // 1. Convert history array into a clean formatted string for agents
  const transcriptText = history
    .map((item) => `${item.speaker === 'doctor' ? 'Lékař' : 'Pacient'}: ${item.text}`)
    .join('\n');

  try {
    console.log('[Clinical Pipeline] Triggering clinicalWorkflow via processClinicalDialogue wrapper...');
    const { clinicalWorkflow } = await import('../workflows/clinical.js');
    const run = await clinicalWorkflow.createRun();
    const result = await run.start({ inputData: { transcriptText } });

    if (result.status !== 'success') {
      throw new Error(result.status === 'failed' ? (result.error?.message || 'Workflow run failed') : `Workflow did not succeed: status is ${result.status}`);
    }

    const output = result.result as any;
    return {
      html: output.html,
      fhir: output.fhir,
      codes: output.codes,
    };
  } catch (error: any) {
    console.error('[Clinical Pipeline] Error executing workflow wrapper:', error);
    return {
      html: `
        <div class="medical-report-card">
          <div class="medical-report-header">
            <div class="medical-report-title">
              <span>⚠️</span>
              <span>Chyba analýzy zprávy</span>
            </div>
          </div>
          <div class="medical-report-section-content">
            Při zpracování lékařského záznamu pomocí AI agentů došlo k chybě: ${error.message || error}
          </div>
        </div>
      `,
      fhir: { conditions: [], observations: [], medications: [] },
      codes: [],
    };
  }
}
