# Hackathon Mastra Voice Agent 🎙️

A real-time, low-latency **Speech-to-Speech (STS)** assistant built using the [Mastra AI Framework](https://mastra.ai) and Google Cloud **Vertex AI** with the **Gemini 2.5 Flash** model.

## Features

- **Real-time Bidirectional Audio**: Continuous, bidirectional communication using the Gemini Live API.
- **Google Vertex AI**: Powered by enterprise-grade Gemini 2.5 Flash on Google Cloud, configured for European deployment (`europe-west3`).
- **Local Audio I/O**: Captures microphone input and plays back assistant responses directly on your local system using `@mastra/node-audio`.

---

## Technical Stack

- **Core Framework**: [Mastra](https://mastra.ai)
- **Live Voice Provider**: `@mastra/voice-google-gemini-live` (GeminiLiveVoice)
- **Audio Capturing & Playback**: `@mastra/node-audio`
- **Model**: `gemini-2.5-flash`
- **Language**: TypeScript / Node.js ES Modules

---

## Installation & Setup

Ensure you have [pnpm](https://pnpm.io/) installed.

### 1. Install Dependencies

Install the Mastra voice package and other required modules:

```bash
pnpm install
```

### 2. Configure Environment Variables

The project uses your local **Application Default Credentials (ADC)** for Vertex AI. You only need to set the project and location details in a `.env` file in the root directory:

Create a `.env` file:
```env
GCP_PROJECT=auris-app-dev
GCP_LOCATION=europe-west3
```

> [!NOTE]
> Make sure you are authenticated to Google Cloud on your machine and have run:
> ```bash
> gcloud auth application-default login
> ```

---

## How to Run

Start the real-time Speech-to-Speech agent loop:

```bash
pnpm start
```

### What to Expect

1. The script will initialize the agent and connect to the Gemini Live socket.
2. The agent will greet you with: **"Ahoj! Jak ti mohu dnes pomoct?"**
3. Speak into your microphone. The agent will transcribe your speech, print it to the console, and answer you immediately through your system speakers.
