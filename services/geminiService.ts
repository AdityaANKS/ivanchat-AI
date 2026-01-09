
import { GoogleGenAI, Modality, Type } from "@google/genai";
import { ReadingTone, VoiceGender, CharacterBio, SceneMetadata } from "../types.ts";

// Pool of keys for rotation to handle rate limits on Netlify
const KEY_POOL = [
  process.env.API_KEY,
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3
].filter((k): k is string => !!k);

let currentKeyIndex = 0;

/**
 * Returns a new AI client using the current rotated key.
 */
const getAIClient = () => {
  const apiKey = KEY_POOL[currentKeyIndex % KEY_POOL.length] || process.env.API_KEY || "";
  return new GoogleGenAI({ apiKey });
};

/**
 * Robust retry utility with key rotation on rate limits (429) and exponential backoff.
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 6): Promise<T> {
  let delay = 1000;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const status = e.status || (e.message && e.message.match(/\d{3}/)?.[0]);
      const isRateLimit = status == 429 || e.message?.toLowerCase().includes("rate limit") || e.message?.toLowerCase().includes("quota");
      const isRetryable = isRateLimit || (status >= 500 && status <= 599) || e.message?.toLowerCase().includes("fetch");

      if (i === maxRetries - 1 || !isRetryable) {
        console.error(`Final API failure after ${i + 1} attempts:`, e);
        throw e;
      }

      if (isRateLimit && KEY_POOL.length > 1) {
        currentKeyIndex++;
        console.warn(`Rate limit hit. Rotating to key index ${currentKeyIndex % KEY_POOL.length}`);
      }

      console.warn(`API attempt ${i + 1} failed, retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 1.5;
    }
  }
  throw new Error("Retry loop exhausted");
}

export const geminiService = {
  /**
   * Generates a professional app logo with a simplified prompt for better reliability.
   */
  async generateAppLogo(): Promise<string> {
    return withRetry(async () => {
      const ai = getAIClient();
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
          parts: [
            {
              text: 'A clean minimalist app icon for a literary platform. Design: A modern stylized "IV" logo in white lines. Background: Solid dark indigo. Professional, high-end tech aesthetic, square centered icon, no text.',
            },
          ],
        },
        config: {
          imageConfig: {
            aspectRatio: "1:1"
          }
        },
      });

      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          return `data:image/png;base64,${part.inlineData.data}`;
        }
      }
      throw new Error("No image data in response.");
    });
  },

  async analyzeScene(text: string): Promise<SceneMetadata> {
    return withRetry(async () => {
      const ai = getAIClient();
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Analyze this literary scene. Identify mood, pacing, characters, and key phrases for audio production.
        Return results in JSON.
        
        TEXT: "${text.substring(0, 1500)}"`,
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
            required: ["mood", "pacing", "keyCharacters", "keyPhrases"]
          }
        }
      });

      if (!response.text) throw new Error("Empty analysis.");
      return JSON.parse(response.text.trim());
    });
  },

  async textToSpeech(text: string, tones: ReadingTone[], gender: VoiceGender, pitch: number, breaths: boolean, metadata?: SceneMetadata): Promise<string> {
    return withRetry(async () => {
      const ai = getAIClient();
      const toneList = tones.length > 0 ? tones.map(t => t.toLowerCase()) : ['neutral'];
      const toneDescription = toneList.join(' + ');
      const voiceName = gender === VoiceGender.FEMALE ? 'Kore' : 'Fenrir';

      const prompt = `Act as a world-class audiobook narrator. Read this: "${text}". 
      Emotional blend: ${toneDescription}. 
      Vocal modulation: Pitch shift ${pitch}%. 
      Breaths: ${breaths ? 'Natural/In-scene' : 'Minimized'}. 
      Context: ${metadata ? `Mood: ${metadata.mood}, Pace: ${metadata.pacing}` : 'Standard narration'}.`;

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          temperature: 0.8,
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) throw new Error("No audio returned.");
      return base64Audio;
    });
  },

  async extractCharacters(contextText: string): Promise<CharacterBio[]> {
    return withRetry(async () => {
      const ai = getAIClient();
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Identify key characters from this manuscript. Return a JSON array.
        SAMPLE: ${contextText.substring(0, 8000)}`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                role: { type: Type.STRING },
                description: { type: Type.STRING },
                traits: { type: Type.ARRAY, items: { type: Type.STRING } },
                mentions: { type: Type.NUMBER }
              },
              required: ["name", "role", "description", "traits", "mentions"]
            }
          }
        }
      });
      return JSON.parse(response.text || "[]");
    });
  },

  async chat(message: string, contextText: string, characters: CharacterBio[], history: any[]): Promise<string> {
    return withRetry(async () => {
      const ai = getAIClient();
      const charContext = characters.map(c => `${c.name} (${c.role}): ${c.description}`).join('\n');
      const chatInstance = ai.chats.create({
        model: 'gemini-3-pro-preview',
        config: {
          systemInstruction: `You are an expert literary analyzer. Context: ${contextText.substring(0, 10000)}...\nCharacters: ${charContext}`,
        },
        history
      });
      const response = await chatInstance.sendMessage({ message });
      return response.text || "I am unable to process that literary query right now.";
    });
  }
};
