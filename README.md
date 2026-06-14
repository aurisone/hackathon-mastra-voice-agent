# Auris Voice — Gemini 2.5 Real-time Voice Agent Web PoC 🎙️✨

A gorgeous, low-latency, real-time **Speech-to-Speech (STS)** web application proof-of-concept. Powered by the [Mastra AI Framework](https://mastra.ai), a **Node/Express + WebSocket** backend, and Google Cloud **Vertex AI** using the **Gemini 2.5 Flash** model (`gemini-live-2.5-flash-native-audio`).

This PoC moves the voice agent out of the terminal and into a stunning, responsive, dark glassmorphic web browser experience.

---

## 🌟 Key Features

1. **Auris Scribe (Diarized Visit Recorder)**:
   - A specialized medical dictation module! Activated simply by speaking *"Takže Dobrý den..."*.
   - During the Scribe session, the agent stops speaking and instead performs low-latency, real-time speech diarization separating doctor and patient dialogue rows into a dedicated recording container.
   - When finished, speaking *"Tak to je konec"* triggers a structured clinical **Medical Report** and transitions the assistant back to conversation mode.
2. **Organic Voice Assistant Orb Visualizer**:
   - A stunning animated visualizer core that breathes, rotates, pulses, and ripples dynamically depending on the active state of the conversation (Idle, Listening, Thinking, Speaking, Scribe Recording).
   - Modulates wave scaling and drop-shadow depth in real time based on raw microphone amplitude and voice frequency data.
3. **Live Reasoning Console (Chain of Thought)**:
   - Gemini's internal calculation and reasoning processes are captured separately from the voice track and streamed in real time into a collapsible, light clinical monospace terminal drawer, demonstrating the model's exact "thinking process" before it speaks.
4. **Gapless Audio Playback Queue**:
   - Audio chunks (24kHz Mono PCM) from Vertex AI are scheduled sequentially on the high-precision browser `AudioContext` timeline (`audioContext.currentTime`), preventing clicks, pops, or audio gaps.
5. **Instant Barge-in (Interruption)**:
   - Full support for natural interruptions! If you start speaking while the assistant is answering, the browser immediately stops all active audio playback, flushes the player queue, and updates the transcript with `[přerušeno]`, returning instantly to listening mode.
6. **Live Dialogue Transcripts**:
   - Human speech and assistant replies are rendered instantly in beautiful, fluidly appearing chat bubbles with readable typography.
7. **Interactive Tool Card Integration**:
   - Seamless server-side execution of tools (like weather retrieval `getWeather` or visit scheduling `createAurisVisit`) with custom, beautiful frontend card overlays containing live actions.
8. **Mastra Studio & Full Observability**:
   - Centralized logging built on the official Mastra logger. All active tools are registered statically, enabling full tracing of voice agent sessions, tool schemas, and logs on port `4111`.

---

## 📜 Historie Verzí (Version History)

Aplikace byla postupně rozvíjena od jednoduchého hlasového PoC až po plnohodnotný lékařský a diagnostický nástroj s firemní identitou:

### 🔹 v0.1 — Hlasové PoC (Initial STS Voice Agent)
* **Základní Speech-to-Speech (STS)** spojení s modelem Gemini 2.5 Flash přes WebSockets.
* Prvotní zachytávání mikrofonu (16kHz PCM) a plynulé gapless přehrávání audia (24kHz PCM) přes WebAudio API.
* Podpora okamžitého přerušení asistentky (Barge-in).

### 🔹 v0.2 — Interaktivní UI & Integrace Nástrojů (Tool Cards)
* Vytvoření interaktivního **glow vizualizátoru (Voice Assistant Orb)** dýchajícího v reálném čase podle aktivity a stavu řeči.
* Live výpis přepisu konverzace do grafických chatovacích bublin.
* Implementace prvního nástroje na serveru — **předpovědi počasí (`getWeather`)** s grafickým zobrazením výsledkové karty v chatu.

### 🔹 v0.3 — Dynamická Konfigurace & Auris Visit Links
* Možnost **změny barvy hlasu** asistentky (Puck, Aoede, Charon, Fenrir, Kore) za běhu sezení.
* Interaktivní jezdec pro nastavení **kreativity modelu (Temperature)**.
* Druhý simulovaný nástroj — **vytvoření návštěvy pacienta (`createAurisVisit`)**, který do chatu posílá elegantní klinické hluboké odkazy s dynamickými identifikátory.

### 🔹 v0.4 — Zobrazení Myšlenkových Pochodů (Live Reasoning)
* Separátní zachytávání interního uvažování modelu Gemini (Chain of Thought).
* Vývoj **skládací monospace konzole** na pravém panelu, která v reálném čase streamuje myšlenkové kroky modelu ještě před započetím jeho řeči.

### 🔹 v0.5 — Auris Scribe, Firemní UX & Observabilita
* **Režim "Auris Scribe":**
  * Spouští se hlasovým příkazem *"Takže Dobrý den..."* – od té chvíle asistentka pouze naslouchá dialogu lékaře s pacientem a zapisuje real-time přepis včetně **diarizace mluvčích** (Lékař / Pacient) do dedikovaného panelu.
  * Ukončuje se hlasovým příkazem *"Tak to je konec"*, načež asistentka vygeneruje a ukáže finální **strukturovanou lékařskou zprávu** (Medical Report) a přepne se zpět do konverzačního režimu.
* **Přechod na firemní UX identitu (Auris One):**
  * Kompletní změna designu z tmavého herního stylu na **medicínský Light Mode** podle vzoru `aurisone.com`.
  * Integrace firemních fontů **`Open Sans`** a **`Outfit`**, a palety barev (teplý písek `#FAF7F4`, tmavá břidlicová navy `#394E71`, perleťová modř `#B5C5F4`).
  * Elegantní redesign všech tool karet, argumentů, počasí a detailů návštěv do světlých, vysoce čitelných a luxusně stínovaných widgetů.
* **Integrace Mastra Studio & Observability:**
  * Přepsání konzolových výpisů na oficiální Mastra Logger.
  * Statická registrace nástrojů pro bezproblémovou vizualizaci sezení a trasování chování agentů přímo v rozhraní **Mastra Studio** (port `4111`).

### 🔹 v0.6 — SQLite DB & Perzistence Stavů
* **Mastra Studio Úložiště:** Přechod na SQLite databázi `mastra.db` pomocí `LibSQLStore` pro plně persistentní historii vláken, konfigurací a relací.
* Bezpečné ignorování lokálních databázových souborů v `.gitignore`.

### 🔹 v0.7 — Composite Storage & Analytika Metrik
* Konfigurace `MastraCompositeStore` rozdělující domény úložiště: SQLite pro relace/vlákna/konfigurace a `InMemoryStore` pro real-time metriky a telemetrii.

### 🔹 v0.8 & v0.9 — Vlastní SQLite Logovací Proxy & Trasování Relací
* Vývoj inteligentní **JavaScript Proxy** nad LibSQL, která stínuje nepodporované analytické metody pro DuckDB a zabraňuje chybám v Mastra Studiu.
* Vytvoření tabulky `mastra_ai_logs` v SQLite pro bezpečné ukládání logů napříč procesy.
* Logování na úrovni relací (WebSockets) provázané s unikátními ID rozpětí (Spans).

### 🔹 v0.10 — Real-time Počítadlo Tokenů & Ceny (Live Cost Counter)
* Integrace serverového odběru `"usage"` metrik a odesílání statistik spotřeby přes WebSockets.
* Přidání real-time panelu do webového rozhraní zobrazujícího spotřebu v tokenech (vstupní, výstupní, celkové) a odhadovanou cenu v USD v reálném čase.

### 🔹 v0.11 & v0.12 — Real-time SOAP, FHIR Agenti & Diarizace
* Vývoj tří specializovaných klinických agentů: **Extraction Agent** (extrakce informací do FHIR formátu), **Classification Agent** (kódování diagnóz podle ICPC-2 a MKN-10/MKCH-10) a **SOAP Agent** (sestavení strukturovaného zápisu v češtině do HTML).
* Přidání záložek do rozhraní pro interaktivní přepínání mezi SOAP zápisem, FHIR strukturou a lékařskými kódy.
* Vyřešení klientského souběhu a implementace robustní **debounced finalizace replik (turn-finalization)** s 1000ms zpožděním pro maximální přesnost diarizace.

### 🔹 v0.13 — Nativní Mastra Workflows (clinicalWorkflow)
* Převedení klinické pipeline z manuálních asynchronních volání na nativní **Mastra Workflow** (`clinicalWorkflow`).
* Definice robustního DAGu složeného ze kroků `extractionStep`, `classificationStep` a `soapStep`, který se vizualizuje a detailně trasuje pod záložkou "Workflows" v Mastra Studiu.

### 🔹 v0.14 & v0.15 — Oprava chyb zpětné vazby a klientského rozhraní
* Vyřešení chyb typu "This storage provider does not support listing feedback" interceptem metod v Proxy.
* Oprava chyb syntaxe v klientském JS (`public/app.js`), která způsobovala nefunkčnost tlačítek pro ruční ovládání nahrávání a ukončování sezení.

### 🔹 v0.16 — Oprava Gemini Live STT na Vertex AI & Výchozí Konverzační Mód (Aktuální verze)
* **Vertex AI Gemini Live STT Fix:** Implementace elegantního runtime monkey-patchingu na `voice.sendEvent` v backendu pro injektáž explicitních přepisových modelů (`models/gemini-2.0-flash-exp`). Tím se plně zprovoznilo Speech-to-Text v reálném čase v Scribe módu pod platformou GCP Vertex AI.
* **Výchozí Konverzační Mód:** Aplikace je po spuštění automaticky přednastavena do **AI Asistent (Hlasová konverzace)** módu, což umožňuje okamžitou plynulou hlasovou interakci ihned po připojení bez nutnosti ručního přepínání.

---

## 🛠️ Technical Stack

- **Backend**: Node.js, Express, WebSocket (`ws`), TypeScript (`tsc`, `tsx`), `dotenv`.
- **Core Framework**: [Mastra](https://mastra.ai) (`@mastra/core`, `@mastra/voice-google-gemini-live`).
- **Frontend**: HTML5, Vanilla CSS3 (Custom Variables, glassmorphism, animations), Client-side JS (Web Audio API for microphone capture/resampling at 16kHz Mono PCM & scheduled Float32 player queue).
- **Model**: `gemini-live-2.5-flash-native-audio` (configured on Vertex AI regional endpoint `europe-west4`).

---

## 🚀 Installation & Setup

Ensure you have [pnpm](https://pnpm.io/) installed.

### 1. Install Dependencies

Install the required packages:

```bash
pnpm install
```

### 2. Configure Environment Variables

The project uses your local **Application Default Credentials (ADC)** for Vertex AI authentication. Create a `.env` file in the root directory:

```env
GCP_PROJECT=auris-app-dev
GCP_LOCATION=europe-west4
```

> [!IMPORTANT]
> Make sure you are authenticated to Google Cloud on your machine and have run:
> ```bash
> gcloud auth application-default login
> ```
> This populates your local ADC OAuth tokens which the backend server automatically grabs to securely sign its WebSockets to the Vertex AI endpoints.

---

## 🏃‍♂️ How to Run

1. Start the Express web and WebSocket server:
   ```bash
   pnpm start
   ```
2. Open your web browser and navigate to:
   ```
   http://localhost:3000
   ```
3. Click the glowing cyan button **"Připojit & Spustit"** and grant microphone permissions when prompted.
4. Once the status indicator turns green (**"CONNECTED"**), the agent will greet you: **"Ahoj! Jak ti mohu dnes pomoct?"**
5. Start speaking! Speak naturally, choose different voices, expand/collapse the **Reasoning (Chain of Thought)** console, and try interrupting the assistant while it speaks to experience instant barge-in!
