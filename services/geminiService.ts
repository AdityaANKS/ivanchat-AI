
import { GoogleGenAI, Modality, Type } from "@google/genai";
import { ReadingTone, VoiceGender, CharacterBio, SceneMetadata } from "../types.ts";

/**
 * Returns a new AI client using the environment variable directly.
 */
const getAIClient = () => {
  return new GoogleGenAI({ apiKey: process.env.API_KEY });
};

/**
 * Robust retry utility with exponential backoff.
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 4): Promise<T> {
  let delay = 1000;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const errorMsg = e.message?.toLowerCase() || "";
      const isRetryable = (e.status === 429) || (e.status >= 500 && e.status <= 599) || errorMsg.includes('fetch');

      if (i === maxRetries - 1 || !isRetryable) {
        console.error(`Final API failure after ${i + 1} attempts:`, e);
        throw e;
      }

      console.warn(`API error encountered, retrying in ${delay}ms (Attempt ${i + 1}/${maxRetries})...`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 2; 
    }
  }
  throw new Error("Unexpected retry loop termination");
}

export const geminiService = {
  /**
   * Generates a professional app logo.
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
   * Analyzes text for narrative metadata.
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
   * Generates expressive narrator audio.
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
   * Extract key characters from manuscript.
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
   * Literary Analysis Chatbot.
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
   * Transcribe user audio.
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
