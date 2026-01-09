
export enum ReadingTone {
  EMOTIONAL = 'Emotional',
  EMOTIONLESS = 'Emotionless',
  COLD = 'Cold',
  NATURAL = 'Natural',
  CALM = 'Calm',
  INTENSE = 'Intense',
  DRAMATIC = 'Dramatic',
  NEUTRAL = 'Neutral',
  SPOOKY = 'Spooky',
  CHEEKY = 'Cheeky',
  MYSTERIOUS = 'Mysterious',
  ENERGETIC = 'Energetic',
  ROMANTIC = 'Romantic',
  STERN = 'Stern',
  WHISPER = 'Whisper'
}

export enum VoiceGender {
  MALE = 'Male',
  FEMALE = 'Female'
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: Date;
}

export interface SceneMetadata {
  mood: string;
  pacing: 'fast' | 'slow' | 'moderate';
  keyCharacters: string[];
  keyPhrases: string[];
}

export interface Chapter {
  id: string;
  title: string;
  content: string;
  startIndex: number;
}

export interface SentenceTimeline {
  sentenceIndex: number;
  globalIndex: number;
  text: string;
  audioStart: number;
  audioEnd: number;
  wordCount: number;
}

export interface AudioChunkMetadata {
  chunkIndex: number;
  charStart: number;
  charEnd: number;
  audioStart: number;
  audioEnd: number;
  sentences: SentenceTimeline[];
}
