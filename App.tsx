
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

const App: React.FC = () => {
  // --- States ---
  const [appLogo, setAppLogo] = useState<string>(() => localStorage.getItem('ivanchat_app_logo') || '');
  const [isGeneratingLogo, setIsGeneratingLogo] = useState(false);
  const [novelText, setNovelText] = useState<string>(() => localStorage.getItem('ivanchat_novel_text') || '');
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'drafting'>('saved');
  const [characters, setCharacters] = useState<CharacterBio[]>(() => JSON.parse(localStorage.getItem('ivanchat_characters') || '[]'));
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
  const [audioSpeed, setAudioSpeed] = useState(1.0); // Reset to 1.0x
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

  const addToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'success') => {
    const id = Date.now().toString();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  // --- Auto-Save Effect ---
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

  useEffect(() => {
    if (isDarkMode) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, [isDarkMode]);

  // --- Logo Generation ---
  useEffect(() => {
    const initLogo = async () => {
      if (!appLogo || appLogo.length < 100) {
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
          console.error("Logo failed:", e);
        } finally {
          setIsGeneratingLogo(false);
        }
      }
    };
    initLogo();
  }, [appLogo]);

  // --- Chapter & Highlighting Prep ---
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
      const tokens = (sText.match(/\s+|[^\s]+/g) || []) as string[];
      const words: { text: string; start: number; end: number }[] = [];
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
    const pos = duration === 0 ? 0 : (() => {
      const chunk = audioChunks.find(c => currentTime >= c.audioStart && currentTime <= c.audioEnd);
      if (!chunk) return currentTime >= duration ? activeChapter.content.length : 0;
      const progress = (currentTime - chunk.audioStart) / (chunk.audioEnd - chunk.audioStart || 1);
      return chunk.charStart + (progress * (chunk.charEnd - chunk.charStart));
    })();

    let sIdx = -1, wIdx = -1;
    for (let i = 0; i < processedData.length; i++) {
      const s = processedData[i];
      if (pos >= s.start && pos < s.end) {
        sIdx = i;
        for (let j = 0; j < s.words.length; j++) {
          const w = s.words[j];
          if (pos >= w.start && pos < w.end) { wIdx = j; break; }
        }
        break;
      }
    }
    return { sIdx, wIdx };
  }, [currentTime, audioChunks, duration, processedData, activeChapter]);

  useEffect(() => {
    if (viewMode === 'reader' && activeWordRef.current && scrollContainerRef.current) {
      activeWordRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeIndices.wIdx, viewMode]);

  // --- Audio Engine ---
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

  // --- Parallel Synthesis ---
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
      
      await saveAudioToDB(`audio_${selectedChapterId}`, audioBufferToWav(merged));
      localStorage.setItem(`ivanchat_meta_${selectedChapterId}`, JSON.stringify(metaArr));
      
      audioContextRef.current = ctx;
      playBuffer(merged, 0);
      setIsAudioPlaying(true);
      addToast("Audiobook Ready", "success");
      setIsGeneratingAudio(false);
    } catch (e) {
      console.error(e);
      addToast("Synthesis failed. Check API keys.", "error");
      setIsGeneratingAudio(false);
    }
  };

  // --- Exports ---
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

  const handleExportMp4 = async () => {
    if (!currentAudioBufferRef.current) return;
    setIsRenderingVideo(true);
    try {
      const blob = await audioBufferToMp4(currentAudioBufferRef.current, activeChapter?.title || 'Story', appLogo);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Ivanchat_${(activeChapter?.title || 'Video').replace(/\s+/g, '_')}.webm`;
      a.click();
      URL.revokeObjectURL(url);
      addToast("Video Saved", "success");
    } catch (e) { addToast("Render error", "error"); }
    finally { setIsRenderingVideo(false); }
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

      {/* RENDER OVERLAY */}
      {isRenderingVideo && (
        <div className="fixed inset-0 z-[100] bg-slate-900/80 backdrop-blur-xl flex flex-col items-center justify-center text-white">
          <VideoCameraIcon className="w-16 h-16 animate-pulse mb-4 text-indigo-400" />
          <h2 className="text-2xl font-bold">Encoding Narrative Video...</h2>
        </div>
      )}

      {/* SIDEBAR */}
      <aside className={`fixed inset-y-0 left-0 z-40 w-[300px] bg-white dark:bg-slate-900 border-r dark:border-slate-800 shadow-2xl transition-transform lg:translate-x-0 lg:static flex flex-col shrink-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="p-6 border-b dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center overflow-hidden shadow-lg">
               {isGeneratingLogo ? <SparklesIcon className="w-6 h-6 text-white animate-pulse" /> : <img src={appLogo} alt="Logo" className="w-full h-full object-cover" />}
            </div>
            <h1 className="text-xl font-bold tracking-tight">Ivanchat</h1>
          </div>
          <button onClick={() => setIsDarkMode(!isDarkMode)} className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800">
            {isDarkMode ? <SunIcon className="w-5 h-5" /> : <MoonIcon className="w-5 h-5" />}
          </button>
        </div>

        <div className="p-6 flex-1 overflow-y-auto space-y-8 scrollbar-hide">
          <section>
            <div className="flex p-1 bg-slate-100 dark:bg-slate-800 rounded-xl">
              <button onClick={() => setViewMode('editor')} className={`flex-1 py-2 text-xs rounded-lg transition-all ${viewMode === 'editor' ? 'bg-white dark:bg-slate-700 shadow-sm font-bold text-indigo-600' : 'text-slate-400'}`}>Editor</button>
              <button onClick={() => setViewMode('reader')} className={`flex-1 py-2 text-xs rounded-lg transition-all ${viewMode === 'reader' ? 'bg-white dark:bg-slate-700 shadow-sm font-bold text-indigo-600' : 'text-slate-400'}`}>Reader</button>
            </div>
          </section>

          <section>
            <div className="text-slate-400 font-bold uppercase text-[10px] tracking-widest mb-3">Chapters</div>
            <div className="space-y-1 max-h-40 overflow-y-auto scrollbar-hide">
              {chapters.map(ch => (
                <button key={ch.id} onClick={() => { setSelectedChapterId(ch.id); setIsSidebarOpen(false); }} className={`w-full text-left px-3 py-2 rounded-xl text-xs transition-all flex items-center gap-3 ${selectedChapterId === ch.id ? 'bg-indigo-600 text-white' : 'bg-slate-50 dark:bg-slate-800 text-slate-500'}`}>
                  <span className="truncate font-medium">{ch.title}</span>
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="text-slate-400 font-bold uppercase text-[10px] tracking-widest mb-3">Performance</div>
            <div className="grid grid-cols-2 gap-2">
              {Object.values(ReadingTone).map(t => (
                <button key={t} onClick={() => setSelectedTones(prev => prev.includes(t) ? (prev.length > 1 ? prev.filter(x => x !== t) : prev) : [...prev, t])} className={`px-2 py-2 rounded-lg text-[10px] border transition-all ${selectedTones.includes(t) ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-slate-200 dark:border-slate-800 text-slate-400'}`}>{t}</button>
              ))}
            </div>
          </section>

          <section>
            <div className="bg-slate-50 dark:bg-slate-800/50 p-4 rounded-xl space-y-4 border dark:border-slate-800">
               <div className="space-y-1">
                  <div className="flex justify-between text-[10px] font-bold"><span>Pitch Offset</span><span>{pitch}%</span></div>
                  <input type="range" min="-30" max="30" value={pitch} onChange={e => setPitch(parseInt(e.target.value))} className="w-full h-1 accent-indigo-600" />
               </div>
               <div className="flex items-center justify-between text-[10px] font-bold uppercase">
                  <span>Breaths</span>
                  <button onClick={() => setIncludeBreaths(!includeBreaths)} className={`w-10 h-5 rounded-full relative transition-colors ${includeBreaths ? 'bg-indigo-600' : 'bg-slate-300'}`}><div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${includeBreaths ? 'translate-x-5' : ''}`} /></button>
               </div>
            </div>
          </section>

          <button onClick={startSynthesis} disabled={isGeneratingAudio} className="w-full bg-indigo-600 text-white py-4 rounded-xl font-bold text-sm shadow-xl hover:bg-indigo-700 disabled:opacity-50">
            {isGeneratingAudio ? `Encoding ${Math.round(genProgress)}%` : 'Generate Audiobook'}
          </button>
        </div>
      </aside>

      {/* MAIN PANEL */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="lg:hidden p-4 border-b dark:border-slate-800 flex items-center justify-between bg-white dark:bg-slate-950">
          <button onClick={() => setIsSidebarOpen(true)}><Bars3Icon className="w-6 h-6" /></button>
          <span className="font-bold">Ivanchat</span>
          <button onClick={() => setShowChat(!showChat)}><ChatBubbleLeftRightIcon className="w-6 h-6" /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 sm:p-8 lg:p-12 flex flex-col" ref={scrollContainerRef}>
          <div className="max-w-4xl mx-auto w-full flex flex-col flex-1">
            <header className="hidden lg:flex justify-between items-center mb-8 pb-6 border-b dark:border-slate-800">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-2xl overflow-hidden shadow-lg border dark:border-slate-700">
                  <img src={appLogo} alt="Logo" className="w-full h-full object-cover" />
                </div>
                <div>
                  <h2 className="text-3xl font-serif font-bold">{viewMode === 'editor' ? 'Editor' : 'Reader'}</h2>
                  <div className="flex items-center gap-2 text-slate-400 text-xs font-bold uppercase">
                    <span>{activeChapter?.title}</span>
                    <span className={`w-2 h-2 rounded-full ${saveStatus === 'saved' ? 'bg-emerald-500' : 'bg-amber-400'}`} />
                  </div>
                </div>
              </div>
              <button onClick={() => { setNovelText(''); addToast("Cleared", "info"); }} className="text-xs text-slate-400 hover:text-rose-500 font-bold uppercase">Clear Workspace</button>
            </header>

            <article className="flex-1 pb-12">
              {viewMode === 'reader' && duration > 0 && (
                <div className="sticky top-0 z-20 py-4 bg-slate-50/80 dark:bg-slate-950/80 backdrop-blur-md mb-8">
                   <div className="flex items-center gap-4 bg-slate-900 text-white p-4 rounded-3xl shadow-2xl">
                      <button onClick={togglePlayback} className="w-14 h-14 bg-indigo-600 rounded-full flex items-center justify-center hover:bg-indigo-500">
                        {isAudioPlaying ? <PauseIcon className="w-7 h-7" /> : <PlayIcon className="w-7 h-7 ml-1" />}
                      </button>
                      <div className="flex-1 flex flex-col gap-1">
                        <div className="flex justify-between text-[10px] font-mono text-indigo-400 uppercase font-bold px-1">
                          <span>{new Date(currentTime * 1000).toISOString().substr(14, 5)}</span>
                          <span>{new Date(duration * 1000).toISOString().substr(14, 5)}</span>
                        </div>
                        <div className="relative h-2 group flex items-center">
                          <input type="range" min="0" max={duration} step="0.01" value={currentTime} onChange={e => handleSeek(parseFloat(e.target.value))} className="absolute inset-0 w-full h-1 bg-slate-800 rounded-full appearance-none cursor-pointer accent-indigo-500 z-10" />
                          <div className="absolute left-0 h-1 bg-indigo-500 rounded-full pointer-events-none" style={{ width: `${(currentTime / duration) * 100}%` }} />
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                         <div className="flex items-center gap-2 px-3 py-2 bg-slate-800 rounded-2xl">
                            <select value={audioSpeed} onChange={e => setAudioSpeed(parseFloat(e.target.value))} className="bg-transparent text-[10px] font-bold outline-none text-white">
                               <option className="bg-slate-900" value="0.75">0.75x</option>
                               <option className="bg-slate-900" value="1.0">1.0x</option>
                               <option className="bg-slate-900" value="1.25">1.25x</option>
                               <option className="bg-slate-900" value="1.5">1.5x</option>
                            </select>
                         </div>
                         <button onClick={handleExportWav} className="p-3 bg-slate-800 rounded-2xl hover:text-indigo-400"><ArrowDownOnSquareIcon className="w-5 h-5" /></button>
                         <button onClick={handleExportMp4} className="p-3 bg-slate-800 rounded-2xl hover:text-indigo-400"><VideoCameraIcon className="w-5 h-5" /></button>
                      </div>
                   </div>
                </div>
              )}

              {viewMode === 'editor' ? (
                <textarea value={novelText} onChange={e => setNovelText(e.target.value)} placeholder="Type or paste your novel..." className="w-full flex-1 min-h-[60vh] p-8 bg-white dark:bg-slate-900 rounded-3xl shadow-xl font-serif text-lg leading-relaxed focus:ring-0 border-none resize-none" />
              ) : (
                <div className="w-full min-h-[60vh] p-8 bg-white dark:bg-slate-900 rounded-3xl shadow-xl font-serif text-lg leading-relaxed whitespace-pre-wrap">
                  {processedData.map((s, si) => (
                    <span key={si} className={`inline-block transition-all ${si === activeIndices.sIdx ? 'bg-indigo-600/5' : ''}`}>
                      {s.words.map((w, wi) => {
                        const active = si === activeIndices.sIdx && wi === activeIndices.wIdx;
                        return <span key={wi} ref={active ? activeWordRef : null} className={`inline-block px-1 rounded transition-all ${active ? 'bg-indigo-600 text-white shadow-lg scale-110 z-10 relative' : ''}`}>{w.text}{' '}</span>;
                      })}
                    </span>
                  ))}
                </div>
              )}
            </article>
          </div>
        </div>

        {/* CHATBOT */}
        {showChat && (
          <div className="fixed lg:absolute bottom-0 right-0 z-50 flex flex-col glass-panel shadow-2xl w-full lg:w-[400px] h-[80vh] lg:h-[600px] lg:bottom-10 lg:right-10 rounded-t-3xl lg:rounded-3xl animate-in slide-in-from-bottom duration-300">
            <header className="p-5 bg-indigo-600 text-white flex justify-between items-center rounded-t-3xl">
              <h3 className="font-bold">Literary Assistant</h3>
              <button onClick={() => setShowChat(false)}><XMarkIcon className="w-5 h-5" /></button>
            </header>
            <div className="flex-1 overflow-y-auto p-5 space-y-4 scrollbar-hide bg-white/30 dark:bg-slate-900/30 backdrop-blur-3xl">
              {messages.map(m => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[85%] p-3 rounded-2xl text-sm ${m.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 shadow-sm'}`}>{m.text}</div></div>
              ))}
              {isChatting && <div className="text-xs text-slate-400 animate-pulse">Analyzing text...</div>}
            </div>
            <footer className="p-4 bg-white/90 dark:bg-slate-950/90 border-t dark:border-slate-800 rounded-b-3xl">
              <div className="flex gap-2">
                <input type="text" value={userInput} onChange={e => setUserInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSendMessage()} placeholder="Ask about the plot..." className="flex-1 px-4 py-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-sm" />
                <button onClick={handleSendMessage} className="bg-indigo-600 text-white p-2 rounded-xl"><ArrowPathIcon className={`w-5 h-5 ${isChatting ? 'animate-spin' : ''}`} /></button>
              </div>
            </footer>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
