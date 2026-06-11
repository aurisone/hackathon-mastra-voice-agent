# Auris Voice — Gemini 2.5 Real-time Voice Agent Web PoC 🎙️✨

A gorgeous, low-latency, real-time **Speech-to-Speech (STS)** web application proof-of-concept. Powered by the [Mastra AI Framework](https://mastra.ai), a **Node/Express + WebSocket** backend, and Google Cloud **Vertex AI** using the **Gemini 2.5 Flash** model (`gemini-live-2.5-flash-native-audio`).

This PoC moves the voice agent out of the terminal and into a stunning, responsive, dark glassmorphic web browser experience.

---

## 🌟 Key Features

1. **Glow Voice Orb Visualizer**:
   - A futuristic interactive core that breathes, rotates, pulses, and ripples dynamically depending on the current state of the conversation.
   - Modulates outer shadow glow and size in real time based on both your microphone amplitude (when listening) and the assistant's voice frequency analyser (when speaking).
2. **Gapless Audio Playback Queue**:
   - Audio chunks (24kHz Mono PCM) from Vertex AI are scheduled sequentially on the high-precision browser `AudioContext` timeline (`audioContext.currentTime`), preventing clicks, pops, or audio gaps.
3. **Instant Barge-in (Interruption)**:
   - Full support for natural interruptions! If you start speaking while the assistant is answering, the browser immediately stops all active audio playback, flushes the schedule queue, and updates the transcript with `[přerušeno]`, returning instantly to listening mode.
4. **Live Dialogue Transcript**:
   - Your speech and the assistant's responses are rendered in real time into gorgeous, fluidly appearing chat bubbles (`Já` and `Hlasový asistent`).
5. **Reasoning Console (Chain of Thought)**:
   - Since we are using the `native-audio` model, Gemini's internal "thinking" or reasoning process is streamed separately from the voice track. This is rendered in real time inside a collapsible terminal drawer, showing you exactly how the model is calculating its answers.
6. **Live Speaker Changer**:
   - Instantly change the assistant's personality and voice timbre (Puck, Aoede, Charon, Fenrir, Kore) using a dropdown menu. The server dynamically updates Mastra's active session configuration mid-conversation.

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
