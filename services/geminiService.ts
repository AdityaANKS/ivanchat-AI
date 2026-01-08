
import { GoogleGenAI, Modality, Type } from "@google/genai";
import { ReadingTone, VoiceGender, CharacterBio, SceneMetadata } from "../types";

// Always use process.env.API_KEY directly as per guidelines
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const geminiService = {
  /**
   * Analyzes a specific chunk of text to extract narrative metadata.
   * Uses gemini-3-flash-preview for efficient analysis.
   */
  async analyzeScene(text: string): Promise<SceneMetadata> {
    try {
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
              mood: { type: Type.STRING, description: "The overarching emotional atmosphere." },
              pacing: { type: Type.STRING, enum: ["fast", "slow", "moderate"], description: "The recommended speed of narration." },
              keyCharacters: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Characters actively present or discussed." },
              keyPhrases: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Phrases that carry significant narrative weight." }
            },
            required: ["mood", "pacing", "keyCharacters", "keyPhrases"]
          }
        }
      });

      if (!response.text) throw new Error("Empty response from analysis model.");
      return JSON.parse(response.text.trim());
    } catch (e) {
      console.error("Failed to parse scene metadata:", e);
      return { mood: "neutral", pacing: "moderate", keyCharacters: [], keyPhrases: [] };
    }
  },

  /**
   * Generates highly expressive narrator audio using gemini-2.5-flash-preview-tts.
   * Leverages a sophisticated tone-blending algorithm for vocal performance.
   */
  async textToSpeech(text: string, tones: ReadingTone[], gender: VoiceGender, pitch: number, breaths: boolean, metadata?: SceneMetadata): Promise<string> {
    try {
      const toneList = tones.length > 0 ? tones.map(t => t.toLowerCase()) : ['neutral'];
      const toneDescription = toneList.join(' + ');
        
      const prompt = `Act as a world-class voice actor and professional audiobook narrator. Read the following text using a ${gender.toLowerCase()} voice. 

      TONE SYNTHESIS ALGORITHM (Emotional Core Blending):
      Target Narrative Profile: ${toneDescription}. 

      INSTRUCTIONS FOR SOPHISTICATED VOICE SYNTHESIS:
      1. **Identify Emotional Resonance**: Instead of alternating styles, find the "intersection" of the selected tones. 
         - If 'Spooky' and 'Dramatic' are paired: Create a performance of 'Gothic Dread'—combining the low-register, breathy whispers of horror with the wide dynamic amplitude and theatrical gravity of a tragedy.
         - If 'Stern' and 'Calm' are paired: Evoke 'Commanding Authority'—a steady, unshakeable pace with sharp, clipped consonants.
      2. **Prioritize Subtext**: Use the dominant emotional core of the tones to color your delivery. Let the psychological weight of the tones dictate your vocal timbre, resonance, and micro-inflections.
      3. **Fluid Transitions**: Ensure transitions between sentences are governed by the narrative flow. As the prose shifts, subtly re-weight the blend of the selected tones to match the changing energy.
      4. **Handle Contradictions**: If tones seem polar (e.g., 'Energetic' + 'Stern'), synthesize them into a 'Drill Sergeant' style—sharp, high-energy delivery tempered by rigid, cold discipline.

      ${metadata ? `SCENE CONTEXT (Weight the synthesis based on this analysis):
      - Overall Atmospheric Mood: ${metadata.mood}
      - Narrative Pacing Requirement: ${metadata.pacing}
      - Dynamic Interaction (Characters present): ${metadata.keyCharacters.join(', ')}
      - Emphasis Anchors (Key Phrases): ${metadata.keyPhrases.join(', ')}` : ''}

      VOICE MODULATION SPECS:
      - **Pitch Calibration**: Apply a relative pitch shift of ${pitch}%.
      - **Natural Respiration**: ${breaths ? 'Incorporate audible, context-aware breaths. Short, sharp intakes for tension; long, slow exhalations for relief or mystery.' : 'Maintain a pristine, breath-minimized studio delivery.'}
      - **Dynamic Pacing**: If pacing is "fast", prioritize rhythmic drive and staccato delivery. If "slow", favor legato vowels and deep, intentional silences.

      TEXT TO NARRATE: "${text}"`;
      
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
      if (!base64Audio) throw new Error("No audio data received from Gemini.");
      return base64Audio;
    } catch (e) {
      console.error("Text-to-speech engine failed:", e);
      throw e;
    }
  },

  /**
   * Extract key characters and generate biographies using Gemini 3 Flash.
   */
  async extractCharacters(contextText: string): Promise<CharacterBio[]> {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Analyze the provided novel text and identify the most significant characters. 
        For each character, generate a concise dossier.
        
        Text sample: ${contextText.substring(0, 15000)}...`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                role: { type: Type.STRING, description: "e.g., Protagonist, Supporting, Antagonist" },
                description: { type: Type.STRING, description: "2-3 sentence biography focusing on their core motivation and personality." },
                traits: { type: Type.ARRAY, items: { type: Type.STRING } },
                mentions: { type: Type.NUMBER, description: "Relative importance score from 1-100" }
              },
              required: ["name", "role", "description", "traits", "mentions"]
            }
          }
        }
      });

      if (!response.text) return [];
      return JSON.parse(response.text.trim());
    } catch (e) {
      console.error("Character extraction failed:", e);
      return [];
    }
  },

  /**
   * Literary Analysis Chatbot using Gemini 3 Pro with full context awareness.
   */
  async chat(message: string, contextText: string, characters: CharacterBio[], history: { role: 'user' | 'model', parts: { text: string }[] }[]): Promise<string> {
    try {
      const characterContext = characters.length > 0 
        ? "CHARACTER DOSSIER:\n" + characters.map(c => `- ${c.name} (${c.role}): ${c.description} (Traits: ${c.traits.join(", ")})`).join("\n")
        : "No character dossier available yet.";
      
      const chatInstance = ai.chats.create({
        model: 'gemini-3-pro-preview',
        config: {
          systemInstruction: `You are an expert literary scholar and analysis chatbot. Your purpose is to help the user understand and analyze the novel they have provided.
          
          ${characterContext}

          FULL NOVEL CONTEXT (Representative Sample): 
          ${contextText.substring(0, 10000)}...

          CORE TASKS:
          - Analyze specific character arcs and relationships.
          - Identify recurring themes and motifs.
          - Discuss the emotional tone and narrative structure.
          - If the user asks about a character, refer to the dossier for consistency.
          - Be insightful, intellectual, yet accessible.`,
        },
        history: history
      });

      const response = await chatInstance.sendMessage({ message });
      return response.text || "I'm sorry, I couldn't generate a response based on the text.";
    } catch (e) {
      console.error("Chat scholarship engine failed:", e);
      return "An error occurred while analyzing the manuscript.";
    }
  },

  /**
   * Voice Command Transcription using Gemini 3 Flash.
   */
  async transcribeAudio(base64Audio: string): Promise<string> {
    try {
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
            { text: "Transcribe the audio accurately. This is a voice command for a literary app. Only return the transcribed text without commentary." }
          ]
        }
      });

      return response.text ? response.text.trim() : "";
    } catch (e) {
      console.error("Voice command transcription failed:", e);
      return "";
    }
  }
};
