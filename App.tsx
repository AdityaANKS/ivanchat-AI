import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ReadingTone, VoiceGender, ChatMessage, CharacterBio, VoicePreset, ChatSession, SceneMetadata, Chapter } from './types.ts';
import { geminiService } from './services/geminiService.ts';
import { decodeBase64, decodeAudioData, floatTo16BitPCM, encodeBase64, audioBufferToWav } from './services/audioService.ts';
import { GoogleGenAI } from "@google/genai";
import { 
  PlayIcon, 
  PauseIcon, 
  ChatBubbleLeftRightIcon, 
  MicrophoneIcon, 
  ArrowPathIcon,
  BookOpenIcon,
  AdjustmentsHorizontalIcon,
  SpeakerWaveIcon,
  UserIcon,
  MoonIcon,
  SunIcon,
  UserGroupIcon,
  SparklesIcon,
  PlusIcon,
  TrashIcon,
  BookmarkIcon,
  ClockIcon,
  ArchiveBoxIcon,
  ArrowDownTrayIcon,
  XMarkIcon,
  VariableIcon,
  EyeIcon,
  PencilSquareIcon,
  HashtagIcon,
  ArrowDownOnSquareIcon
} from '@heroicons/react/24/outline';

interface AudioChunkMetadata {
  charStart: number;
  charEnd: number;
  audioStart: number;
  audioEnd: number;
  scene?: SceneMetadata;
}

const GoogleAdSenseUnit: React.FC<{ slot: string; format?: string; className?: string }> = ({ slot, format = 'auto', className = '' }) => {
  useEffect(() => {
    try {
      // @ts-ignore
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (e) {
      console.debug('AdSense pending initialization');
    }
  }, []);

  return (
    <div className={`overflow-hidden rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 ${className}`}>
      <ins className="adsbygoogle"
           style={{ display: 'block' }}
           data-ad-client="ca-pub-5322028632012246"
           data-ad-slot={slot}
           data-ad-format={format}
           data-full-width-responsive="true"></ins>
    </div>
  );
};

const App: React.FC = () => {
  // --- Core States ---
  const [novelText, setNovelText] = useState<string>(() => localStorage.getItem('ivanchat_novel_text') || '');
  const [characters, setCharacters] = useState<CharacterBio[]>(() => {
    const stored = localStorage.getItem('ivanchat_characters');
    return stored ? JSON.parse(stored) : [];
  });
  
  const [isExtractingCharacters, setIsExtractingCharacters] = useState(false);
  const [selectedTones, setSelectedTones] = useState<ReadingTone[]>([ReadingTone.NEUTRAL]);
  const [gender, setGender] = useState<VoiceGender>(VoiceGender.MALE);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [userInput, setUserInput] = useState('');
  const [isChatting, setIsChatting] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const stored = localStorage.getItem('ivanchat_theme');
    return stored ? stored === 'dark' : true;
  });
  const [viewMode, setViewMode] = useState<'editor' | 'reader'>('editor');
  
  // --- Branding ---
  const [appIcon, setAppIcon] = useState<string | null>(() => localStorage.getItem('ivanchat_app_icon'));
  const [isGeneratingBranding, setIsGeneratingBranding] = useState(false);

  // Favicon synchronization
  useEffect(() => {
    if (appIcon) {
      const link = (document.querySelector("link[rel*='icon']") as HTMLLinkElement) || document.createElement('link');
      link.type = 'image/png';
      link.rel = 'icon';
      link.href = appIcon;
      if (!link.parentNode) document.head.appendChild(link);
    }
  }, [appIcon]);

  const generateBranding = useCallback(async () => {
    if (appIcon) return;
    
    setIsGeneratingBranding(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const prompt = "Generate a modern, minimal favicon for a web application named 'Ivanchat'. The favicon should be simple, clean, and highly recognizable at very small sizes, using a bold symbol rather than detailed text. Design it to represent intelligent conversation and AI-powered interaction, with a sleek, futuristic feel. Use a limited color palette with strong indigo and white contrast, smooth geometric shapes, and a flat design style. The icon should be a single centered logo mark.";
      
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [{ text: prompt }] },
        config: {
          imageConfig: { aspectRatio: "1:1" }
        }
      });

      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          const imageUrl = `data:image/png;base64,${part.inlineData.data}`;
          setAppIcon(imageUrl);
          localStorage.setItem('ivanchat_app_icon', imageUrl);
          break;
        }
      }
    } catch (e) {
      console.error("Branding generation failed:", e);
    } finally {
      setIsGeneratingBranding(false);
    }
  }, [appIcon]);

  useEffect(() => {
    if (!appIcon) {
      generateBranding();
    }
  }, [appIcon, generateBranding]);

  // --- Chapters ---
  const chapters = useMemo(() => {
    const textToParse = (novelText || '').trim();
    if (!textToParse) {
      return [{ id: 'full', title: 'Full Manuscript', content: '', startIndex: 0 }];
    }
    
    const chapterRegex = /(?:^|\n)(?:Chapter\s+\d+|#\s+.+|(?:CHAPTER|Chapter)\s+\w+)/gi;
    let match;
    const found: Chapter[] = [];
    const matches: { index: number; text: string }[] = [];
    
    while ((match = chapterRegex.exec(textToParse)) !== null) {
      matches.push({ index: match.index, text: match[0].trim() });
    }

    if (matches.length === 0) {
      found.push({ id: 'full', title: 'Full Manuscript', content: textToParse, startIndex: 0 });
    } else {
      for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index;
        const end = matches[i + 1] ? matches[i + 1].index : textToParse.length;
        found.push({
          id: `ch-${i}`,
          title: matches[i].text,
          content: textToParse.substring(start, end),
          startIndex: start
        });
      }
    }
    return found;
  }, [novelText]);

  const [selectedChapterId, setSelectedChapterId] = useState<string>('full');
  const activeChapter = useMemo(() => {
    const found = chapters.find(c => c.id === selectedChapterId);
    return found || chapters[0];
  }, [chapters, selectedChapterId]);

  // --- Chat Archives ---
  const [chatSessions, setChatSessions] = useState<ChatSession[]>(() => {
    const stored = localStorage.getItem('ivanchat_chat_sessions');
    return stored ? JSON.parse(stored) : [];
  });

  // --- Presets ---
  const [presets, setPresets] = useState<VoicePreset[]>(() => {
    const stored = localStorage.getItem('ivanchat_presets');
    return stored ? JSON.parse(stored) : [];
  });
  const [presetNameInput, setPresetNameInput] = useState('');

  // --- Audio Engine ---
  const [audioSpeed, setAudioSpeed] = useState(1.0);
  const [pitch, setPitch] = useState(0);
  const [includeBreaths, setIncludeBreaths] = useState(true);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isGeneratingAudio, setIsGeneratingAudio] = useState(false);
  const [genProgress, setGenProgress] = useState(0);
  
  // --- Sponsored Visibility ---
  const [showSponsored, setShowSponsored] = useState<boolean>(() => {
    return sessionStorage.getItem('ivanchat_dismissed_sponsored') !== 'true';
  });

  const [showChat, setShowChat] = useState(true);
  const [audioChunks, setAudioChunks] = useState<AudioChunkMetadata[]>([]);

  // --- Refs ---
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const currentAudioBufferRef = useRef<AudioBuffer | null>(null);
  const startTimeRef = useRef<number>(0);
  const pausedTimeRef = useRef<number>(0);
  const progressRequestRef = useRef<number | null>(null);
  const activeWordRef = useRef<HTMLSpanElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // --- Persistence ---
  useEffect(() => {
    localStorage.setItem('ivanchat_novel_text', novelText);
    localStorage.setItem('ivanchat_characters', JSON.stringify(characters));
    localStorage.setItem('ivanchat_presets', JSON.stringify(presets));
    localStorage.setItem('ivanchat_chat_sessions', JSON.stringify(chatSessions));
    localStorage.setItem('ivanchat_theme', isDarkMode ? 'dark' : 'light');
    if (isDarkMode) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, [novelText, characters, presets, chatSessions, isDarkMode]);

  // --- Text Processing ---
  const processedData = useMemo(() => {
    if (!activeChapter) return [];
    const text = activeChapter.content;
    const rawSentences = text.match(/[^.!?\n]+[.!?]+(?:\s|$|\n)|[^.!?\n]+(?:\n+|$)/g) || [text];
    let globalOffset = 0;
    return rawSentences.map((sText) => {
      const sentenceStart = globalOffset;
      const words: { text: string; start: number; end: number }[] = [];
      const tokens = (sText.match(/\s+|[^\s]+/g) || []) as string[];
      let localOffset = 0;
      tokens.forEach(token => {
        const start = globalOffset + localOffset;
        const end = start + token.length;
        if (token.trim().length > 0) words.push({ text: token, start, end });
        localOffset += token.length;
      });
      globalOffset += sText.length;
      return { text: sText, start: sentenceStart, end: globalOffset, words };
    });
  }, [activeChapter]);

  const estimatedCharPos = useMemo(() => {
    if (audioChunks.length === 0 || duration === 0 || !activeChapter) return 0;
    const chunk = audioChunks.find(c => currentTime >= c.audioStart && currentTime <= c.audioEnd);
    if (chunk) {
      const chunkAudioDuration = chunk.audioEnd - chunk.audioStart;
      if (chunkAudioDuration <= 0) return chunk.charStart;
      const progressInChunk = (currentTime - chunk.audioStart) / chunkAudioDuration;
      const charSpan = chunk.charEnd - chunk.charStart;
      return chunk.charStart + (progressInChunk * charSpan);
    }
    return currentTime >= duration ? activeChapter.content.length : 0;
  }, [currentTime, audioChunks, duration, activeChapter]);

  const activeIndices = useMemo(() => {
    let activeSentenceIdx = -1;
    let activeWordIdx = -1;
    for (let i = 0; i < processedData.length; i++) {
      const s = processedData[i];
      if (estimatedCharPos >= s.start && estimatedCharPos < s.end) {
        activeSentenceIdx = i;
        for (let j = 0; j < s.words.length; j++) {
          const w = s.words[j];
          if (estimatedCharPos >= w.start && estimatedCharPos < w.end) {
            activeWordIdx = j;
            break;
          }
        }
        break;
      }
    }
    return { activeSentenceIdx, activeWordIdx };
  }, [estimatedCharPos, processedData]);

  useEffect(() => {
    if (viewMode === 'reader' && activeWordRef.current && scrollContainerRef.current) {
      activeWordRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeIndices.activeWordIdx, viewMode]);

  // --- Audio Control ---
  const initAudioContext = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }
    if (audioContextRef.current.state === 'suspended') audioContextRef.current.resume();
  };

  const playBuffer = (buffer: AudioBuffer, offset: number) => {
    if (!audioContextRef.current) return;
    if (sourceNodeRef.current) sourceNodeRef.current.stop();
    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = audioSpeed;
    source.connect(audioContextRef.current.destination);
    source.onended = () => {
      const contextTime = audioContextRef.current!.currentTime;
      const expectedEnd = startTimeRef.current + (buffer.duration / audioSpeed);
      if (contextTime >= expectedEnd - 0.2) {
        setIsAudioPlaying(false);
        setCurrentTime(buffer.duration);
      }
    };
    const when = audioContextRef.current.currentTime;
    source.start(when, offset / audioSpeed);
    sourceNodeRef.current = source;
    startTimeRef.current = when - (offset / audioSpeed);
  };

  const togglePlayback = () => {
    if (!currentAudioBufferRef.current || !audioContextRef.current) return;
    if (isAudioPlaying) {
      if (sourceNodeRef.current) {
        sourceNodeRef.current.stop();
        pausedTimeRef.current = (audioContextRef.current.currentTime - startTimeRef.current) * audioSpeed;
      }
      setIsAudioPlaying(false);
    } else {
      const startAt = pausedTimeRef.current >= currentAudioBufferRef.current.duration ? 0 : pausedTimeRef.current;
      playBuffer(currentAudioBufferRef.current, startAt);
      setIsAudioPlaying(true);
    }
  };

  const startSynthesis = async () => {
    if (!activeChapter || !activeChapter.content.trim()) return alert("Chapter content is empty.");
    try {
      setIsGeneratingAudio(true);
      setGenProgress(2);
      initAudioContext();
      
      const maxChunkChars = 1500;
      const textChunks: { text: string; start: number; end: number }[] = [];
      let currentChunkText = "";
      let currentStart = 0;
      
      for (let i = 0; i < processedData.length; i++) {
        const sentence = processedData[i];
        if ((currentChunkText + sentence.text).length > maxChunkChars && currentChunkText.length > 0) {
          textChunks.push({ text: currentChunkText, start: currentStart, end: currentStart + currentChunkText.length });
          currentChunkText = sentence.text;
          currentStart = sentence.start;
        } else {
          if (currentChunkText === "") currentStart = sentence.start;
          currentChunkText += sentence.text;
        }
      }
      if (currentChunkText) textChunks.push({ text: currentChunkText, start: currentStart, end: currentStart + currentChunkText.length });
      
      const audioPromises = textChunks.map(async (chunk) => {
        const sceneMeta = await geminiService.analyzeScene(chunk.text);
        const base64 = await geminiService.textToSpeech(chunk.text, selectedTones, gender, pitch, includeBreaths, sceneMeta);
        const bytes = decodeBase64(base64);
        const buffer = await decodeAudioData(bytes, audioContextRef.current!, 24000, 1);
        setGenProgress(prev => Math.min(98, prev + (95 / textChunks.length)));
        return { buffer, chunk, sceneMeta };
      });
      
      const results = await Promise.all(audioPromises);
      const totalSamples = results.reduce((acc, r) => acc + r.buffer.length, 0);
      const mergedBuffer = audioContextRef.current!.createBuffer(1, totalSamples, 24000);
      let sampleOffset = 0;
      let timeOffset = 0;
      const metadata: AudioChunkMetadata[] = [];
      
      results.forEach((res) => {
        mergedBuffer.getChannelData(0).set(res.buffer.getChannelData(0), sampleOffset);
        metadata.push({ 
          charStart: res.chunk.start, 
          charEnd: res.chunk.end, 
          audioStart: timeOffset, 
          audioEnd: timeOffset + res.buffer.duration,
          scene: res.sceneMeta
        });
        sampleOffset += res.buffer.length;
        timeOffset += res.buffer.duration;
      });
      
      currentAudioBufferRef.current = mergedBuffer;
      setAudioChunks(metadata);
      setDuration(mergedBuffer.duration);
      setCurrentTime(0);
      pausedTimeRef.current = 0;
      setGenProgress(100);
      setViewMode('reader');
      playBuffer(mergedBuffer, 0);
      setIsAudioPlaying(true);
      setTimeout(() => setIsGeneratingAudio(false), 800);
    } catch (e) {
      console.error(e);
      alert("Synthesis encountered an error.");
      setIsGeneratingAudio(false);
    }
  };

  const updateProgress = useCallback(() => {
    if (isAudioPlaying && audioContextRef.current && currentAudioBufferRef.current) {
      const elapsed = (audioContextRef.current.currentTime - startTimeRef.current) * audioSpeed;
      if (elapsed >= currentAudioBufferRef.current.duration) {
        setCurrentTime(currentAudioBufferRef.current.duration);
        setIsAudioPlaying(false);
      } else {
        setCurrentTime(elapsed);
        progressRequestRef.current = requestAnimationFrame(updateProgress);
      }
    }
  }, [isAudioPlaying, audioSpeed]);

  useEffect(() => {
    if (isAudioPlaying) progressRequestRef.current = requestAnimationFrame(updateProgress);
    else if (progressRequestRef.current) cancelAnimationFrame(progressRequestRef.current);
    return () => { if (progressRequestRef.current) cancelAnimationFrame(progressRequestRef.current); };
  }, [isAudioPlaying, updateProgress]);

  // --- Handlers ---
  const handleExportWav = () => {
    if (!currentAudioBufferRef.current) return;
    const blob = audioBufferToWav(currentAudioBufferRef.current);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Ivanchat_${(activeChapter?.title || 'Audiobook').replace(/\s+/g, '_')}.wav`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSavePreset = () => {
    if (!presetNameInput.trim()) return;
    const newPreset: VoicePreset = { 
      id: Date.now().toString(), 
      name: presetNameInput.trim(), 
      tones: [...selectedTones], 
      gender, 
      pitch, 
      includeBreaths, 
      speed: audioSpeed 
    };
    setPresets(prev => [...prev, newPreset]);
    setPresetNameInput('');
  };

  const handleLoadPreset = (p: VoicePreset) => {
    setSelectedTones(p.tones);
    setGender(p.gender);
    setPitch(p.pitch);
    setIncludeBreaths(p.includeBreaths);
    setAudioSpeed(p.speed);
  };

  const handleSaveChat = () => {
    if (messages.length === 0) return;
    const firstMsg = messages[0].text.substring(0, 30) + '...';
    const newSession: ChatSession = { 
      id: Date.now().toString(), 
      name: `Session: ${firstMsg}`, 
      messages: [...messages], 
      lastUpdated: new Date() 
    };
    setChatSessions(prev => [newSession, ...prev]);
  };

  const handleLoadChat = (s: ChatSession) => {
    setMessages([...s.messages]);
    setShowChat(true);
  };

  const handleDeleteChat = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setChatSessions(prev => prev.filter(s => s.id !== id));
  };

  const handleExtractCharacters = async () => {
    if (!novelText.trim()) return;
    setIsExtractingCharacters(true);
    try {
      const result = await geminiService.extractCharacters(novelText);
      setCharacters(result);
    } catch (e) { console.error(e); } finally { setIsExtractingCharacters(false); }
  };

  const handleSendMessage = async () => {
    if (!userInput.trim()) return;
    const msg: ChatMessage = { id: Date.now().toString(), role: 'user', text: userInput, timestamp: new Date() };
    setMessages(prev => [...prev, msg]);
    setUserInput('');
    setIsChatting(true);
    try {
      const hist = messages.map(m => ({ role: m.role, parts: [{ text: m.text }] }));
      const response = await geminiService.chat(userInput, novelText, characters, hist);
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text: response, timestamp: new Date() }]);
    } catch (e) { console.error(e); } finally { setIsChatting(false); }
  };

  const handleVoiceCommand = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      setIsTranscribing(true);
      processor.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      source.connect(processor);
      processor.connect(audioCtx.destination);
      setTimeout(async () => {
        source.disconnect();
        processor.disconnect();
        stream.getTracks().forEach(t => t.stop());
        setIsTranscribing(false);
        const fullBuffer = new Float32Array(chunks.reduce((acc, c) => acc + c.length, 0));
        let offset = 0;
        chunks.forEach(c => { fullBuffer.set(c, offset); offset += c.length; });
        const transcript = await geminiService.transcribeAudio(encodeBase64(floatTo16BitPCM(fullBuffer)));
        if (transcript) {
          setUserInput(transcript);
          if (transcript.length > 5) handleSendMessage();
        }
      }, 4000);
    } catch (e) {
      alert("Microphone access is required.");
      setIsTranscribing(false);
    }
  };

  return (
    <div className="flex h-screen bg-slate-50 dark:bg-slate-950 overflow-hidden text-slate-900 dark:text-slate-100 font-sans transition-colors duration-500">
      {/* SIDEBAR */}
      <aside className="w-80 border-r dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col shadow-sm z-10 shrink-0">
        <div className="p-6 border-b dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {appIcon ? (
              <img src={appIcon} alt="Ivanchat Logo" className="w-10 h-10 rounded-xl shadow-sm transition-transform" />
            ) : (
              <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center animate-pulse">
                <SparklesIcon className="w-6 h-6 text-white" />
              </div>
            )}
            <h1 className="text-xl font-bold tracking-tight">Ivanchat</h1>
          </div>
          <button onClick={() => setIsDarkMode(!isDarkMode)} className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:text-indigo-600 transition-all">
            {isDarkMode ? <SunIcon className="w-5 h-5" /> : <MoonIcon className="w-5 h-5" />}
          </button>
        </div>

        <div className="p-6 flex-1 overflow-y-auto space-y-8 scrollbar-hide">
          {isGeneratingBranding && (
            <div className="flex items-center gap-3 p-3 bg-indigo-50 dark:bg-indigo-900/20 rounded-xl border border-indigo-100 dark:border-indigo-800 animate-pulse">
              <ArrowPathIcon className="w-4 h-4 text-indigo-600 animate-spin" />
              <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-widest">Generating Identity...</span>
            </div>
          )}

          {/* WORKSPACE MODE */}
          <section>
            <div className="flex items-center gap-2 mb-4 text-slate-400 font-bold uppercase text-[10px] tracking-widest">
              <EyeIcon className="w-4 h-4" /> Workspace Mode
            </div>
            <div className="flex p-1 bg-slate-100 dark:bg-slate-800 rounded-xl">
              <button 
                onClick={() => setViewMode('editor')} 
                className={`flex-1 py-2 text-xs rounded-lg transition-all flex items-center justify-center gap-2 ${viewMode === 'editor' ? 'bg-white dark:bg-slate-700 shadow-sm font-bold text-indigo-600' : 'text-slate-400'}`}
              >
                <PencilSquareIcon className="w-4 h-4" /> Editor
              </button>
              <button 
                onClick={() => setViewMode('reader')} 
                className={`flex-1 py-2 text-xs rounded-lg transition-all flex items-center justify-center gap-2 ${viewMode === 'reader' ? 'bg-white dark:bg-slate-700 shadow-sm font-bold text-indigo-600' : 'text-slate-400'}`}
              >
                <BookOpenIcon className="w-4 h-4" /> Reader
              </button>
            </div>
          </section>

          {/* CHAPTERS */}
          <section>
            <div className="flex items-center gap-2 mb-4 text-slate-400 font-bold uppercase text-[10px] tracking-widest">
              <HashtagIcon className="w-4 h-4" /> Chapters
            </div>
            <div className="space-y-1 max-h-48 overflow-y-auto scrollbar-hide">
              {chapters.map((ch) => (
                <button 
                  key={ch.id} 
                  onClick={() => setSelectedChapterId(ch.id)}
                  className={`w-full text-left px-3 py-2 rounded-xl text-xs transition-all flex items-center gap-3 ${selectedChapterId === ch.id ? 'bg-indigo-600 text-white shadow-lg' : 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}`}
                >
                  <span className="opacity-50 font-mono">#{ch.id.split('-')[1] || '0'}</span>
                  <span className="truncate font-medium">{ch.title}</span>
                </button>
              ))}
            </div>
          </section>

          {/* CHARACTERS */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 flex items-center gap-2">
                <UserGroupIcon className="w-4 h-4" /> Characters
              </span>
              <button onClick={handleExtractCharacters} disabled={isExtractingCharacters} className="text-indigo-600 hover:scale-110 transition-transform disabled:opacity-30">
                <SparklesIcon className={`w-4 h-4 ${isExtractingCharacters ? 'animate-pulse' : ''}`} />
              </button>
            </div>
            <div className="space-y-2">
              {characters.length === 0 ? (
                <div className="text-[10px] text-center p-4 border border-dashed rounded-lg opacity-40 italic">Scan manuscript for bios...</div>
              ) : (
                characters.slice(0, 4).map((c, i) => (
                  <div key={i} className="group relative bg-slate-50 dark:bg-slate-800/50 p-3 rounded-xl border dark:border-slate-800 hover:border-indigo-400 transition-all">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-xs font-bold">{c.name}</span>
                      <span className="text-[8px] uppercase px-1 bg-slate-200 dark:bg-slate-700 rounded font-mono">{c.role}</span>
                    </div>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 line-clamp-1">{c.description}</p>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* NARRATIVE PRESETS */}
          <section>
            <div className="flex items-center gap-2 mb-4 text-slate-400 font-bold uppercase text-[10px] tracking-widest">
              <BookmarkIcon className="w-4 h-4" /> Narrative Presets
            </div>
            <div className="space-y-3">
              <div className="flex gap-2">
                <input 
                  type="text" 
                  value={presetNameInput} 
                  onChange={e => setPresetNameInput(e.target.value)} 
                  placeholder="Profile Name..." 
                  className="flex-1 text-[10px] bg-slate-50 dark:bg-slate-800 border dark:border-slate-800 rounded-lg px-2 py-2 outline-none focus:ring-1 ring-indigo-500" 
                />
                <button onClick={handleSavePreset} title="Save current settings" disabled={!presetNameInput.trim()} className="bg-indigo-600 text-white p-2 rounded-lg disabled:opacity-30">
                  <PlusIcon className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-1 gap-1 max-h-32 overflow-y-auto scrollbar-hide">
                {presets.map(p => (
                  <div key={p.id} className="flex items-center justify-between bg-white dark:bg-slate-800 p-2 rounded-xl border dark:border-slate-800 group hover:border-indigo-400 transition-all">
                    <button onClick={() => handleLoadPreset(p)} className="flex-1 text-left text-[11px] font-medium truncate px-2">{p.name}</button>
                    <button onClick={() => setPresets(prev => prev.filter(x => x.id !== p.id))} className="p-1 text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">
                      <TrashIcon className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* VOICE SYNTHESIS */}
          <section>
            <div className="flex items-center gap-2 mb-4 text-slate-400 font-bold uppercase text-[10px] tracking-widest">
              <UserIcon className="w-4 h-4" /> Voice Synthesis
            </div>
            <div className="flex p-1 bg-slate-100 dark:bg-slate-800 rounded-xl">
              {Object.values(VoiceGender).map(g => (
                <button 
                  key={g} 
                  onClick={() => setGender(g)} 
                  className={`flex-1 py-2 text-xs rounded-lg transition-all ${gender === g ? 'bg-white dark:bg-slate-700 shadow-sm font-bold text-indigo-600' : 'text-slate-400'}`}
                >
                  {g}
                </button>
              ))}
            </div>
          </section>

          {/* NARRATIVE BLEND */}
          <section>
            <div className="flex items-center gap-2 mb-4 text-slate-400 font-bold uppercase text-[10px] tracking-widest">
              <AdjustmentsHorizontalIcon className="w-4 h-4" /> Narrative Blend
            </div>
            <div className="grid grid-cols-2 gap-2">
              {Object.values(ReadingTone).map(t => (
                <button 
                  key={t} 
                  onClick={() => setSelectedTones(prev => prev.includes(t) ? (prev.length > 1 ? prev.filter(x => x !== t) : prev) : [...prev, t])} 
                  className={`px-2 py-1.5 rounded-lg text-[10px] border transition-all ${selectedTones.includes(t) ? 'bg-indigo-600 border-indigo-600 text-white shadow-md' : 'border-slate-200 dark:border-slate-800 text-slate-400 hover:border-indigo-300'}`}
                >
                  {t}
                </button>
              ))}
            </div>
          </section>

          {/* MODULATION */}
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-slate-400 font-bold uppercase text-[10px] tracking-widest">
              <VariableIcon className="w-4 h-4" /> Modulation
            </div>
            <div className="bg-slate-50 dark:bg-slate-800/50 p-4 rounded-xl space-y-4 border dark:border-slate-800">
               <div className="space-y-1">
                  <div className="flex justify-between text-[10px] font-bold"><span>Pitch Shift</span><span>{pitch}%</span></div>
                  <input type="range" min="-30" max="30" value={pitch} onChange={e => setPitch(parseInt(e.target.value))} className="w-full h-1 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-600" />
               </div>
               <div className="flex items-center justify-between text-[10px] font-bold uppercase">
                  <span>Natural Breaths</span>
                  <button onClick={() => setIncludeBreaths(!includeBreaths)} className={`w-10 h-5 rounded-full relative transition-colors duration-200 ${includeBreaths ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-slate-700'}`}>
                    <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform duration-200 ${includeBreaths ? 'translate-x-5' : ''}`} />
                  </button>
               </div>
            </div>
          </section>

          <section>
            <button 
              onClick={startSynthesis} 
              disabled={isGeneratingAudio} 
              className="w-full bg-indigo-600 text-white py-4 rounded-xl font-bold text-sm shadow-xl shadow-indigo-600/20 hover:bg-indigo-700 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {isGeneratingAudio ? <ArrowPathIcon className="w-5 h-5 animate-spin" /> : <PlayIcon className="w-5 h-5" />}
              {isGeneratingAudio ? `Synthesizing ${Math.round(genProgress)}%` : 'Generate Audiobook'}
            </button>
          </section>
        </div>
      </aside>

      {/* MAIN PANEL */}
      <main className="flex-1 flex flex-col relative min-w-0 transition-colors duration-500">
        <div 
          className="flex-1 overflow-y-auto p-4 sm:p-8 lg:p-12 scrollbar-hide transition-[padding]" 
          ref={scrollContainerRef}
          style={{ paddingBottom: showSponsored ? '200px' : undefined }}
        >
          <div className="max-w-4xl mx-auto space-y-8">
            <header className="flex justify-between items-center border-b dark:border-slate-800 pb-6">
              <div className="flex items-center gap-6">
                {appIcon && (
                  <div className="hidden sm:block">
                    <img src={appIcon} alt="Ivanchat Logo" className="w-16 h-16 rounded-2xl shadow-xl border-4 border-white dark:border-slate-800" />
                  </div>
                )}
                <div>
                  <h2 className="text-3xl font-serif font-bold tracking-tight text-slate-800 dark:text-slate-100">{viewMode === 'editor' ? 'Manuscript Editor' : 'Immersive Reader'}</h2>
                  <p className="text-xs font-bold text-slate-400 mt-1 uppercase tracking-widest">{activeChapter?.title || 'No active chapter'}</p>
                </div>
              </div>
              <div className="flex items-center gap-6">
                <div className="hidden md:flex items-center gap-2 px-3 py-1 bg-slate-100 dark:bg-slate-800 rounded-full text-[10px] font-bold text-slate-400 uppercase">
                  <ClockIcon className="w-3 h-3" />
                  <span>{(activeChapter?.content || '').trim().split(/\s+/).filter(x => x.length > 0).length} Words</span>
                </div>
                <button onClick={() => { setNovelText(''); setCharacters([]); setMessages([]); }} className="text-[10px] text-slate-400 hover:text-red-500 font-bold uppercase tracking-widest transition-colors">Clear All</button>
              </div>
            </header>

            <article className="min-h-[70vh]">
              {viewMode === 'reader' && duration > 0 && (
                <div className="sticky top-0 z-20 py-4 bg-slate-50/80 dark:bg-slate-950/80 backdrop-blur-md mb-8">
                   <div className="flex items-center gap-4">
                      <button onClick={togglePlayback} className="p-3 bg-indigo-600 text-white rounded-full shadow-lg hover:scale-105 transition-transform active:scale-95">
                        {isAudioPlaying ? <PauseIcon className="w-6 h-6" /> : <PlayIcon className="w-6 h-6" />}
                      </button>
                      <div className="flex-1 space-y-1">
                        <div className="flex justify-between text-[9px] font-mono font-bold text-slate-400">
                          <span>{new Date(currentTime * 1000).toISOString().substr(14, 5)}</span>
                          <span>{new Date(duration * 1000).toISOString().substr(14, 5)}</span>
                        </div>
                        <input type="range" min="0" max={duration} step="0.1" value={currentTime} onChange={e => {
                          const val = parseFloat(e.target.value);
                          setCurrentTime(val);
                          pausedTimeRef.current = val;
                          if (isAudioPlaying) playBuffer(currentAudioBufferRef.current!, val);
                        }} className="w-full h-1 accent-indigo-600 bg-slate-200 dark:bg-slate-800 rounded-full appearance-none cursor-pointer" />
                      </div>
                      <div className="flex items-center gap-2">
                         <div className="flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-slate-800 rounded-xl border dark:border-slate-700 shadow-sm">
                            <SpeakerWaveIcon className="w-4 h-4 text-slate-400" />
                            <select value={audioSpeed} onChange={e => setAudioSpeed(parseFloat(e.target.value))} className="bg-transparent text-[10px] font-bold outline-none border-none cursor-pointer">
                               <option value="0.75">0.75x</option>
                               <option value="1.0">1.0x</option>
                               <option value="1.25">1.25x</option>
                               <option value="1.5">1.5x</option>
                               <option value="2.0">2.0x</option>
                            </select>
                         </div>
                         <button 
                           onClick={handleExportWav} 
                           title="Export as .WAV"
                           className="p-2 bg-slate-100 dark:bg-slate-800 rounded-xl hover:text-indigo-600 transition-colors"
                         >
                           <ArrowDownOnSquareIcon className="w-5 h-5" />
                         </button>
                      </div>
                   </div>
                </div>
              )}

              {viewMode === 'editor' ? (
                <textarea 
                  value={novelText} 
                  onChange={e => setNovelText(e.target.value)} 
                  placeholder="Paste or write your novel content here... Use # for Chapters!" 
                  className="w-full h-[75vh] p-8 sm:p-12 bg-white dark:bg-slate-900 rounded-[2rem] shadow-xl border-none focus:ring-4 focus:ring-indigo-600/5 font-serif text-xl leading-relaxed resize-none scrollbar-hide" 
                />
              ) : (
                <div className="w-full min-h-[75vh] p-8 sm:p-12 bg-white dark:bg-slate-900 rounded-[2rem] shadow-xl font-serif text-xl leading-relaxed text-slate-800 dark:text-slate-100 whitespace-pre-wrap">
                  {processedData.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-40 opacity-10">
                      <BookOpenIcon className="w-24 h-24 mb-4" />
                      <p className="font-sans font-bold uppercase tracking-widest">Library is Empty</p>
                    </div>
                  ) : (
                    processedData.map((s, si) => (
                      <span key={si} className={`inline-block rounded transition-all duration-700 ${si === activeIndices.activeSentenceIdx ? 'bg-indigo-600/5 dark:bg-indigo-400/10' : ''}`}>
                        {s.words.map((w, wi) => {
                          const isWordActive = si === activeIndices.activeSentenceIdx && wi === activeIndices.activeWordIdx;
                          return (
                            <span key={wi} ref={isWordActive ? activeWordRef : null} className={`inline-block px-0.5 rounded transition-all duration-300 ${isWordActive ? 'bg-indigo-600 text-white shadow-lg' : 'opacity-100'}`}>
                              {w.text}{' '}
                            </span>
                          );
                        })}
                      </span>
                    ))
                  )}
                </div>
              )}
            </article>
          </div>
        </div>

        {/* CHATBOT & AD COMPONENT */}
        {showChat && (
          <div className="absolute bottom-10 right-10 w-[420px] h-[650px] flex flex-col glass-panel rounded-[2.5rem] shadow-[0_50px_100px_-20px_rgba(0,0,0,0.2)] overflow-hidden border border-white dark:border-slate-800 transition-all z-50">
            <header className="p-8 bg-indigo-600 text-white flex justify-between items-center relative overflow-hidden group shrink-0">
              <div className="flex items-center gap-4 relative z-10">
                {appIcon ? (
                  <img src={appIcon} alt="Logo" className="w-8 h-8 rounded-lg brightness-110" />
                ) : (
                  <ChatBubbleLeftRightIcon className="w-8 h-8" />
                )}
                <h3 className="font-bold text-lg tracking-tight">Literary Expert</h3>
              </div>
              <div className="flex gap-2 relative z-10">
                <button onClick={() => setMessages([])} title="New Chat" className="bg-white/10 p-2 rounded-2xl hover:bg-white/20 transition-colors"><PlusIcon className="w-5 h-5" /></button>
                <button onClick={handleSaveChat} title="Archive Session" className="bg-white/10 p-2 rounded-2xl hover:bg-white/20 transition-colors"><ArrowDownTrayIcon className="w-5 h-5" /></button>
                <button onClick={() => setShowChat(false)} className="bg-white/10 p-2 rounded-2xl hover:bg-white/20 transition-colors"><XMarkIcon className="w-5 h-5" /></button>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto p-8 space-y-6 scrollbar-hide bg-white/40 dark:bg-slate-900/40 backdrop-blur-3xl">
              {messages.length === 0 && (
                <div className="text-center py-20 space-y-4 opacity-30">
                  <div className="w-16 h-16 bg-indigo-50 dark:bg-indigo-900/20 rounded-full flex items-center justify-center mx-auto">
                    <ChatBubbleLeftRightIcon className="w-8 h-8 text-indigo-400" />
                  </div>
                  <p className="text-xs font-bold uppercase tracking-widest">Analysis Engine Active</p>
                  <p className="text-[10px] italic max-w-[180px] mx-auto">Ask about current chapter plot or character motivations.</p>
                </div>
              )}
              {messages.map((m) => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] p-5 rounded-[2rem] text-sm leading-relaxed shadow-sm ${m.role === 'user' ? 'bg-indigo-600 text-white rounded-tr-none' : 'bg-white dark:bg-slate-800 border dark:border-slate-700 rounded-tl-none text-slate-700 dark:text-slate-200'}`}>
                    {m.text}
                  </div>
                </div>
              ))}
              {isChatting && (
                <div className="flex justify-start items-center gap-2">
                   <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                   <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                   <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" />
                   <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-2">Consulting Manuscript</span>
                </div>
              )}
            </div>

            <footer className="p-6 bg-white/90 dark:bg-slate-900/90 border-t dark:border-slate-800 backdrop-blur-md shrink-0">
              <div className="flex gap-3">
                <input 
                  type="text" 
                  value={userInput} 
                  onChange={e => setUserInput(e.target.value)} 
                  onKeyDown={e => e.key === 'Enter' && handleSendMessage()} 
                  placeholder="Ask about your story..." 
                  className="flex-1 px-6 py-4 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-[1.8rem] outline-none text-sm placeholder:italic focus:ring-2 ring-indigo-500/20" 
                />
                <button 
                  onClick={handleVoiceCommand} 
                  className={`p-4 rounded-full transition-all ${isTranscribing ? 'bg-red-500 text-white animate-pulse' : 'bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-indigo-600'}`}
                >
                  <MicrophoneIcon className="w-6 h-6" />
                </button>
                <button 
                  onClick={handleSendMessage} 
                  disabled={isChatting || !userInput.trim()} 
                  className="bg-indigo-600 text-white p-4 rounded-full shadow-lg shadow-indigo-600/20 hover:scale-110 active:scale-95 transition-all disabled:opacity-30"
                >
                  <ArrowPathIcon className={`w-6 h-6 ${isChatting ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </footer>
          </div>
        )}

        {!showChat && (
          <button onClick={() => setShowChat(true)} className="absolute bottom-12 right-12 w-16 h-16 bg-indigo-600 text-white rounded-[2rem] flex items-center justify-center shadow-2xl hover:scale-110 active:scale-95 transition-all z-50">
            <ChatBubbleLeftRightIcon className="w-8 h-8" />
          </button>
        )}

        {/* SPONSORED BANNER */}
        {showSponsored && (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 w-full max-w-md px-4 z-[60]">
            <div className="bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden relative">
              <div className="flex items-center justify-between px-4 py-2 bg-slate-50 dark:bg-slate-800/50">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Sponsored Support</span>
                <button onClick={() => { setShowSponsored(false); sessionStorage.setItem('ivanchat_dismissed_sponsored', 'true'); }} className="p-1 hover:text-red-500 transition-colors"><XMarkIcon className="w-4 h-4" /></button>
              </div>
              <div className="p-4 h-32">
                <GoogleAdSenseUnit slot="BANNER_01" format="horizontal" />
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;