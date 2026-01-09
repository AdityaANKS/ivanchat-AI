
import { GoogleGenAI, Modality, Type } from "@google/genai";
import { ReadingTone, VoiceGender, CharacterBio, SceneMetadata } from "../types.ts";

// Define a pool of keys for rotation
const API_KEYS = [
  process.env.API_KEY,
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3
].filter((key): key is string => Boolean(key));

let currentKeyIndex = 0;

/**
 * Returns a new AI client using the current active key in rotation.
 */
const getAIClient = () => {
  // Use modulo to ensure we loop through the pool indefinitely
  const apiKey = API_KEYS[currentKeyIndex % API_KEYS.length] || process.env.API_KEY || "";
  return new GoogleGenAI({ apiKey });
};

/**
 * Robust retry utility with key rotation and exponential backoff.
 * If a 429 (Rate Limit) is detected, it switches to the next key in the pool.
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 6): Promise<T> {
  let delay = 1000;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      // Check for rate limit status codes or common error strings
      const errorMsg = e.message?.toLowerCase() || "";
      const isRateLimit = e.status === 429 || errorMsg.includes('429') || errorMsg.includes('too many requests') || errorMsg.includes('quota');
      const isRetryable = isRateLimit || (e.status >= 500 && e.status <= 599) || errorMsg.includes('fetch');

      if (i === maxRetries - 1 || !isRetryable) {
        console.error(`Final API failure after ${i + 1} attempts using Key Index ${currentKeyIndex % API_KEYS.length}:`, e);
        throw e;
      }

      // If we hit a rate limit and have multiple keys, rotate immediately
      if (isRateLimit && API_KEYS.length > 1) {
        currentKeyIndex++;
        console.warn(`Rate limit reached. Rotating to API Key ${currentKeyIndex % API_KEYS.length + 1} of ${API_KEYS.length}`);
      }

      console.warn(`API error encountered, retrying in ${delay}ms (Attempt ${i + 1}/${maxRetries})...`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 1.5; // Exponential backoff
    }
  }
  throw new Error("Unexpected retry loop termination");
}

export const geminiService = {
  /**
   * Generates a professional app logo with key-rotation fallback.
   */
  async generateAppLogo(): Promise<string> {
    return withRetry(async () => {
      const ai = getAIClient();
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
          parts: [
            {
              text: 'A professional, minimalist square app icon for “Ivanchat”, an AI conversation platform. The icon features a custom abstract logo mark formed from the letters “IV”, designed using clean white line-art with subtle geometric symmetry, accented by a soft indigo glow to represent intelligence and clarity, set against a deep navy blue background. Flat vector style, modern tech aesthetic, high contrast, centered composition, no text, no book, no chat bubbles, premium and scalable for favicon and mobile app icon use.',
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

  /**
   * Analyzes text for narrative metadata with key-rotation fallback.
   */
  async analyzeScene(text: string): Promise<SceneMetadata> {
    return withRetry(async () => {
      const ai = getAIClient();
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
   * Generates expressive narrator audio with key-rotation fallback.
   */
  async textToSpeech(text: string, tones: ReadingTone[], gender: VoiceGender, pitch: number, breaths: boolean, metadata?: SceneMetadata): Promise<string> {
    return withRetry(async () => {
      const ai = getAIClient();
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
   * Extract key characters from manuscript with key-rotation fallback.
   */
  async extractCharacters(contextText: string): Promise<CharacterBio[]> {
    return withRetry(async () => {
      const ai = getAIClient();
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
   * Literary Analysis Chatbot with key-rotation fallback.
   */
  async chat(message: string, contextText: string, characters: CharacterBio[], history: { role: 'user' | 'model', parts: { text: string }[] }[]): Promise<string> {
    return withRetry(async () => {
      const ai = getAIClient();
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
      return response.text || "I'm having trouble analyzing the text at the moment.";
    });
  },

  /**
   * Transcribe user audio with key-rotation fallback.
   */
  async transcribeAudio(base64Audio: string): Promise<string> {
    return withRetry(async () => {
      const ai = getAIClient();
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
