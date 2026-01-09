
import { GoogleGenAI, Modality, Type } from "@google/genai";
import { ReadingTone, VoiceGender, SceneMetadata } from "../types.ts";

const KEY_POOL = [
  process.env.API_KEY || process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3
].filter((k): k is string => !!k && k !== "undefined");

let keyCursor = 0;

const getAIClient = () => {
  const apiKey = KEY_POOL[keyCursor % KEY_POOL.length];
  keyCursor++;
  return new GoogleGenAI({ apiKey });
};

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> {
  let delay = 2000;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const is429 = e.status === 429 || e.message?.includes("429");
      if (i === maxRetries - 1) throw e;
      console.warn(`API attempt ${i + 1} failed. Rotating key and retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, is429 ? delay * 2 : delay));
      delay *= 2;
    }
  }
  throw new Error("Retry exhausted");
}

export const geminiService = {
  async textToSpeech(text: string, tones: ReadingTone[], gender: VoiceGender, pitch: number, breaths: boolean, metadata?: SceneMetadata): Promise<string> {
    return withRetry(async () => {
      const ai = getAIClient();
      const voiceName = gender === VoiceGender.FEMALE ? 'Kore' : 'Fenrir';
      const toneStr = tones.join(', ');

      const prompt = `Act as a consistent, world-class professional audiobook narrator. 
      Vocal Profile: ${gender}, Base Tones: ${toneStr}. 
      Vocal Modulation: Pitch ${pitch}%. 
      Performance Requirements: 
      1. Determinism: Maintain identical vocal texture, pacing, and energy throughout. 
      2. Emotional Depth: Infuse the prose with a ${metadata?.mood || 'narrative'} mood. 
      3. Breaths: ${breaths ? 'Incorporate natural, audible breaths at punctuation to increase realism.' : 'Maintain a clean, breath-minimized studio delivery.'}
      4. Low Randomness: Focus on clarity and consistency.

      TEXT: "${text}"`;

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          temperature: 0.3, // Crucial for deterministic reassembly
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      });

      const data = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!data) throw new Error("Synthesis payload missing");
      return data;
    });
  },

  async analyzeScene(text: string): Promise<SceneMetadata> {
    return withRetry(async () => {
      const ai = getAIClient();
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Analyze scene mood/pacing for TTS: "${text.substring(0, 1000)}"`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              mood: { type: Type.STRING },
              pacing: { type: Type.STRING, enum: ["fast", "slow", "moderate"] },
              keyCharacters: { type: Type.ARRAY, items: { type: Type.STRING } },
              keyPhrases: { type: Type.ARRAY, items: { type: Type.STRING } }
            }
          }
        }
      });
      return JSON.parse(response.text || "{}");
    });
  },

  async generateAppLogo(): Promise<string> {
    return withRetry(async () => {
      const ai = getAIClient();
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [{ text: 'Sophisticated literary app icon, dark indigo, minimalist fountain pen nib.' }] },
      });
      const part = response.candidates?.[0]?.content?.parts.find(p => p.inlineData);
      return part ? `data:image/png;base64,${part.inlineData.data}` : '';
    });
  },

  async chat(message: string, context: string, history: any[]): Promise<string> {
    const ai = getAIClient();
    const chat = ai.chats.create({
      model: 'gemini-3-flash-preview',
      config: { systemInstruction: `You are a literary analyst helping with this text: ${context.substring(0, 5000)}` },
      history
    });
    const res = await chat.sendMessage({ message });
    return res.text || "Error communicating with AI";
  }
};
