import { GoogleGenAI, Modality, Type } from "@google/genai";
import { ReadingTone, VoiceGender, CharacterBio, SceneMetadata } from "../types.ts";

// Support for multiple keys with rotation/fallback logic
// We attempt to pull from various standard Netlify/Environment variable names
const keys = [
  process.env.API_KEY,
  (process.env as any).GEMINI_API_KEY,
  (process.env as any).GEMINI_API_KEY_2,
  (process.env as any).GEMINI_API_KEY_3
].filter(Boolean) as string[];

let currentKeyIndex = 0;

/**
 * Returns a new GoogleGenAI instance using the current active key from the rotation.
 */
function getAIClient() {
  const apiKey = keys.length > 0 ? keys[currentKeyIndex] : (process.env.API_KEY || '');
  return new GoogleGenAI({ apiKey });
}

/**
 * Executes an AI operation with automatic key rotation and retry on failure.
 * This ensures the app stays running even if one key hits a quota or rate limit.
 */
async function withFallback<T>(operation: (ai: any) => Promise<T>): Promise<T> {
  let lastError;
  const attempts = Math.max(1, keys.length);

  for (let i = 0; i < attempts; i++) {
    try {
      const ai = getAIClient();
      return await operation(ai);
    } catch (e: any) {
      console.warn(`API attempt ${i + 1} failed with key index ${currentKeyIndex}. Rotating keys...`, e);
      lastError = e;
      
      // Rotate to next key if available
      if (keys.length > 1) {
        currentKeyIndex = (currentKeyIndex + 1) % keys.length;
      } else {
        throw e; // No other keys to try
      }
      
      // Short delay before retry to avoid rapid-fire failures
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

export const geminiService = {
  /**
   * Analyzes a specific chunk of text to extract narrative metadata.
   */
  async analyzeScene(text: string): Promise<SceneMetadata> {
    return withFallback(async (ai) => {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Analyze this scene for audiobook production. Identify mood, pacing, characters, and key emphasis phrases.
        Return results in JSON format.
        
        Text sample: "${text.substring(0, 1500)}"`,
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

      if (!response.text) throw new Error("Empty analysis response.");
      return JSON.parse(response.text.trim());
    });
  },

  /**
   * Generates highly expressive narrator audio.
   */
  async textToSpeech(text: string, tones: ReadingTone[], gender: VoiceGender, pitch: number, breaths: boolean, metadata?: SceneMetadata): Promise<string> {
    return withFallback(async (ai) => {
      const toneList = tones.length > 0 ? tones.map(t => t.toLowerCase()) : ['neutral'];
      const toneDescription = toneList.join(' + ');
        
      const prompt = `Act as a world-class voice actor. Narrate the following text using a ${gender.toLowerCase()} voice. 
      Emotional blend: ${toneDescription}. 
      ${metadata ? `Context: Mood is ${metadata.mood}, pacing is ${metadata.pacing}.` : ''}
      Modulation: Pitch shift ${pitch}%, breaths ${breaths ? 'included' : 'excluded'}.
      
      TEXT: "${text}"`;
      
      const voiceName = gender === VoiceGender.FEMALE ? 'Kore' : 'Fenrir';

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          temperature: 0.9,
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voiceName },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) throw new Error("No audio data received.");
      return base64Audio;
    });
  },

  /**
   * Extract key characters and generate biographies.
   */
  async extractCharacters(contextText: string): Promise<CharacterBio[]> {
    return withFallback(async (ai) => {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Identify characters and generate bios. Sample: ${contextText.substring(0, 10000)}...`,
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

      if (!response.text) return [];
      return JSON.parse(response.text.trim());
    });
  },

  /**
   * Literary Analysis Chatbot.
   */
  async chat(message: string, contextText: string, characters: CharacterBio[], history: { role: 'user' | 'model', parts: { text: string }[] }[]): Promise<string> {
    return withFallback(async (ai) => {
      const characterContext = characters.length > 0 
        ? "CHARACTERS:\n" + characters.map(c => `- ${c.name} (${c.role}): ${c.description}`).join("\n")
        : "";
      
      const chatInstance = ai.chats.create({
        model: 'gemini-3-pro-preview',
        config: {
          systemInstruction: `You are an expert literary analysis chatbot. ${characterContext}\n\nNOVEL CONTEXT: ${contextText.substring(0, 10000)}...`,
        },
        history: history
      });

      const response = await chatInstance.sendMessage({ message });
      return response.text || "Could not generate a literary response.";
    });
  },

  /**
   * Voice Command Transcription.
   */
  async transcribeAudio(base64Audio: string): Promise<string> {
    return withFallback(async (ai) => {
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: 'audio/pcm;rate=16000',
                data: base64Audio,
              },
            },
            { text: "Transcribe accurately. Only return text." }
          ]
        }
      });
      return response.text ? response.text.trim() : "";
    });
  }
};