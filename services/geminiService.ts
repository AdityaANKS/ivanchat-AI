
import { GoogleGenAI, Modality, Type } from "@google/genai";
import { ReadingTone, VoiceGender, SceneMetadata } from "../types.ts";

/**
 * Initializes the Google GenAI client using exclusively process.env.API_KEY.
 */
const getAIClient = () => {
  return new GoogleGenAI({ apiKey: process.env.API_KEY || "" });
};

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> {
  let delay = 2000;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      // 429 is Too Many Requests
      const is429 = e.status === 429 || e.message?.includes("429");
      if (i === maxRetries - 1) throw e;
      console.warn(`API attempt ${i + 1} failed. Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, is429 ? delay * 2.5 : delay));
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
      Voice: ${gender}, Tone: ${toneStr}, Pitch: ${pitch}%, Breaths: ${breaths ? 'Natural/Audible' : 'None'}.
      Context: ${metadata?.mood || 'Neutral'} mood, ${metadata?.pacing || 'moderate'} pace.
      Strict Requirement: Deliver a steady performance with deterministic pacing.
      Narrate the following: "${text}"`;

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          temperature: 0.3, // Low randomness for consistency in bulk reassembly
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      });

      const data = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!data) throw new Error("No audio data returned");
      return data;
    });
  },

  async analyzeScene(text: string): Promise<SceneMetadata> {
    return withRetry(async () => {
      const ai = getAIClient();
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Analyze scene mood/pacing for high-quality TTS: "${text.substring(0, 1000)}"`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              mood: { type: Type.STRING },
              pacing: { type: Type.STRING, enum: ["fast", "slow", "moderate"] },
              keyCharacters: { type: Type.ARRAY, items: { type: Type.STRING } },
              keyPhrases: { type: Type.ARRAY, items: { type: Type.STRING } }
            },
            required: ["mood", "pacing"]
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
        contents: { parts: [{ text: 'Sophisticated literary app icon, dark indigo, minimalist fountain pen nib design.' }] },
      });
      const part = response.candidates?.[0]?.content?.parts.find(p => p.inlineData);
      return part ? `data:image/png;base64,${part.inlineData.data}` : '';
    });
  },

  async chat(message: string, context: string, history: any[]): Promise<string> {
    const ai = getAIClient();
    const chat = ai.chats.create({
      model: 'gemini-3-flash-preview',
      config: { systemInstruction: `You are a literary analyst assisting with the following text. Context length: ${context.length} characters.` },
      history
    });
    const res = await chat.sendMessage({ message: `Based on the provided manuscript, ${message}` });
    return res.text || "Assistant unable to respond.";
  }
};
