import { Agent } from '@mastra/core/agent';
import { GeminiLiveVoice } from '@mastra/voice-google-gemini-live';
import { playAudio, getMicrophoneStream } from '@mastra/node-audio';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

const project = process.env.GCP_PROJECT || 'auris-app-dev';
const location = process.env.GCP_LOCATION || 'europe-west3';

if (!project) {
  console.error('Error: GCP_PROJECT is not set in environment variables or .env file.');
  process.exit(1);
}

console.log('=========================================================');
console.log('Starting Mastra Speech-to-Speech (STS) Agent');
console.log(` - GCP Project:  ${project}`);
console.log(` - GCP Location: ${location}`);
console.log(` - Model:        gemini-2.5-flash`);
console.log('=========================================================');

// Initialize Mastra Agent with Gemini Live Voice
const agent = new Agent({
  id: 'gemini-live-agent',
  name: 'Gemini Live Agent',
  instructions: 'You are a helpful, brief, and friendly voice assistant. Always answer concisely and clearly.',
  model: 'google/gemini-2.5-flash',
  voice: new GeminiLiveVoice({
    vertexAI: true,
    project,
    location,
    model: 'gemini-2.5-flash' as any, // Cast to 'any' to bypass strict model type definitions
    speaker: 'Puck', // Available speakers: Puck, Aoede, Charon, Fenrir, Kore
    debug: true,
  }) as any, // Cast to 'any' to avoid compiler private class discrepancies
});

async function main() {
  try {
    console.log('Connecting to Gemini Live Voice service...');
    await agent.voice.connect();
    console.log('Successfully connected!');

    // Handle incoming audio stream from agent and play it back
    agent.voice.on('speaker', ({ audio }: any) => {
      if (audio) {
        try {
          playAudio(audio);
        } catch (playErr) {
          console.error('Audio playback error:', playErr);
        }
      }
    });

    // Handle transcription logs to show dialogue in console
    agent.voice.on('writing', ({ role, text }: any) => {
      if (text && text.trim()) {
        console.log(`[${role.toUpperCase()}]: ${text}`);
      }
    });

    agent.voice.on('error', (err: any) => {
      console.error('Gemini Live Voice Error:', err);
    });

    // Initial greeting from the agent
    console.log('\nSpeaking initial greeting...');
    await agent.voice.speak('Ahoj! Jak ti mohu dnes pomoct?');

    // Start capturing microphone input and stream to Gemini Live
    console.log('\nOpening microphone stream... Please start speaking.');
    const micStream = getMicrophoneStream();
    await agent.voice.send(micStream);

  } catch (error) {
    console.error('An error occurred during execution:', error);
  }
}

main();
