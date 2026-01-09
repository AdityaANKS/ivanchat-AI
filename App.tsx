
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ReadingTone, VoiceGender, ChatMessage, CharacterBio, VoicePreset, ChatSession, SceneMetadata, Chapter } from './types.ts';
import { geminiService } from './services/geminiService.ts';
import { decodeBase64, decodeAudioData, audioBufferToWav, audioBufferToMp4, saveAudioToDB, getAudioFromDB } from './services/audioService.ts';
import { 
  PlayIcon, 
  PauseIcon, 
  ChatBubbleLeftRightIcon, 
  ArrowPathIcon,
  BookOpenIcon,
  AdjustmentsHorizontalIcon,
  SpeakerWaveIcon,
  UserIcon,
  MoonIcon,
  SunIcon,
  UserGroupIcon,
  SparklesIcon,
  PencilSquareIcon,
  HashtagIcon,
  ArrowDownOnSquareIcon,
  ArrowDownTrayIcon,
  Bars3Icon,
  VideoCameraIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  InformationCircleIcon,
  CloudArrowUpIcon,
  XMarkIcon,
  ClockIcon,
  EyeIcon
} from '@heroicons/react/24/outline';

interface AudioChunkMetadata {
  charStart: number;
  charEnd: number;
  audioStart: number;
  audioEnd: number;
  scene?: SceneMetadata;
}

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

const AdUnit: React.FC<{ className?: string; slot?: string }> = ({ className = '', slot = '9677805119' }) => {
  useEffect(() => {
    try {
      ((window as any).adsbygoogle = (window as any).adsbygoogle || []).push({});
    } catch (e) {
      console.warn("AdSense push failed:", e);
    }
  }, []);

  return (
    <div className={`ad-container bg-slate-100/30 dark:bg-slate-800/20 rounded-2xl overflow-hidden p-2 text-center text-[8px] text-slate-400 font-bold uppercase tracking-widest border border-dashed border-slate-300/30 dark:border-slate-700/30 transition-all ${className}`}>
      <span className="block mb-1 opacity-30">ADVERTISEMENT</span>
      <ins className="adsbygoogle"
           style={{ display: 'block' }}
           data-ad-client="ca-pub-5322028632012246"
           data-ad-slot={slot}
           data-ad-format="horizontal"
           data-full-width-responsive="true"></ins>
    </div>
  );
};

const App: React.FC = () => {
  // --- States ---
  const [appLogo, setAppLogo] = useState<string>(() => localStorage.getItem('ivanchat_app_logo') || '');
  const [isGeneratingLogo, setIsGeneratingLogo] = useState(false);
  const [novelText, setNovelText] = useState<string>(() => localStorage.getItem('ivanchat_novel_text') || '');
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'drafting'>('saved');
  const [characters, setCharacters] = useState<CharacterBio[]>(() => {
    const stored = localStorage.getItem('ivanchat_characters');
    return stored ? JSON.parse(stored) : [];
  });
  const [selectedTones, setSelectedTones] = useState<ReadingTone[]>([ReadingTone.NEUTRAL]);
  const [gender, setGender] = useState<VoiceGender>(VoiceGender.MALE);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [userInput, setUserInput] = useState('');
  const [isChatting, setIsChatting] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isRenderingVideo, setIsRenderingVideo] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const stored = localStorage.getItem('ivanchat_theme');
    return stored ? stored === 'dark' : true;
  });
  const [viewMode, setViewMode] = useState<'editor' | 'reader'>('editor');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [audioSpeed, setAudioSpeed] = useState(1.0); // Default to 1.0x as requested
  const [pitch, setPitch] = useState(0);
  const [includeBreaths, setIncludeBreaths] = useState(true);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isGeneratingAudio, setIsGeneratingAudio] = useState(false);
  const [isExtractingCharacters, setIsExtractingCharacters] = useState(false);
  const [genProgress, setGenProgress] = useState(0);
  const [audioChunks, setAudioChunks] = useState<AudioChunkMetadata[]>([]);
  const [showChat, setShowChat] = useState(false);

  // --- Refs ---
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const currentAudioBufferRef = useRef<AudioBuffer | null>(null);
  const startTimeRef = useRef<number>(0);
  const pausedTimeRef = useRef<number>(0);
  const progressRequestRef = useRef<number | null>(null);
  const activeWordRef = useRef<HTMLSpanElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // --- Utils ---
  const addToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'success') => {
    const id = Date.now().toString();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4500);
  }, []);

  // --- Theme ---
  useEffect(() => {
    if (isDarkMode) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, [isDarkMode]);

  // --- Auto-Save ---
  const performSave = useCallback(() => {
    setSaveStatus('saving');
    localStorage.setItem('ivanchat_novel_text', novelText);
    localStorage.setItem('ivanchat_characters', JSON.stringify(characters));
    localStorage.setItem('ivanchat_theme', isDarkMode ? 'dark' : 'light');
    setTimeout(() => setSaveStatus('saved'), 600);
  }, [novelText, characters, isDarkMode]);

  useEffect(() => {
    if (saveStatus === 'saved') setSaveStatus('drafting');
    const timer = setTimeout(performSave, 1500);
    return () => clearTimeout(timer);
  }, [novelText, characters, performSave]);

  // --- Logo Generation ---
  useEffect(() => {
    const initLogo = async () => {
      if (!appLogo) {
        setIsGeneratingLogo(true);
        try {
          const generated = await geminiService.generateAppLogo();
          setAppLogo(generated);
          localStorage.setItem('ivanchat_app_logo', generated);
        } catch (e) {
          console.error("Logo generation failed:", e);
        } finally {
          setIsGeneratingLogo(false);
        }
      }
    };
    initLogo();
  }, [appLogo]);

  // --- Chapter Logic ---
  const chapters = useMemo(() => {
    const textToParse = (novelText || '').trim();
    if (!textToParse) return [{ id: 'full', title: 'Full Manuscript', content: '', startIndex: 0 }];
    const chapterRegex = /(?:^|\n)(?:Chapter\s+\d+|#\s+.+|(?:CHAPTER|Chapter)\s+\w+)/gi;
    let match;
    const found: Chapter[] = [];
    while ((match = chapterRegex.exec(textToParse)) !== null) {
      const start = match.index;
      const end = textToParse.indexOf('\n', chapterRegex.lastIndex);
      found.push({ id: `ch-${found.length}`, title: match[0].trim(), content: '', startIndex: start });
    }
    if (found.length === 0) return [{ id: 'full', title: 'Full Manuscript', content: textToParse, startIndex: 0 }];
    
    return found.map((ch, i) => {
      const nextStart = found[i + 1] ? found[i + 1].startIndex : textToParse.length;
      return { ...ch, content: textToParse.substring(ch.startIndex, nextStart) };
    });
  }, [novelText]);

  const [selectedChapterId, setSelectedChapterId] = useState<string>('full');
  const activeChapter = useMemo(() => chapters.find(c => c.id === selectedChapterId) || chapters[0], [chapters, selectedChapterId]);

  // --- Text Analysis & Highlighting Prep ---
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

  // --- Audio Progress & Tracking ---
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

  // --- Playback Controls ---
  const playBuffer = (buffer: AudioBuffer, offset: number) => {
    if (!audioContextRef.current) audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    if (audioContextRef.current.state === 'suspended') audioContextRef.current.resume();
    
    if (sourceNodeRef.current) sourceNodeRef.current.stop();
    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = audioSpeed;
    source.connect(audioContextRef.current.destination);
    
    source.onended = () => {
       const elapsedSinceStart = (audioContextRef.current!.currentTime - startTimeRef.current) * audioSpeed;
       if (elapsedSinceStart >= buffer.duration - 0.2) setIsAudioPlaying(false);
    };

    source.start(0, offset / audioSpeed);
    sourceNodeRef.current = source;
    startTimeRef.current = audioContextRef.current.currentTime - (offset / audioSpeed);
  };

  const togglePlayback = () => {
    if (!currentAudioBufferRef.current) return;
    if (isAudioPlaying) {
      if (sourceNodeRef.current) {
        sourceNodeRef.current.stop();
        pausedTimeRef.current = (audioContextRef.current!.currentTime - startTimeRef.current) * audioSpeed;
      }
      setIsAudioPlaying(false);
      addToast("Paused", "info");
    } else {
      const startAt = pausedTimeRef.current >= currentAudioBufferRef.current.duration ? 0 : pausedTimeRef.current;
      playBuffer(currentAudioBufferRef.current, startAt);
      setIsAudioPlaying(true);
      addToast("Playing", "success");
    }
  };

  const handleSeek = (v: number) => {
    setCurrentTime(v);
    pausedTimeRef.current = v;
    if (isAudioPlaying && currentAudioBufferRef.current) {
      playBuffer(currentAudioBufferRef.current, v);
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

  // --- Synthesis (Parallel Processing) ---
  const startSynthesis = async () => {
    if (!activeChapter?.content.trim()) return addToast("Provide manuscript text", "error");
    try {
      setIsGeneratingAudio(true);
      setGenProgress(0);
      setIsSidebarOpen(false);
      
      const maxChars = 900;
      const rawChunks: { text: string; start: number; end: number }[] = [];
      let currentBatchText = "";
      let currentBatchStart = 0;
      
      for (const s of processedData) {
        if ((currentBatchText + s.text).length > maxChars && currentBatchText.length > 0) {
          rawChunks.push({ text: currentBatchText, start: currentBatchStart, end: currentBatchStart + currentBatchText.length });
          currentBatchText = s.text;
          currentBatchStart = s.start;
        } else {
          if (currentBatchText === "") currentBatchStart = s.start;
          currentBatchText += s.text;
        }
      }
      if (currentBatchText) rawChunks.push({ text: currentBatchText, start: currentBatchStart, end: currentBatchStart + currentBatchText.length });
      
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const results: { buffer: AudioBuffer; meta: SceneMetadata; chunk: any }[] = new Array(rawChunks.length);
      
      const concurrencyLimit = 5;
      for (let i = 0; i < rawChunks.length; i += concurrencyLimit) {
        const batch = rawChunks.slice(i, i + concurrencyLimit);
        await Promise.all(batch.map(async (c, bIdx) => {
          const globalIdx = i + bIdx;
          const meta = await geminiService.analyzeScene(c.text);
          const b64 = await geminiService.textToSpeech(c.text, selectedTones, gender, pitch, includeBreaths, meta);
          const buffer = await decodeAudioData(decodeBase64(b64), ctx, 24000, 1);
          results[globalIdx] = { buffer, meta, chunk: c };
          setGenProgress((results.filter(Boolean).length / rawChunks.length) * 100);
        }));
      }
      
      const totalSamples = results.reduce((acc, r) => acc + r.buffer.length, 0);
      const merged = ctx.createBuffer(1, totalSamples, 24000);
      let sampleOffset = 0;
      let timeOffset = 0;
      const metaArr: AudioChunkMetadata[] = [];

      results.forEach(r => {
        merged.getChannelData(0).set(r.buffer.getChannelData(0), sampleOffset);
        metaArr.push({
          charStart: r.chunk.start,
          charEnd: r.chunk.end,
          audioStart: timeOffset,
          audioEnd: timeOffset + r.buffer.duration,
          scene: r.meta
        });
        sampleOffset += r.buffer.length;
        timeOffset += r.buffer.duration;
      });

      currentAudioBufferRef.current = merged;
      setAudioChunks(metaArr);
      setDuration(merged.duration);
      setCurrentTime(0);
      pausedTimeRef.current = 0;
      setViewMode('reader');
      
      await saveAudioToDB(`audio_${selectedChapterId}`, audioBufferToWav(merged));
      localStorage.setItem(`ivanchat_meta_${selectedChapterId}`, JSON.stringify(metaArr));
      
      audioContextRef.current = ctx;
      playBuffer(merged, 0);
      setIsAudioPlaying(true);
      addToast("Audiobook ready", "success");
      setIsGeneratingAudio(false);
    } catch (e) {
      console.error(e);
      addToast("Synthesis failed. Check connectivity.", "error");
      setIsGeneratingAudio(false);
    }
  };

  // --- Exports & Utils ---
  const handleExportWav = () => {
    if (!currentAudioBufferRef.current) return addToast("No narration found", "error");
    const blob = audioBufferToWav(currentAudioBufferRef.current);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Ivanchat_${(activeChapter?.title || 'Story').replace(/\s+/g, '_')}.wav`;
    a.click();
    URL.revokeObjectURL(url);
    addToast("WAV Downloaded", "success");
  };

  const handleExportMp4 = async () => {
    if (!currentAudioBufferRef.current) return addToast("Generate audio first", "error");
    setIsRenderingVideo(true);
    try {
      const blob = await audioBufferToMp4(currentAudioBufferRef.current, activeChapter?.title || 'Narration', appLogo);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Ivanchat_${(activeChapter?.title || 'Narrative').replace(/\s+/g, '_')}.webm`;
      a.click();
      URL.revokeObjectURL(url);
      addToast("Video Rendered", "success");
    } catch (e) {
      addToast("Video failed", "error");
    } finally {
      setIsRenderingVideo(false);
    }
  };

  const handleExtractCharacters = async () => {
    if (!novelText.trim()) return addToast("Manuscript is empty", "info");
    setIsExtractingCharacters(true);
    try {
      const result = await geminiService.extractCharacters(novelText);
      setCharacters(result);
      addToast(`${result.length} characters found`, "success");
    } catch (e) { 
      addToast("Analysis failed", "error"); 
    } finally { 
      setIsExtractingCharacters(false); 
    }
  };

  // --- Chat Functions ---
  const handleSaveChat = () => {
    if (messages.length === 0) return addToast("No messages to archive", "info");
    const chatContent = messages.map(m => `[${m.role.toUpperCase()}] ${m.timestamp.toLocaleString()}:\n${m.text}`).join('\n\n---\n\n');
    const blob = new Blob([chatContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Ivanchat_Archive_${new Date().toISOString().split('T')[0]}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    addToast("Chat history archived", "success");
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
    } catch (e) { 
      addToast("AI Offline", "error"); 
    } finally { 
      setIsChatting(false); 
    }
  };

  return (
    <div className="flex h-screen-safe bg-slate-50 dark:bg-slate-950 overflow-hidden text-slate-900 dark:text-slate-100 font-sans transition-colors duration-500 relative">
      
      {/* TOAST SYSTEM */}
      <div className="fixed top-6 right-6 z-[200] flex flex-col gap-3 pointer-events-none w-full max-w-sm px-4">
        {toasts.map(t => (
          <div key={t.id} className={`
            pointer-events-auto flex items-center gap-3 px-5 py-4 rounded-2xl shadow-2xl border backdrop-blur-xl animate-in slide-in-from-right duration-300
            ${t.type === 'success' ? 'bg-indigo-600/90 border-indigo-400 text-white' : 
              t.type === 'error' ? 'bg-rose-600/90 border-rose-400 text-white' : 
              'bg-white/90 dark:bg-slate-800/90 border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white'}
          `}>
            {t.type === 'success' && <CheckCircleIcon className="w-6 h-6 shrink-0" />}
            {t.type === 'error' && <ExclamationCircleIcon className="w-6 h-6 shrink-0" />}
            {t.type === 'info' && <InformationCircleIcon className="w-6 h-6 shrink-0" />}
            <span className="text-sm font-semibold flex-1">{t.message}</span>
            <button onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))} className="opacity-50 hover:opacity-100"><XMarkIcon className="w-4 h-4" /></button>
          </div>
        ))}
      </div>

      {/* RENDER OVERLAY */}
      {isRenderingVideo && (
        <div className="fixed inset-0 z-[100] bg-slate-900/80 backdrop-blur-xl flex flex-col items-center justify-center text-white p-8">
           <div className="w-20 h-20 bg-indigo-600 rounded-3xl flex items-center justify-center animate-spin mb-6">
             <VideoCameraIcon className="w-10 h-10 text-white" />
           </div>
           <h2 className="text-2xl font-bold mb-2">Generating WebM...</h2>
           <p className="text-slate-400 text-center max-w-sm">Combining narration and branding into high-quality video format.</p>
        </div>
      )}

      {/* SIDEBAR */}
      <aside className={`
        fixed inset-y-0 left-0 z-40 w-[280px] sm:w-[320px] bg-white dark:bg-slate-900 border-r dark:border-slate-800 shadow-2xl transition-transform duration-300 transform 
        lg:translate-x-0 lg:static lg:block lg:shadow-none
        ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}
       flex flex-col shrink-0`}>
        <div className="p-6 border-b dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center overflow-hidden shadow-indigo-600/10 shadow-lg relative">
               {isGeneratingLogo ? <SparklesIcon className="w-6 h-6 text-white animate-pulse" /> : <img src={appLogo} alt="Logo" className="w-full h-full object-cover" />}
            </div>
            <h1 className="text-xl font-bold tracking-tight">Ivanchat</h1>
          </div>
          <button onClick={() => setIsDarkMode(!isDarkMode)} className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:text-indigo-600 transition-all">
            {isDarkMode ? <SunIcon className="w-5 h-5" /> : <MoonIcon className="w-5 h-5" />}
          </button>
        </div>

        <div className="p-6 flex-1 overflow-y-auto space-y-8 scrollbar-hide">
          <section>
            <div className="flex items-center gap-2 mb-4 text-slate-400 font-bold uppercase text-[10px] tracking-widest"><EyeIcon className="w-4 h-4" /> Workspace</div>
            <div className="flex p-1 bg-slate-100 dark:bg-slate-800 rounded-xl">
              <button onClick={() => setViewMode('editor')} className={`flex-1 py-2 text-xs rounded-lg transition-all flex items-center justify-center gap-2 ${viewMode === 'editor' ? 'bg-white dark:bg-slate-700 shadow-sm font-bold text-indigo-600' : 'text-slate-400'}`}><PencilSquareIcon className="w-4 h-4" /> Editor</button>
              <button onClick={() => setViewMode('reader')} className={`flex-1 py-2 text-xs rounded-lg transition-all flex items-center justify-center gap-2 ${viewMode === 'reader' ? 'bg-white dark:bg-slate-700 shadow-sm font-bold text-indigo-600' : 'text-slate-400'}`}><BookOpenIcon className="w-4 h-4" /> Reader</button>
            </div>
          </section>

          <section>
            <div className="flex items-center gap-2 mb-4 text-slate-400 font-bold uppercase text-[10px] tracking-widest"><HashtagIcon className="w-4 h-4" /> Chapters</div>
            <div className="space-y-1 max-h-48 overflow-y-auto scrollbar-hide">
              {chapters.map((ch) => (
                <button key={ch.id} onClick={() => { setSelectedChapterId(ch.id); setIsSidebarOpen(false); }} className={`w-full text-left px-3 py-2 rounded-xl text-xs transition-all flex items-center gap-3 ${selectedChapterId === ch.id ? 'bg-indigo-600 text-white shadow-lg' : 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}`}>
                  <span className="opacity-50 font-mono">#{ch.id.split('-')[1] || '0'}</span>
                  <span className="truncate font-medium">{ch.title}</span>
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-4">
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 flex items-center gap-2"><UserGroupIcon className="w-4 h-4" /> Cast</span>
              <button onClick={handleExtractCharacters} disabled={isExtractingCharacters} className="text-indigo-600 disabled:opacity-30"><SparklesIcon className={`w-4 h-4 ${isExtractingCharacters ? 'animate-pulse' : ''}`} /></button>
            </div>
            <div className="space-y-2">
              {characters.length === 0 ? <div className="text-[10px] text-center p-4 border border-dashed rounded-lg opacity-40 italic">Analyze manuscript...</div> : characters.slice(0, 4).map((c, i) => (
                <div key={i} className="bg-slate-50 dark:bg-slate-800/50 p-3 rounded-xl border dark:border-slate-800">
                  <div className="flex justify-between items-center mb-1"><span className="text-xs font-bold">{c.name}</span><span className="text-[8px] uppercase px-1 bg-slate-200 dark:bg-slate-700 rounded font-mono">{c.role}</span></div>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 line-clamp-1">{c.description}</p>
                </div>
              ))}
            </div>
          </section>

          <section>
            <div className="flex items-center gap-2 mb-4 text-slate-400 font-bold uppercase text-[10px] tracking-widest"><AdjustmentsHorizontalIcon className="w-4 h-4" /> Performance</div>
            <div className="grid grid-cols-2 gap-2">
              {Object.values(ReadingTone).map(t => (
                <button key={t} onClick={() => setSelectedTones(prev => prev.includes(t) ? (prev.length > 1 ? prev.filter(x => x !== t) : prev) : [...prev, t])} className={`px-2 py-2 rounded-lg text-[10px] border transition-all ${selectedTones.includes(t) ? 'bg-indigo-600 border-indigo-600 text-white shadow-md' : 'border-slate-200 dark:border-slate-800 text-slate-400 hover:border-indigo-300'}`}>{t}</button>
              ))}
            </div>
          </section>

          <section className="space-y-4">
            <div className="flex items-center gap-2 text-slate-400 font-bold uppercase text-[10px] tracking-widest"><UserIcon className="w-4 h-4" /> Voice Modulation</div>
            <div className="bg-slate-50 dark:bg-slate-800/50 p-4 rounded-xl space-y-4 border dark:border-slate-800">
               <div className="space-y-1">
                  <div className="flex justify-between text-[10px] font-bold"><span>Pitch Offset</span><span>{pitch}%</span></div>
                  <input type="range" min="-30" max="30" value={pitch} onChange={e => setPitch(parseInt(e.target.value))} className="w-full h-1 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-600" />
               </div>
               <div className="flex items-center justify-between text-[10px] font-bold uppercase">
                  <span>Natural Breaths</span>
                  <button onClick={() => setIncludeBreaths(!includeBreaths)} className={`w-10 h-5 rounded-full relative transition-colors duration-200 ${includeBreaths ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-slate-700'}`}><div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform duration-200 ${includeBreaths ? 'translate-x-5' : ''}`} /></button>
               </div>
            </div>
          </section>

          <section className="pb-8">
            <button onClick={startSynthesis} disabled={isGeneratingAudio} className="w-full bg-indigo-600 text-white py-4 rounded-xl font-bold text-sm shadow-xl shadow-indigo-600/20 hover:bg-indigo-700 transition-all flex items-center justify-center gap-2 disabled:opacity-50">
              {isGeneratingAudio ? <ArrowPathIcon className="w-5 h-5 animate-spin" /> : <PlayIcon className="w-5 h-5" />}
              {isGeneratingAudio ? `Encoding ${Math.round(genProgress)}%` : 'Generate Audiobook'}
            </button>
          </section>
        </div>
      </aside>

      {/* MAIN PANEL */}
      <main className="flex-1 flex flex-col relative min-w-0 transition-colors duration-500 overflow-hidden">
        
        {/* MOBILE HEADER */}
        <header className="lg:hidden p-4 border-b dark:border-slate-800 bg-white dark:bg-slate-950 flex items-center justify-between z-20 shrink-0">
          <button onClick={() => setIsSidebarOpen(true)} className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800"><Bars3Icon className="w-6 h-6" /></button>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-indigo-600 rounded-lg overflow-hidden shadow-md">
              <img src={appLogo} alt="Logo" className="w-full h-full object-cover" />
            </div>
            <span className="font-bold text-sm tracking-tight">Ivanchat</span>
          </div>
          <button onClick={() => setShowChat(!showChat)} className={`p-2 rounded-xl transition-colors ${showChat ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-800'}`}><ChatBubbleLeftRightIcon className="w-6 h-6" /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 sm:p-8 lg:p-12 scrollbar-hide flex flex-col" ref={scrollContainerRef}>
          <div className="max-w-4xl mx-auto space-y-6 sm:space-y-8 flex-1 w-full flex flex-col">
            <header className="hidden lg:flex justify-between items-center border-b dark:border-slate-800 pb-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-2xl overflow-hidden shadow-lg border border-slate-200 dark:border-slate-700 bg-white">
                  <img src={appLogo} alt="Logo" className="w-full h-full object-cover" />
                </div>
                <div>
                  <h2 className="text-3xl font-serif font-bold text-slate-800 dark:text-slate-100">{viewMode === 'editor' ? 'Manuscript Editor' : 'Immersive Reader'}</h2>
                  <div className="flex items-center gap-3 mt-1">
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">{activeChapter?.title || 'Draft'}</p>
                    <div className="w-px h-3 bg-slate-300 dark:bg-slate-700" />
                    <div className="flex items-center gap-1.5 transition-all">
                      <div className={`w-1.5 h-1.5 rounded-full ${saveStatus === 'saved' ? 'bg-emerald-500' : 'bg-amber-400 animate-pulse'}`} />
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{saveStatus}</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2 px-3 py-1 bg-slate-100 dark:bg-slate-800 rounded-full text-[10px] font-bold text-slate-400 uppercase"><ClockIcon className="w-3 h-3" /><span>{(activeChapter?.content || '').split(/\s+/).length} Words</span></div>
                <button onClick={() => { setNovelText(''); setCharacters([]); setMessages([]); addToast("Reset Complete", "info"); }} className="text-[10px] text-slate-400 hover:text-red-500 font-bold uppercase tracking-widest transition-colors">Clear Workspace</button>
              </div>
            </header>

            <article className="flex-1 pb-12">
              {viewMode === 'reader' && duration > 0 && (
                <div className="sticky top-0 z-20 py-4 bg-slate-50/90 dark:bg-slate-950/90 backdrop-blur-md mb-8">
                   <div className="flex items-center gap-4 bg-slate-900 text-white p-4 rounded-3xl shadow-2xl border border-white/5">
                      <button onClick={togglePlayback} className="w-14 h-14 bg-indigo-600 rounded-full shadow-lg shadow-indigo-600/30 flex items-center justify-center transition-transform active:scale-90 hover:bg-indigo-500 shrink-0">
                        {isAudioPlaying ? <PauseIcon className="w-7 h-7" /> : <PlayIcon className="w-7 h-7 ml-1" />}
                      </button>
                      
                      <div className="flex-1 flex flex-col gap-2">
                        <div className="flex justify-between items-end px-1">
                          <span className="text-[10px] font-mono text-indigo-400 font-bold tracking-widest">
                            {new Date(currentTime * 1000).toISOString().substr(14, 5)}
                          </span>
                          <span className="text-[10px] font-mono text-slate-500 font-bold tracking-widest">
                            {new Date(duration * 1000).toISOString().substr(14, 5)}
                          </span>
                        </div>
                        <div className="relative h-6 group flex items-center">
                          <input 
                            type="range" 
                            min="0" 
                            max={duration} 
                            step="0.01" 
                            value={currentTime} 
                            onChange={e => handleSeek(parseFloat(e.target.value))} 
                            className="absolute inset-0 w-full h-1 bg-slate-800 rounded-full appearance-none cursor-pointer accent-indigo-500 z-10" 
                          />
                          <div className="absolute left-0 h-1 bg-indigo-500 rounded-full pointer-events-none" style={{ width: `${(currentTime / duration) * 100}%` }} />
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                         <div className="flex items-center gap-2 px-4 py-2 bg-slate-800 rounded-2xl border border-white/5">
                            <SpeakerWaveIcon className="w-4 h-4 text-slate-400" />
                            <select value={audioSpeed} onChange={e => {
                               const newSpeed = parseFloat(e.target.value);
                               setAudioSpeed(newSpeed);
                               if (isAudioPlaying && currentAudioBufferRef.current) {
                                  playBuffer(currentAudioBufferRef.current, currentTime);
                                }
                            }} className="bg-transparent text-xs font-bold outline-none border-none cursor-pointer text-white">
                               <option className="bg-slate-900" value="0.75">0.75x</option>
                               <option className="bg-slate-900" value="1.0">1.0x</option>
                               <option className="bg-slate-900" value="1.25">1.25x</option>
                               <option className="bg-slate-900" value="1.5">1.5x</option>
                               <option className="bg-slate-900" value="2.0">2.0x</option>
                            </select>
                         </div>
                         <div className="flex gap-1.5">
                            <button onClick={handleExportWav} title="Download WAV" className="p-3 bg-slate-800 rounded-2xl border border-white/5 hover:text-indigo-400 transition-colors"><ArrowDownOnSquareIcon className="w-5 h-5" /></button>
                            <button onClick={handleExportMp4} title="Download Video" className="p-3 bg-slate-800 rounded-2xl border border-white/5 hover:text-indigo-400 transition-colors"><VideoCameraIcon className="w-5 h-5" /></button>
                         </div>
                      </div>
                   </div>
                </div>
              )}

              {viewMode === 'editor' ? (
                <div className="space-y-6 h-full flex flex-col relative group">
                  <div className="absolute top-4 right-4 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
                     <div className="bg-white/80 dark:bg-slate-800/80 backdrop-blur-sm px-3 py-1.5 rounded-full flex items-center gap-2 border dark:border-slate-700 shadow-sm">
                        <CloudArrowUpIcon className="w-3.5 h-3.5 text-indigo-500" />
                        <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-tighter">Draft Synchronized</span>
                     </div>
                  </div>
                  <textarea value={novelText} onChange={e => setNovelText(e.target.value)} placeholder="Type or paste your entire novel here..." className="w-full flex-1 min-h-[50vh] p-6 sm:p-12 bg-white dark:bg-slate-900 rounded-3xl shadow-xl border-none font-serif text-lg sm:text-xl leading-relaxed resize-none scrollbar-hide focus:ring-0" />
                </div>
              ) : (
                <div className="w-full min-h-[60vh] p-6 sm:p-12 bg-white dark:bg-slate-900 rounded-3xl shadow-xl font-serif text-lg sm:text-xl leading-relaxed text-slate-800 dark:text-slate-100 whitespace-pre-wrap">
                  {processedData.length === 0 ? <div className="flex flex-col items-center justify-center py-40 opacity-10"><BookOpenIcon className="w-24 h-24 mb-4" /><p className="font-sans font-bold uppercase tracking-widest text-xs sm:text-base">Manuscript Empty</p></div> : 
                    processedData.map((s, si) => (
                      <span key={si} className={`inline-block rounded transition-all duration-700 ${si === activeIndices.activeSentenceIdx ? 'bg-indigo-600/5 dark:bg-indigo-400/10' : ''}`}>
                        {s.words.map((w, wi) => {
                          const active = si === activeIndices.activeSentenceIdx && wi === activeIndices.activeWordIdx;
                          return <span key={wi} ref={active ? activeWordRef : null} className={`inline-block px-1 rounded transition-all duration-200 ${active ? 'bg-indigo-600 text-white shadow-indigo-600/30 shadow-xl scale-110 z-10 relative' : 'opacity-100'}`}>{w.text}{' '}</span>;
                        })}
                      </span>
                    ))
                  }
                </div>
              )}
            </article>

            <div className="mt-auto pt-8 pb-4">
              <AdUnit className="w-full" />
            </div>
          </div>
        </div>

        {/* CHATBOT */}
        {showChat && (
          <div className="fixed lg:absolute bottom-0 right-0 z-50 flex flex-col glass-panel shadow-2xl w-full lg:w-[420px] h-[90vh] lg:h-[650px] lg:bottom-10 lg:right-10 lg:rounded-[2.5rem] lg:border rounded-t-[2.5rem] animate-in slide-in-from-bottom duration-300">
            <header className="p-6 bg-indigo-600 text-white flex justify-between items-center shrink-0 lg:rounded-t-[2.5rem] rounded-t-[2.5rem]">
              <div className="flex items-center gap-4"><ChatBubbleLeftRightIcon className="w-8 h-8" /><h3 className="font-bold">Literary Assistant</h3></div>
              <div className="flex gap-2"><button onClick={handleSaveChat} title="Archive chat" className="bg-white/10 p-2 rounded-2xl hover:bg-white/20 transition-colors"><ArrowDownTrayIcon className="w-5 h-5" /></button><button onClick={() => setShowChat(false)} className="bg-white/10 p-2 rounded-2xl hover:bg-white/20 transition-colors"><XMarkIcon className="w-5 h-5" /></button></div>
            </header>
            <div className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-hide bg-white/40 dark:bg-slate-900/40 backdrop-blur-3xl">
              {messages.length === 0 && <div className="text-center py-20 opacity-30 text-xs italic">Ask about character arcs, plot holes, or narrative flow...</div>}
              {messages.map(m => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[90%] p-4 rounded-[1.5rem] text-sm leading-relaxed shadow-sm ${m.role === 'user' ? 'bg-indigo-600 text-white rounded-tr-none' : 'bg-white dark:bg-slate-800 border dark:border-slate-700 rounded-tl-none text-slate-700 dark:text-slate-200'}`}>{m.text}</div></div>
              ))}
              {isChatting && <div className="flex gap-2 items-center"><div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" /><div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:0.2s]" /><div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:0.4s]" /></div>}
            </div>
            <footer className="p-4 bg-white/95 dark:bg-slate-900/95 border-t dark:border-slate-800 backdrop-blur-md mb-safe shrink-0">
              <div className="flex gap-2">
                <input type="text" value={userInput} onChange={e => setUserInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSendMessage()} placeholder="Ask anything about your text..." className="flex-1 px-5 py-3 bg-slate-50 dark:bg-slate-800 border dark:border-slate-700 rounded-2xl outline-none text-sm ring-indigo-500 focus:ring-2" />
                <button onClick={handleSendMessage} disabled={isChatting || !userInput.trim()} className="bg-indigo-600 text-white p-3 rounded-2xl shadow-lg hover:bg-indigo-700 active:scale-95 transition-all"><ArrowPathIcon className={`w-6 h-6 ${isChatting ? 'animate-spin' : ''}`} /></button>
              </div>
            </footer>
          </div>
        )}

        {!showChat && <button onClick={() => setShowChat(true)} className="hidden lg:flex absolute bottom-12 right-12 w-16 h-16 bg-indigo-600 text-white rounded-[2rem] items-center justify-center shadow-2xl hover:scale-110 active:scale-95 transition-all z-50"><ChatBubbleLeftRightIcon className="w-8 h-8" /></button>}
      </main>
    </div>
  );
};

export default App;
