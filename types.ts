export enum ReadingTone {
  EMOTIONAL = 'Emotional',
  EMOTIONLESS = 'Emotionless',
  CALM = 'Calm',
  INTENSE = 'Intense',
  DRAMATIC = 'Dramatic',
  NEUTRAL = 'Neutral',
  SPOOKY = 'Spooky',
  CHEEKY = 'Cheeky',
  MYSTERIOUS = 'Mysterious',
  ENERGETIC = 'Energetic',
  ROMANTIC = 'Romantic',
  STERN = 'Stern'
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

export interface ChatSession {
  id: string;
  name: string;
  messages: ChatMessage[];
  lastUpdated: Date;
}

export interface SceneMetadata {
  mood: string;
  pacing: 'fast' | 'slow' | 'moderate';
  keyCharacters: string[];
  keyPhrases: string[];
}

export interface CharacterBio {
  name: string;
  role: string;
  description: string;
  traits: string[];
  mentions: number;
}

export interface VoicePreset {
  id: string;
  name: string;
  tones: ReadingTone[];
  gender: VoiceGender;
  pitch: number;
  includeBreaths: boolean;
  speed: number;
}

export interface AudioState {
  isPlaying: boolean;
  speed: number;
  progress: number;
}

export interface Chapter {
  id: string;
  title: string;
  content: string;
  startIndex: number;
}