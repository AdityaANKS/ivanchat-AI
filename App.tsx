
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
  EyeIcon,
  TrashIcon
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

const App: React.FC = () => {
  // --- States ---
  const [appLogo, setAppLogo] = useState<string>(() => localStorage.getItem('ivanchat_app_logo') || '');
  const [isGeneratingLogo, setIsGeneratingLogo] = useState(false);
  const [novelText, setNovelText] = useState<string>(() => localStorage.getItem('ivanchat_novel_text') || '');
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'drafting'>('saved');
  const [characters, setCharacters] = useState<CharacterBio[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('ivanchat_characters') || '[]');
    } catch { return []; }
  });
  const [selectedTones, setSelectedTones] = useState<ReadingTone[]>([ReadingTone.NEUTRAL]);
  const [gender, setGender] = useState<VoiceGender>(VoiceGender.MALE);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [userInput, setUserInput] = useState('');
  const [isChatting, setIsChatting] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isRenderingVideo, setIsRenderingVideo] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(() => localStorage.getItem('ivanchat_theme') !== 'light');
  const [viewMode, setViewMode] = useState<'editor' | 'reader'>('editor');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [audioSpeed, setAudioSpeed] = useState(1.0);
  const [pitch, setPitch] = useState(0);
  const [includeBreaths, setIncludeBreaths] = useState(true);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isGeneratingAudio, setIsGeneratingAudio] = useState(false);
  const [isLoadingCache, setIsLoadingCache] = useState(false);
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

  const addToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'success') => {
    const id = Date.now().toString();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
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
    setTimeout(() => setSaveStatus('saved'), 800);
  }, [novelText, characters, isDarkMode]);

  useEffect(() => {
    if (saveStatus === 'saved') setSaveStatus('drafting');
    const timer = setTimeout(performSave, 1500);
    return () => clearTimeout(timer);
  }, [novelText, characters, performSave]);

  // --- Logo Generation ---
  useEffect(() => {
    const initLogo = async () => {
      if (!appLogo || appLogo.length < 500) {
        setIsGeneratingLogo(true);
        try {
          const generated = await geminiService.generateAppLogo();
          setAppLogo(generated);
          localStorage.setItem('ivanchat_app_logo', generated);
          const link = document.querySelector("link[rel*='icon']") || document.createElement('link');
          (link as HTMLLinkElement).rel = 'shortcut icon';
          (link as HTMLLinkElement).href = generated;
          document.head.appendChild(link);
        } catch (e) {
          console.error("Logo generation failed:", e);
        } finally {
          setIsGeneratingLogo(false);
        }
      }
    };
    initLogo();
  }, [appLogo]);

  // --- Chapter & Highlighting ---
  const chapters = useMemo(() => {
    const text = (novelText || '').trim();
    if (!text) return [{ id: 'full', title: 'Manuscript', content: '', startIndex: 0 }];
    const regex = /(?:^|\n)(?:Chapter\s+\d+|#\s+.+|(?:CHAPTER|Chapter)\s+\w+)/gi;
    let match;
    const found: Chapter[] = [];
    while ((match = regex.exec(text)) !== null) {
      found.push({ id: `ch-${found.length}`, title: match[0].trim(), content: '', startIndex: match.index });
    }
    if (found.length === 0) return [{ id: 'full', title: 'Full Manuscript', content: text, startIndex: 0 }];
    return found.map((ch, i) => {
      const nextStart = found[i + 1] ? found[i + 1].startIndex : text.length;
      return { ...ch, content: text.substring(ch.startIndex, nextStart) };
    });
  }, [novelText]);

  const [selectedChapterId, setSelectedChapterId] = useState<string>('full');
  const activeChapter = useMemo(() => chapters.find(c => c.id === selectedChapterId) || chapters[0], [chapters, selectedChapterId]);

  const processedData = useMemo(() => {
    if (!activeChapter) return [];
    const text = activeChapter.content;
    const rawSentences = text.match(/[^.!?\n]+[.!?]+(?:\s|$|\n)|[^.!?\n]+(?:\n+|$)/g) || [text];
    let offset = 0;
    return rawSentences.map(sText => {
      const sentenceStart = offset;
      const words: { text: string; start: number; end: number }[] = [];
      const tokens = (sText.match(/\s+|[^\s]+/g) || []) as string[];
      let localOffset = 0;
      tokens.forEach(token => {
        const start = offset + localOffset;
        const end = start + token.length;
        if (token.trim().length > 0) words.push({ text: token, start, end });
        localOffset += token.length;
      });
      offset += sText.length;
      return { text: sText, start: sentenceStart, end: offset, words };
    });
  }, [activeChapter]);

  const activeIndices = useMemo(() => {
    if (duration === 0) return { sIdx: -1, wIdx: -1 };
    const pos = (() => {
      const chunk = audioChunks.find(c => currentTime >= c.audioStart && currentTime <= c.audioEnd);
      if (!chunk) return currentTime >= duration ? activeChapter.content.length : 0;
      const progress = (currentTime - chunk.audioStart) / (chunk.audioEnd - chunk.audioStart || 1);
      return chunk.charStart + (progress * (chunk.charEnd - chunk.charStart));
    })();

    for (let i = 0; i < processedData.length; i++) {
      const s = processedData[i];
      if (pos >= s.start && pos < s.end) {
        for (let j = 0; j < s.words.length; j++) {
          const w = s.words[j];
          if (pos >= w.start && pos < w.end) return { sIdx: i, wIdx: j };
        }
        return { sIdx: i, wIdx: -1 };
      }
    }
    return { sIdx: -1, wIdx: -1 };
  }, [currentTime, audioChunks, duration, processedData, activeChapter]);

  useEffect(() => {
    if (viewMode === 'reader' && activeWordRef.current && scrollContainerRef.current) {
      activeWordRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeIndices.wIdx, viewMode]);

  // --- Caching Logic ---
  const loadChapterCache = useCallback(async (chapterId: string) => {
    setIsLoadingCache(true);
    try {
      const blob = await getAudioFromDB(`audio_${chapterId}`);
      if (blob) {
        if (!audioContextRef.current) audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        const arrayBuffer = await blob.arrayBuffer();
        const buffer = await audioContextRef.current.decodeAudioData(arrayBuffer);
        
        const storedMeta = localStorage.getItem(`ivanchat_meta_${chapterId}`);
        if (storedMeta) {
          const metaArr = JSON.parse(storedMeta);
          currentAudioBufferRef.current = buffer;
          setAudioChunks(metaArr);
          setDuration(buffer.duration);
          setCurrentTime(0);
          pausedTimeRef.current = 0;
          addToast("Narration restored", "info");
        }
      } else {
        currentAudioBufferRef.current = null;
        setAudioChunks([]);
        setDuration(0);
      }
    } catch (e) {
      console.error("Cache restoration failed:", e);
    } finally {
      setIsLoadingCache(false);
    }
  }, [addToast]);

  useEffect(() => {
    loadChapterCache(selectedChapterId);
  }, [selectedChapterId, loadChapterCache]);

  const clearChapterCache = async () => {
    currentAudioBufferRef.current = null;
    setAudioChunks([]);
    setDuration(0);
    addToast("Cache cleared", "info");
  };

  // --- Audio Logic ---
  const playBuffer = (buffer: AudioBuffer, offset: number) => {
    if (!audioContextRef.current) audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    if (audioContextRef.current.state === 'suspended') audioContextRef.current.resume();
    
    if (sourceNodeRef.current) sourceNodeRef.current.stop();
    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = audioSpeed;
    source.connect(audioContextRef.current.destination);
    
    source.onended = () => {
      const elapsed = (audioContextRef.current!.currentTime - startTimeRef.current) * audioSpeed;
      if (elapsed >= buffer.duration - 0.2) setIsAudioPlaying(false);
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
    } else {
      const start = pausedTimeRef.current >= currentAudioBufferRef.current.duration ? 0 : pausedTimeRef.current;
      playBuffer(currentAudioBufferRef.current, start);
      setIsAudioPlaying(true);
    }
  };

  const handleSeek = (v: number) => {
    setCurrentTime(v);
    pausedTimeRef.current = v;
    if (isAudioPlaying && currentAudioBufferRef.current) playBuffer(currentAudioBufferRef.current, v);
  };

  useEffect(() => {
    const tick = () => {
      if (isAudioPlaying && audioContextRef.current && currentAudioBufferRef.current) {
        const elapsed = (audioContextRef.current.currentTime - startTimeRef.current) * audioSpeed;
        if (elapsed >= currentAudioBufferRef.current.duration) {
          setCurrentTime(currentAudioBufferRef.current.duration);
          setIsAudioPlaying(false);
        } else {
          setCurrentTime(elapsed);
          progressRequestRef.current = requestAnimationFrame(tick);
        }
      }
    };
    if (isAudioPlaying) progressRequestRef.current = requestAnimationFrame(tick);
    return () => { if (progressRequestRef.current) cancelAnimationFrame(progressRequestRef.current); };
  }, [isAudioPlaying, audioSpeed]);

  // --- Synthesis ---
  const startSynthesis = async () => {
    if (!activeChapter?.content.trim()) return addToast("Manuscript is empty", "error");
    try {
      setIsGeneratingAudio(true);
      setGenProgress(0);
      setIsSidebarOpen(false);
      
      const maxChars = 850;
      const chunks: { text: string; start: number; end: number }[] = [];
      let curT = "", curS = 0;
      processedData.forEach(s => {
        if ((curT + s.text).length > maxChars && curT.length > 0) {
          chunks.push({ text: curT, start: curS, end: curS + curT.length });
          curT = s.text; curS = s.start;
        } else {
          if (curT === "") curS = s.start;
          curT += s.text;
        }
      });
      if (curT) chunks.push({ text: curT, start: curS, end: curS + curT.length });

      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const results: any[] = new Array(chunks.length);
      const concurrency = 4;

      for (let i = 0; i < chunks.length; i += concurrency) {
        const batch = chunks.slice(i, i + concurrency);
        await Promise.all(batch.map(async (c, bIdx) => {
          const gIdx = i + bIdx;
          const meta = await geminiService.analyzeScene(c.text);
          const b64 = await geminiService.textToSpeech(c.text, selectedTones, gender, pitch, includeBreaths, meta);
          const buf = await decodeAudioData(decodeBase64(b64), ctx, 24000, 1);
          results[gIdx] = { buf, meta, c };
          setGenProgress((results.filter(Boolean).length / chunks.length) * 100);
        }));
      }

      const totalSamples = results.reduce((acc, r) => acc + r.buf.length, 0);
      const merged = ctx.createBuffer(1, totalSamples, 24000);
      let sOff = 0, tOff = 0;
      const metaArr: AudioChunkMetadata[] = [];

      results.forEach(r => {
        merged.getChannelData(0).set(r.buf.getChannelData(0), sOff);
        metaArr.push({ charStart: r.c.start, charEnd: r.c.end, audioStart: tOff, audioEnd: tOff + r.buf.duration, scene: r.meta });
        sOff += r.buf.length; tOff += r.buf.duration;
      });

      currentAudioBufferRef.current = merged;
      setAudioChunks(metaArr);
      setDuration(merged.duration);
      setCurrentTime(0);
      pausedTimeRef.current = 0;
      setViewMode('reader');
      
      const wavBlob = audioBufferToWav(merged);
      await saveAudioToDB(`audio_${selectedChapterId}`, wavBlob);
      localStorage.setItem(`ivanchat_meta_${selectedChapterId}`, JSON.stringify(metaArr));
      
      audioContextRef.current = ctx;
      playBuffer(merged, 0);
      setIsAudioPlaying(true);
      addToast("Audiobook Ready", "success");
      setIsGeneratingAudio(false);
    } catch (e) {
      console.error(e);
      addToast("Synthesis failed", "error");
      setIsGeneratingAudio(false);
    }
  };

  const handleExportWav = () => {
    if (!currentAudioBufferRef.current) return;
    const blob = audioBufferToWav(currentAudioBufferRef.current);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Ivanchat_${(activeChapter?.title || 'Audio').replace(/\s+/g, '_')}.wav`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSendMessage = async () => {
    if (!userInput.trim()) return;
    const msg: ChatMessage = { id: Date.now().toString(), role: 'user', text: userInput, timestamp: new Date() };
    setMessages(prev => [...prev, msg]);
    setUserInput('');
    setIsChatting(true);
    try {
      const res = await geminiService.chat(userInput, novelText, characters, messages.map(m => ({ role: m.role, parts: [{ text: m.text }] })));
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text: res, timestamp: new Date() }]);
    } catch (e) { addToast("AI Offline", "error"); }
    finally { setIsChatting(false); }
  };

  return (
    <div className="flex h-screen-safe bg-slate-50 dark:bg-slate-950 overflow-hidden text-slate-900 dark:text-slate-100 font-sans transition-colors duration-500 relative">
      
      {/* TOAST SYSTEM */}
      <div className="fixed top-6 right-6 z-[200] flex flex-col gap-3 w-full max-w-sm px-4">
        {toasts.map(t => (
          <div key={t.id} className={`flex items-center gap-3 px-5 py-4 rounded-2xl shadow-2xl border backdrop-blur-xl animate-in slide-in-from-right duration-300 ${t.type === 'success' ? 'bg-indigo-600/90 border-indigo-400 text-white' : t.type === 'error' ? 'bg-rose-600/90 border-rose-400 text-white' : 'bg-white/90 dark:bg-slate-800/90 border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white'}`}>
            <span className="text-sm font-semibold flex-1">{t.message}</span>
            <button onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))} className="opacity-50"><XMarkIcon className="w-4 h-4" /></button>
          </div>
        ))}
      </div>

      {/* OVERLAYS */}
      {(isRenderingVideo || isGeneratingAudio || isLoadingCache) && (
        <div className="fixed inset-0 z-[100] bg-slate-900/80 backdrop-blur-xl flex flex-col items-center justify-center text-white p-6 text-center animate-in fade-in duration-500">
          {isRenderingVideo ? <VideoCameraIcon className="w-16 h-16 animate-pulse mb-4 text-indigo-400" /> : 
           isGeneratingAudio ? <ArrowPathIcon className="w-16 h-16 animate-spin mb-4 text-indigo-400" /> :
           <CloudArrowUpIcon className="w-16 h-16 animate-bounce mb-4 text-emerald-400" />}
          
          <h2 className="text-3xl font-bold tracking-tight">
            {isRenderingVideo ? "Encoding Master Copy" : 
             isGeneratingAudio ? `Synthesizing Audio...` : 
             "Restoring Session"}
          </h2>
          {isGeneratingAudio && (
             <div className="mt-4 w-64 h-2 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-indigo-500 transition-all duration-300" style={{ width: `${genProgress}%` }} />
             </div>
          )}
        </div>
      )}

      {isSidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-30 lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* SIDEBAR */}
      <aside className={`fixed inset-y-0 left-0 z-40 w-[300px] bg-white dark:bg-slate-900 border-r dark:border-slate-800 shadow-2xl transition-transform lg:translate-x-0 lg:static flex flex-col shrink-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="p-6 border-b dark:border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center overflow-hidden shadow-lg border border-white/10">
               {isGeneratingLogo ? (
                 <SparklesIcon className="w-6 h-6 text-white animate-pulse" />
               ) : appLogo ? (
                 <img src={appLogo} alt="Logo" className="w-full h-full object-cover" />
               ) : (
                 <div className="w-full h-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold text-lg">IV</div>
               )}
            </div>
            <h1 className="text-xl font-bold tracking-tight">Ivanchat</h1>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setIsDarkMode(!isDarkMode)} title="Toggle Theme" className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-indigo-600 transition-colors">
              {isDarkMode ? <SunIcon className="w-5 h-5" /> : <MoonIcon className="w-5 h-5" />}
            </button>
            <button onClick={() => setIsSidebarOpen(false)} className="lg:hidden p-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-rose-500 transition-colors">
              <XMarkIcon className="w-6 h-6" />
            </button>
          </div>
        </div>

        <div className="p-6 flex-1 overflow-y-auto space-y-8 scrollbar-hide">
          <section>
            <div className="flex p-1 bg-slate-100 dark:bg-slate-800 rounded-xl">
              <button onClick={() => { setViewMode('editor'); setIsSidebarOpen(false); }} className={`flex-1 py-2 text-xs rounded-lg transition-all ${viewMode === 'editor' ? 'bg-white dark:bg-slate-700 shadow-sm font-bold text-indigo-600' : 'text-slate-400'}`}>Editor</button>
              <button onClick={() => { setViewMode('reader'); setIsSidebarOpen(false); }} className={`flex-1 py-2 text-xs rounded-lg transition-all ${viewMode === 'reader' ? 'bg-white dark:bg-slate-700 shadow-sm font-bold text-indigo-600' : 'text-slate-400'}`}>Reader</button>
            </div>
          </section>

          <section>
            <div className="text-slate-400 font-bold uppercase text-[10px] tracking-widest mb-3 flex justify-between items-center">
              <span>Chapters</span>
              <HashtagIcon className="w-3 h-3" />
            </div>
            <div className="space-y-1 max-h-40 overflow-y-auto scrollbar-hide border-l dark:border-slate-800 pl-4">
              {chapters.map(ch => (
                <button key={ch.id} onClick={() => { setSelectedChapterId(ch.id); setIsSidebarOpen(false); }} className={`w-full text-left px-3 py-2 rounded-xl text-xs transition-all flex items-center gap-3 ${selectedChapterId === ch.id ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'bg-transparent text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
                  <span className="truncate font-medium">{ch.title}</span>
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="text-slate-400 font-bold uppercase text-[10px] tracking-widest mb-3 flex items-center gap-2">
              <UserIcon className="w-3 h-3" />
              <span>Voice Profile</span>
            </div>
            <div className="flex p-1 bg-slate-100 dark:bg-slate-800 rounded-xl">
              {Object.values(VoiceGender).map(g => (
                <button key={g} onClick={() => setGender(g)} className={`flex-1 py-2 text-xs rounded-lg transition-all ${gender === g ? 'bg-white dark:bg-slate-700 shadow-sm font-bold text-indigo-600' : 'text-slate-400'}`}>{g}</button>
              ))}
            </div>
          </section>

          <section>
            <div className="text-slate-400 font-bold uppercase text-[10px] tracking-widest mb-3">Narrative Tones</div>
            <div className="grid grid-cols-2 gap-2">
              {Object.values(ReadingTone).map(t => (
                <button key={t} onClick={() => setSelectedTones(prev => prev.includes(t) ? (prev.length > 1 ? prev.filter(x => x !== t) : prev) : [...prev, t])} className={`px-2 py-2 rounded-lg text-[10px] border transition-all ${selectedTones.includes(t) ? 'bg-indigo-600 border-indigo-600 text-white shadow-md' : 'border-slate-200 dark:border-slate-800 text-slate-400 hover:border-indigo-400'}`}>{t}</button>
              ))}
            </div>
          </section>

          <section>
            <div className="bg-slate-50 dark:bg-slate-800/50 p-4 rounded-2xl space-y-4 border dark:border-slate-800">
               <div className="space-y-1">
                  <div className="flex justify-between text-[10px] font-bold"><span>Vocal Pitch</span><span>{pitch}%</span></div>
                  <input type="range" min="-30" max="30" value={pitch} onChange={e => setPitch(parseInt(e.target.value))} className="w-full h-1 accent-indigo-600 appearance-none bg-slate-200 dark:bg-slate-700 rounded-full cursor-pointer" />
               </div>
               <div className="flex items-center justify-between text-[10px] font-bold uppercase">
                  <span>Natural Breaths</span>
                  <button onClick={() => setIncludeBreaths(!includeBreaths)} className={`w-10 h-5 rounded-full relative transition-colors duration-200 ${includeBreaths ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-slate-700'}`}>
                    <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-200 ${includeBreaths ? 'translate-x-5' : ''}`} />
                  </button>
               </div>
            </div>
          </section>

          <div className="pt-4 pb-12 space-y-2">
            <button onClick={startSynthesis} disabled={isGeneratingAudio} className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-bold text-sm shadow-xl shadow-indigo-600/30 hover:bg-indigo-700 active:scale-95 disabled:opacity-50 transition-all flex items-center justify-center gap-2">
              {isGeneratingAudio ? <ArrowPathIcon className="w-5 h-5 animate-spin" /> : <PlayIcon className="w-5 h-5" />}
              {isGeneratingAudio ? `Synthesizing...` : duration > 0 ? 'Regenerate Audio' : 'Generate Audiobook'}
            </button>
            {duration > 0 && (
              <button onClick={clearChapterCache} className="w-full flex items-center justify-center gap-2 py-2 text-[10px] text-slate-400 hover:text-rose-500 transition-colors uppercase font-bold tracking-widest">
                <TrashIcon className="w-3 h-3" /> Clear Local Cache
              </button>
            )}
          </div>
        </div>
      </aside>

      {/* MAIN PANEL */}
      <main className="flex-1 flex flex-col overflow-hidden relative">
        <header className="lg:hidden p-4 border-b dark:border-slate-800 flex items-center justify-between bg-white dark:bg-slate-950 sticky top-0 z-20">
          <button onClick={() => setIsSidebarOpen(true)} className="p-2 rounded-xl bg-slate-50 dark:bg-slate-900 transition-colors"><Bars3Icon className="w-6 h-6" /></button>
          <div className="flex items-center gap-2">
             <div className="w-7 h-7 bg-indigo-600 rounded-lg overflow-hidden shadow-sm flex items-center justify-center">
                {appLogo ? <img src={appLogo} alt="Logo" className="w-full h-full object-cover" /> : <div className="text-white font-bold text-[10px]">IV</div>}
             </div>
             <span className="font-bold text-sm tracking-tight">Ivanchat</span>
          </div>
          <button onClick={() => setShowChat(!showChat)} className={`p-2 rounded-xl transition-colors ${showChat ? 'bg-indigo-600 text-white' : 'bg-slate-50 dark:bg-slate-900'}`}><ChatBubbleLeftRightIcon className="w-6 h-6" /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 sm:p-8 lg:p-12 flex flex-col scrollbar-hide" ref={scrollContainerRef}>
          <div className="max-w-5xl mx-auto w-full flex flex-col flex-1">
            <header className="hidden lg:flex justify-between items-center mb-8 pb-6 border-b dark:border-slate-800 shrink-0">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-2xl overflow-hidden shadow-xl border dark:border-slate-700 bg-white dark:bg-slate-800 flex items-center justify-center relative">
                  {appLogo ? <img src={appLogo} alt="Logo" className="w-full h-full object-cover" /> : <div className="text-indigo-600 font-bold text-xl">IV</div>}
                  {duration > 0 && !isGeneratingAudio && (
                    <div className="absolute -bottom-1 -right-1 bg-emerald-500 rounded-full p-1 border-2 border-white dark:border-slate-800 shadow-md">
                      <CloudArrowUpIcon className="w-2.5 h-2.5 text-white" />
                    </div>
                  )}
                </div>
                <div>
                  <h2 className="text-4xl font-serif font-bold text-slate-800 dark:text-slate-100">{viewMode === 'editor' ? 'Manuscript Editor' : 'Immersive Reader'}</h2>
                  <div className="flex items-center gap-2 text-slate-400 text-[10px] font-bold uppercase tracking-widest mt-1">
                    <span className="text-indigo-500">{activeChapter?.title}</span>
                    {duration > 0 && (
                      <>
                        <span className="opacity-20">/</span>
                        <span className="text-emerald-500 font-bold">Encrypted Cache Local</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              <button onClick={() => { setNovelText(''); addToast("Manuscript reset", "info"); }} className="text-[10px] text-slate-400 hover:text-rose-500 font-bold uppercase tracking-widest border border-slate-200 dark:border-slate-800 px-4 py-2 rounded-xl transition-colors">Clear Workspace</button>
            </header>

            <article className="flex-1 pb-64">
              {viewMode === 'reader' && duration > 0 && (
                <div className="sticky top-0 lg:top-4 z-20 py-4 mb-12">
                   <div className="flex flex-col sm:flex-row items-center gap-6 bg-slate-900 text-white p-6 sm:p-8 rounded-[3rem] shadow-[0_30px_60px_rgba(0,0,0,0.4)] border border-white/5 backdrop-blur-md">
                      <button onClick={togglePlayback} className="w-20 h-20 bg-indigo-600 rounded-full flex items-center justify-center hover:bg-indigo-500 shadow-2xl shadow-indigo-600/30 active:scale-95 transition-all shrink-0">
                        {isAudioPlaying ? <PauseIcon className="w-10 h-10" /> : <PlayIcon className="w-10 h-10 ml-1" />}
                      </button>
                      <div className="flex-1 flex flex-col gap-3 w-full">
                        <div className="flex justify-between text-[11px] font-mono text-indigo-400 uppercase font-bold px-1 tracking-widest">
                          <span>{new Date(currentTime * 1000).toISOString().substr(14, 5)}</span>
                          <span>{new Date(duration * 1000).toISOString().substr(14, 5)}</span>
                        </div>
                        <div className="relative h-2 group flex items-center">
                          <input type="range" min="0" max={duration} step="0.01" value={currentTime} onChange={e => handleSeek(parseFloat(e.target.value))} className="absolute inset-0 w-full h-1 bg-slate-800 rounded-full appearance-none cursor-pointer accent-indigo-500 z-10" />
                          <div className="absolute left-0 h-1 bg-indigo-500 rounded-full pointer-events-none shadow-[0_0_15px_rgba(99,102,241,0.6)]" style={{ width: `${(currentTime / duration) * 100}%` }} />
                        </div>
                      </div>
                      <div className="flex items-center gap-4 shrink-0">
                         <div className="flex items-center gap-3 px-5 py-3 bg-slate-800 rounded-2xl border border-white/5">
                            <SpeakerWaveIcon className="w-5 h-5 text-slate-500" />
                            <select value={audioSpeed} onChange={e => setAudioSpeed(parseFloat(e.target.value))} className="bg-transparent text-[12px] font-bold outline-none text-white cursor-pointer hover:text-indigo-400 transition-colors">
                               <option className="bg-slate-900" value="0.75">0.75x</option>
                               <option className="bg-slate-900" value="1.0">1.0x</option>
                               <option className="bg-slate-900" value="1.25">1.25x</option>
                               <option className="bg-slate-900" value="1.5">1.5x</option>
                               <option className="bg-slate-900" value="2.0">2.0x</option>
                            </select>
                         </div>
                         <button onClick={handleExportWav} title="Export Master WAV" className="p-4 bg-slate-800 rounded-2xl hover:text-indigo-400 border border-white/5 transition-colors"><ArrowDownTrayIcon className="w-6 h-6" /></button>
                      </div>
                   </div>
                </div>
              )}

              {viewMode === 'editor' ? (
                <textarea 
                  value={novelText} 
                  onChange={e => setNovelText(e.target.value)} 
                  placeholder="Paste your epic here..." 
                  className="w-full flex-1 min-h-[90vh] p-8 sm:p-16 bg-white dark:bg-slate-900 rounded-[3rem] shadow-2xl font-serif text-xl sm:text-2xl leading-[1.8] focus:ring-8 focus:ring-indigo-500/5 border-none resize-none transition-all scrollbar-hide text-slate-800 dark:text-slate-100" 
                />
              ) : (
                <div className="w-full min-h-[90vh] p-8 sm:p-16 bg-white dark:bg-slate-900 rounded-[3rem] shadow-2xl font-serif text-xl sm:text-2xl leading-[1.8] whitespace-pre-wrap transition-all relative">
                  {processedData.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-64 opacity-20">
                       <BookOpenIcon className="w-24 h-24 mb-6" />
                       <p className="font-sans font-bold uppercase tracking-widest text-sm">Waiting for Narration</p>
                    </div>
                  ) : (
                    processedData.map((s, si) => {
                      const sentenceActive = si === activeIndices.sIdx;
                      return (
                        <span key={si} className={`inline-block transition-all duration-700 ease-in-out my-1 ${sentenceActive ? 'active-sentence' : ''}`}>
                          {s.words.map((w, wi) => {
                            const wordActive = sentenceActive && wi === activeIndices.wIdx;
                            return (
                              <span 
                                key={wi} 
                                ref={wordActive ? activeWordRef : null} 
                                className={`inline-block px-1.5 py-0.5 rounded transition-all duration-300 ${wordActive ? 'bg-indigo-600 text-white shadow-2xl scale-110 z-10 relative animate-word-focus' : 'text-slate-800 dark:text-slate-200'}`}
                              >
                                {w.text}{' '}
                              </span>
                            );
                          })}
                        </span>
                      );
                    })
                  )}
                </div>
              )}
            </article>
          </div>
        </div>

        {/* FLOATING ACTION CHAT */}
        {showChat && (
          <div className="fixed lg:absolute bottom-0 right-0 z-50 flex flex-col glass-panel shadow-[0_-20px_60px_rgba(0,0,0,0.3)] w-full lg:w-[450px] h-[95vh] lg:h-[700px] lg:bottom-12 lg:right-12 rounded-t-[3rem] lg:rounded-[3rem] animate-in slide-in-from-bottom duration-500 border border-slate-200 dark:border-slate-800">
            <header className="p-8 bg-indigo-600 text-white flex justify-between items-center rounded-t-[3rem] shrink-0 shadow-lg">
              <div className="flex items-center gap-4">
                 <ChatBubbleLeftRightIcon className="w-8 h-8" />
                 <h3 className="text-lg font-bold">Story Architect</h3>
              </div>
              <button onClick={() => setShowChat(false)} className="p-2 hover:bg-white/10 rounded-2xl transition-all"><XMarkIcon className="w-8 h-8" /></button>
            </header>
            <div className="flex-1 overflow-y-auto p-8 space-y-8 scrollbar-hide bg-white/40 dark:bg-slate-900/40 backdrop-blur-3xl">
              {messages.length === 0 && (
                 <div className="text-center py-32 space-y-4 opacity-30">
                    <SparklesIcon className="w-16 h-16 mx-auto mb-4 text-indigo-500" />
                    <p className="text-sm font-sans font-bold tracking-widest uppercase italic">Analyze character growth or plot density</p>
                 </div>
              )}
              {messages.map(m => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] p-5 rounded-[2rem] text-[15px] leading-relaxed shadow-sm ${m.role === 'user' ? 'bg-indigo-600 text-white rounded-tr-none' : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-tl-none border dark:border-slate-700'}`}>
                    {m.text}
                  </div>
                </div>
              ))}
              {isChatting && <div className="flex gap-3 items-center text-xs text-indigo-500 font-bold animate-pulse tracking-widest uppercase"><SparklesIcon className="w-5 h-5" /> Querying Manuscript...</div>}
            </div>
            <footer className="p-6 bg-white/95 dark:bg-slate-950/95 border-t dark:border-slate-800 rounded-b-[3rem] mb-safe shrink-0">
              <div className="flex gap-3">
                <input 
                  type="text" 
                  value={userInput} 
                  onChange={e => setUserInput(e.target.value)} 
                  onKeyDown={e => e.key === 'Enter' && handleSendMessage()} 
                  placeholder="Ask your assistant..." 
                  className="flex-1 px-6 py-4 bg-slate-100 dark:bg-slate-800 border-none rounded-2xl outline-none text-base ring-indigo-500 focus:ring-4 transition-all" 
                />
                <button 
                  onClick={handleSendMessage} 
                  disabled={isChatting || !userInput.trim()} 
                  className="bg-indigo-600 text-white p-4 rounded-2xl shadow-2xl hover:bg-indigo-700 active:scale-90 transition-all disabled:opacity-30"
                >
                  <ArrowPathIcon className={`w-8 h-8 ${isChatting ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </footer>
          </div>
        )}

        {!showChat && (
          <button 
            onClick={() => setShowChat(true)} 
            className="fixed lg:absolute bottom-12 right-12 w-20 h-20 bg-indigo-600 text-white rounded-[2.2rem] flex items-center justify-center shadow-[0_20px_50px_rgba(99,102,241,0.5)] hover:scale-110 hover:rotate-3 hover:bg-indigo-500 active:scale-95 transition-all z-50 border border-white/10"
          >
            <ChatBubbleLeftRightIcon className="w-10 h-10" />
          </button>
        )}
      </main>
    </div>
  );
};

export default App;
