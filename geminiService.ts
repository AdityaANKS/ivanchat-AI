
import { GoogleGenAI, Modality, Type } from "@google/genai";
import { ReadingTone, VoiceGender } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const geminiService = {
  /**
   * Generates audio using gemini-2.5-flash-preview-tts with advanced tone synthesis.
   */
  async textToSpeech(text: string, tones: ReadingTone[], gender: VoiceGender, pitch: number, breaths: boolean) {
    const toneList = tones.length > 0 ? tones.map(t => t.toLowerCase()) : ['neutral'];
    const toneDescription = toneList.join(' + ');
      
    const prompt = `Act as a world-class voice actor and professional audiobook narrator. Read the following text using a ${gender.toLowerCase()} voice. 

    TONE SYNTHESIS ALGORITHM (Emotional Core Blending):
    Target Profile: ${toneDescription}. 

    PERFORMANCE ARCHITECTURE:
    1. **Prioritize Emotional Core**: Identify the intersecting emotional frequency of the selected tones. Do not just alternate styles; create a unified, complex voice.
    2. **Natural Transitions**: Let the narration breathe. Use subtle shifts in weight and pacing to navigate the emotional landscape of the prose.
    3. **Example Synthesis**: If 'Spooky' and 'Dramatic' are paired, create a sense of 'Ominous Tension'—utilizing a low, breathy register with wide theatrical volume shifts and intentional, heavy pauses.
    4. **Harmonic Consistency**: Maintain a stable vocal character that embodies the provided emotional spectrum throughout the entire duration.

    ADVANCED VOICE MODULATION PARAMETERS:
    - **Pitch Shift**: Apply a relative pitch shift of ${pitch}%.
    - **Breath Sounds**: ${breaths ? 'Incorporate audible, natural breaths (intakes and exhalations) between phrases to enhance intimacy and dramatic realism.' : 'Maintain a clean, breath-minimized studio-perfect delivery.'}
    - **Dynamic Resonance**: Automatically adjust vocal resonance and volume (amplitude) to match the text's psychological intensity.
    - **Rhythmic Variance**: Quickening for action or anxiety, slowing for introspection or dread.

    Text to narrate: "${text}"`;
    
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
  },

  /**
   * Transcribes audio using gemini-3-flash-preview
   */
  async transcribeAudio(base64Audio: string) {
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
          { text: "Transcribe the audio accurately. Only return the transcript." }
        ]
      }
    });

    return response.text || "";
  },

  /**
   * Chat using gemini-3-pro-preview
   */
  async chat(message: string, contextText: string, history: { role: 'user' | 'model', parts: { text: string }[] }[]) {
    const chatInstance = ai.chats.create({
      model: 'gemini-3-pro-preview',
      config: {
        systemInstruction: `You are an expert literary analysis chatbot. You have access to a long-form text (novel) provided by the user. 
        Context from text: ${contextText.substring(0, 10000)}...
        Answer questions about plot, character arcs, symbolism, and narrative structure based on this content.`,
      },
      history: history
    });

    const response = await chatInstance.sendMessage({ message });
    return response.text || "";
  }
};
