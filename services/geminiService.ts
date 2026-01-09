import { GoogleGenAI, Modality, Type } from "@google/genai";
import { ReadingTone, VoiceGender, CharacterBio, SceneMetadata } from "../types.ts";

// Support for multiple keys with rotation/fallback logic
const keys = [
  process.env.API_KEY,
  (process.env as any).GEMINI_API_KEY,
  (process.env as any).GEMINI_API_KEY_2,
  (process.env as any).GEMINI_API_KEY_3
].filter(Boolean) as string[];

let currentKeyIndex = 0;

/**
 * Returns a new GoogleGenAI instance using the current active key.
 */
function getAIClient() {
  const apiKey = keys.length > 0 ? keys[currentKeyIndex] : process.env.API_KEY!;
  return new GoogleGenAI({ apiKey });
}

/**
 * Executes an AI operation with automatic key rotation on failure.
 */
async function withFallback<T>(operation: (ai: ReturnType<typeof getAIClient>) => Promise<T>): Promise<T> {
  let lastError;
  const attempts = Math.max(1, keys.length);

  for (let i = 0; i < attempts; i++) {
    try {
      const ai = getAIClient();
      return await operation(ai);
    } catch (e: any) {
      console.warn(`Gemini API Error with key ${currentKeyIndex}. Attempting rotation.`, e);
      lastError = e;
      // Rotate to next key if we have multiple
      if (keys.length > 1) {
        currentKeyIndex = (currentKeyIndex + 1) % keys.length;
      } else {
        // If only one key, don't loop endlessly
        throw e;
      }
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
        contents: `Analyze this scene for a high-end audiobook production. Identify the dominant mood, the ideal narration pacing, present characters, and key phrases that require specific emphasis.
        Return the results in JSON format.
        
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

      if (!response.text) throw new Error("Empty response from analysis model.");
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
        
      const prompt = `Act as a world-class voice actor and professional audiobook narrator. Read the following text using a ${gender.toLowerCase()} voice. 

      TONE SYNTHESIS ALGORITHM (Emotional Core Blending):
      Target Narrative Profile: ${toneDescription}. 

      INSTRUCTIONS:
      1. Identify Emotional Resonance: Create a performance that intersects the chosen tones.
      2. Prioritize Subtext: Use the tones to color vocal micro-inflections.
      3. Fluid Transitions: Ensure pacing is governed by narrative flow.

      ${metadata ? `SCENE CONTEXT:
      - Mood: ${metadata.mood}
      - Pacing: ${metadata.pacing}
      - Characters: ${metadata.keyCharacters.join(', ')}` : ''}

      VOICE MODULATION:
      - Pitch Shift: ${pitch}%
      - Natural Respiration: ${breaths ? 'Include audible breaths.' : 'Clean studio delivery.'}

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
        contents: `Identify the significant characters and generate bios. Sample: ${contextText.substring(0, 15000)}...`,
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
        ? "CHARACTER DOSSIER:\n" + characters.map(c => `- ${c.name} (${c.role}): ${c.description}`).join("\n")
        : "";
      
      const chatInstance = ai.chats.create({
        model: 'gemini-3-pro-preview',
        config: {
          systemInstruction: `You are an expert literary analysis chatbot. ${characterContext}\n\nNOVEL CONTEXT: ${contextText.substring(0, 8000)}...`,
        },
        history: history
      });

      const response = await chatInstance.sendMessage({ message });
      return response.text || "I'm sorry, I couldn't generate a response.";
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
            { text: "Transcribe the audio command accurately. Only return the transcribed text." }
          ]
        }
      });
      return response.text ? response.text.trim() : "";
    });
  }
};