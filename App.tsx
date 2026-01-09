
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ReadingTone, VoiceGender, ChatMessage, Chapter, SentenceTimeline, AudioChunkMetadata } from './types.ts';
import { geminiService } from './services/geminiService.ts';
import { decodeBase64, decodeAudioData, audioBufferToWav, saveAudioToDB, getAudioFromDB } from './services/audioService.ts';
import { 
  PlayIcon, PauseIcon, ChatBubbleLeftRightIcon, ArrowPathIcon, BookOpenIcon, 
  SpeakerWaveIcon, UserIcon, MoonIcon, SunIcon, SparklesIcon, HashtagIcon, 
  ArrowDownTrayIcon, Bars3Icon, XMarkIcon, TrashIcon, EyeIcon, EyeSlashIcon,
  MusicalNoteIcon
} from '@heroicons/react/24/outline';

const App: React.FC = () => {
  // --- Global Application States ---
  const [appLogo, setAppLogo] = useState<string>(() => localStorage.getItem('ivanchat_app_logo') || '');
  const [novelText, setNovelText] = useState<string>(() => localStorage.getItem('ivanchat_novel_text') || '');
  const [selectedTones, setSelectedTones] = useState<ReadingTone[]>([ReadingTone.NEUTRAL]);
  const [gender, setGender] = useState<VoiceGender>(VoiceGender.MALE);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [userInput, setUserInput] = useState('');
  const [isChatting, setIsChatting] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(() => localStorage.getItem('ivanchat_theme') !== 'light');
  const [viewMode, setViewMode] = useState<'editor' | 'reader'>('editor');
  const [toasts, setToasts] = useState<{id: string, message: string, type: string}[]>([]);
  
  // --- Playback States ---
  const [audioSpeed, setAudioSpeed] = useState(1.0);
  const [pitch, setPitch] = useState(0);
  const [includeBreaths, setIncludeBreaths] = useState(true);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isGeneratingAudio, setIsGeneratingAudio] = useState(false);
  const [genProgress, setGenProgress] = useState(0);
  const [audioChunks, setAudioChunks] = useState<AudioChunkMetadata[]>([]);
  const [followActiveText, setFollowActiveText] = useState(true);
  const [showChat, setShowChat] = useState(false);

  // --- Audio Engine Refs ---
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

  // --- Initializers ---
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
    localStorage.setItem('ivanchat_theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  useEffect(() => {
    localStorage.setItem('ivanchat_novel_text', novelText);
  }, [novelText]);

  useEffect(() => {
    if (!appLogo && !isGeneratingAudio) {
      geminiService.generateAppLogo().then(logo => {
        if (logo) {
          setAppLogo(logo);
          localStorage.setItem('ivanchat_app_logo', logo);
        }
      }).catch(console.error);
    }
  }, []);

  // --- Linguistic Engine ---
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
    return rawSentences.map((sText, sIdx) => {
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
      return { text: sText, start: sentenceStart, end: offset, words, globalIndex: sIdx };
    });
  }, [activeChapter]);

  // Timeline Engine
  const currentTimelineIndices = useMemo(() => {
    if (duration === 0 || audioChunks.length === 0) return { sIdx: -1, wIdx: -1 };
    
    const chunk = audioChunks.find(c => currentTime >= c.audioStart && currentTime <= c.audioEnd);
    if (!chunk) return { sIdx: -1, wIdx: -1 };

    const sentence = chunk.sentences.find(s => currentTime >= s.audioStart && currentTime <= s.audioEnd);
    if (!sentence) return { sIdx: -1, wIdx: -1 };

    const sData = processedData[sentence.globalIndex];
    if (!sData) return { sIdx: -1, wIdx: -1 };

    const sDuration = sentence.audioEnd - sentence.audioStart;
    const sProgress = (currentTime - sentence.audioStart) / (sDuration || 1);
    const wIdx = Math.floor(sProgress * sData.words.length);
    
    return { sIdx: sentence.globalIndex, wIdx: Math.min(wIdx, sData.words.length - 1) };
  }, [currentTime, audioChunks, duration, processedData]);

  useEffect(() => {
    if (viewMode === 'reader' && followActiveText && activeWordRef.current && scrollContainerRef.current) {
      activeWordRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentTimelineIndices.wIdx, viewMode, followActiveText]);

  // --- Cache Restore ---
  const loadChapterCache = useCallback(async (chapterId: string) => {
    try {
      const blob = await getAudioFromDB(`audio_${chapterId}`);
      if (blob && blob.size > 0) {
        if (!audioContextRef.current) audioContextRef.current = new AudioContext({ sampleRate: 24000 });
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
          addToast("Session restored", "info");
        }
      }
    } catch (e) {
      console.error("Cache load error:", e);
    }
  }, [addToast]);

  useEffect(() => {
    loadChapterCache(selectedChapterId);
  }, [selectedChapterId, loadChapterCache]);

  // --- Playback Engine ---
  const playBuffer = (buffer: AudioBuffer, offset: number) => {
    if (!audioContextRef.current) audioContextRef.current = new AudioContext({ sampleRate: 24000 });
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
      const startPos = Math.min(pausedTimeRef.current, currentAudioBufferRef.current.duration - 0.1);
      playBuffer(currentAudioBufferRef.current, Math.max(0, startPos));
      setIsAudioPlaying(true);
    }
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

  // --- Synthesis Pipeline ---
  const startSynthesis = async () => {
    if (!activeChapter?.content.trim()) return addToast("Editor is empty", "error");

    try {
      setIsGeneratingAudio(true);
      setGenProgress(0);
      setIsSidebarOpen(false);

      // Fault-Tolerant Pipeline: Target ~175s/chunk (~500 words)
      const targetWordsPerChunk = 500;
      const chunks: { text: string; sentences: any[] }[] = [];
      let currentChunkText = "";
      let currentChunkSents: any[] = [];
      let currentWordCount = 0;

      processedData.forEach((s) => {
        const sWC = s.words.length;
        if (currentWordCount + sWC > targetWordsPerChunk && currentChunkText.length > 0) {
          chunks.push({ text: currentChunkText, sentences: currentChunkSents });
          currentChunkText = s.text; currentChunkSents = [s]; currentWordCount = sWC;
        } else {
          currentChunkText += s.text; currentChunkSents.push(s); currentWordCount += sWC;
        }
      });
      if (currentChunkText) chunks.push({ text: currentChunkText, sentences: currentChunkSents });

      const ctx = new AudioContext({ sampleRate: 24000 });
      const results: { buf: AudioBuffer, meta: any, chunkIndex: number }[] = new Array(chunks.length);
      const concurrency = 3; 

      for (let i = 0; i < chunks.length; i += concurrency) {
        const batch = chunks.slice(i, i + concurrency);
        await Promise.all(batch.map(async (c, bIdx) => {
          const idx = i + bIdx;
          const scene = await geminiService.analyzeScene(c.text);
          const b64 = await geminiService.textToSpeech(c.text, selectedTones, gender, pitch, includeBreaths, scene);
          const buf = await decodeAudioData(decodeBase64(b64), ctx, 24000, 1);
          results[idx] = { buf, meta: scene, chunkIndex: idx };
          setGenProgress((results.filter(Boolean).length / chunks.length) * 100);
        }));
      }

      // Reassembly Step
      const totalSamples = results.reduce((acc, r) => acc + (r ? r.buf.length : 0), 0);
      const merged = ctx.createBuffer(1, totalSamples, 24000);
      let sampleOffset = 0;
      let timeOffset = 0;
      const metadata: AudioChunkMetadata[] = [];

      results.forEach((r, idx) => {
        if (!r) return;
        const chunkData = chunks[idx];
        merged.getChannelData(0).set(r.buf.getChannelData(0), sampleOffset);
        
        const totalWordsInChunk = chunkData.sentences.reduce((a, s) => a + s.words.length, 0);
        const chunkDuration = r.buf.duration;
        let chunkTimeCursor = timeOffset;

        const sentenceTimelines: SentenceTimeline[] = chunkData.sentences.map(s => {
          const sDur = (s.words.length / totalWordsInChunk) * chunkDuration;
          const start = chunkTimeCursor;
          const end = start + sDur;
          chunkTimeCursor = end;
          return { sentenceIndex: s.globalIndex, globalIndex: s.globalIndex, text: s.text, audioStart: start, audioEnd: end, wordCount: s.words.length };
        });

        metadata.push({
          chunkIndex: idx, charStart: chunkData.sentences[0].start, charEnd: chunkData.sentences[chunkData.sentences.length - 1].end,
          audioStart: timeOffset, audioEnd: timeOffset + chunkDuration, sentences: sentenceTimelines
        });

        sampleOffset += r.buf.length;
        timeOffset += chunkDuration;
      });

      currentAudioBufferRef.current = merged;
      setAudioChunks(metadata);
      setDuration(merged.duration);
      setCurrentTime(0);
      pausedTimeRef.current = 0;
      setViewMode('reader');
      
      const wav = audioBufferToWav(merged);
      await saveAudioToDB(`audio_${selectedChapterId}`, wav);
      localStorage.setItem(`ivanchat_meta_${selectedChapterId}`, JSON.stringify(metadata));
      
      audioContextRef.current = ctx;
      playBuffer(merged, 0);
      setIsAudioPlaying(true);
      addToast("Narration reassembled", "success");
    } catch (e) {
      console.error(e);
      addToast("Synthesis failed. Check API balance.", "error");
    } finally {
      setIsGeneratingAudio(false);
    }
  };

  const handleSendMessage = async () => {
    if (!userInput.trim()) return;
    const msg: ChatMessage = { id: Date.now().toString(), role: 'user', text: userInput, timestamp: new Date() };
    setMessages(prev => [...prev, msg]);
    setUserInput('');
    setIsChatting(true);
    try {
      const hist = messages.map(m => ({ role: m.role, parts: [{ text: m.text }] }));
      const res = await geminiService.chat(msg.text, novelText, hist);
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text: res, timestamp: new Date() }]);
    } catch (e) {
      addToast("AI Assistant error", "error");
    } finally {
      setIsChatting(false);
    }
  };

  return (
    <div className="flex h-screen-safe bg-slate-50 dark:bg-slate-950 overflow-hidden text-slate-900 dark:text-slate-100 font-sans transition-colors duration-500 relative">
      
      {/* TOASTS */}
      <div className="fixed top-6 right-6 z-[200] flex flex-col gap-3 w-full max-w-sm px-4 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className={`flex items-center gap-3 px-5 py-4 rounded-2xl shadow-2xl border backdrop-blur-xl animate-in slide-in-from-right duration-300 pointer-events-auto ${t.type === 'success' ? 'bg-indigo-600/90 border-indigo-400 text-white' : t.type === 'error' ? 'bg-rose-600/90 border-rose-400 text-white' : 'bg-white/90 dark:bg-slate-800/90 border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white'}`}>
            <span className="text-sm font-semibold flex-1">{t.message}</span>
            <button onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))} className="opacity-50"><XMarkIcon className="w-4 h-4" /></button>
          </div>
        ))}
      </div>

      {/* OVERLAY LOADER */}
      {isGeneratingAudio && (
        <div className="fixed inset-0 z-[100] bg-slate-900/90 backdrop-blur-2xl flex flex-col items-center justify-center text-white animate-in fade-in duration-500">
           <div className="w-24 h-24 mb-8 relative">
              <div className="absolute inset-0 border-4 border-indigo-500/20 rounded-full" />
              <div className="absolute inset-0 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
              <div className="absolute inset-0 flex items-center justify-center font-bold text-xs">{Math.round(genProgress)}%</div>
           </div>
           <h2 className="text-2xl font-bold tracking-tight mb-2">Architecting Narration</h2>
           <p className="text-slate-400 text-sm italic">Assembling high-fidelity audio chunks across worker nodes...</p>
        </div>
      )}

      {/* SIDEBAR */}
      <aside className={`fixed inset-y-0 left-0 z-40 w-[320px] bg-white dark:bg-slate-900 border-r dark:border-slate-800 shadow-2xl transition-transform lg:translate-x-0 lg:static flex flex-col shrink-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="p-6 border-b dark:border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center overflow-hidden shadow-lg border border-white/10">
               {appLogo ? <img src={appLogo} alt="Logo" className="w-full h-full object-cover" /> : <div className="text-white font-bold text-lg">IV</div>}
            </div>
            <h1 className="text-xl font-bold tracking-tight">Ivanchat</h1>
          </div>
          <button onClick={() => setIsDarkMode(!isDarkMode)} className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-indigo-600 transition-colors">
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
            <div className="text-slate-400 font-bold uppercase text-[10px] tracking-widest mb-3">Chapter Navigation</div>
            <div className="space-y-1 max-h-40 overflow-y-auto scrollbar-hide border-l dark:border-slate-800 pl-4">
              {chapters.map(ch => (
                <button key={ch.id} onClick={() => setSelectedChapterId(ch.id)} className={`w-full text-left px-3 py-2 rounded-xl text-xs transition-all flex items-center gap-3 ${selectedChapterId === ch.id ? 'bg-indigo-600 text-white shadow-lg' : 'bg-transparent text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
                  <span className="truncate font-medium">{ch.title}</span>
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="text-slate-400 font-bold uppercase text-[10px] tracking-widest mb-3">Narrative Profile</div>
            <div className="bg-slate-100 dark:bg-slate-800 p-4 rounded-2xl space-y-4 border dark:border-slate-700">
               <div className="flex gap-1">
                  {Object.values(VoiceGender).map(g => (
                    <button key={g} onClick={() => setGender(g)} className={`flex-1 py-1.5 text-[10px] rounded-lg border transition-all ${gender === g ? 'bg-indigo-600 border-indigo-600 text-white shadow-md' : 'border-slate-300 dark:border-slate-700 text-slate-500 hover:border-indigo-400'}`}>{g}</button>
                  ))}
               </div>
               <div className="grid grid-cols-2 gap-1.5">
                 {Object.values(ReadingTone).map(t => (
                   <button key={t} onClick={() => setSelectedTones(p => p.includes(t) ? (p.length > 1 ? p.filter(x => x !== t) : p) : [...p, t])} className={`px-2 py-1.5 rounded-lg text-[10px] border transition-all truncate ${selectedTones.includes(t) ? 'bg-indigo-600 border-indigo-600 text-white shadow-sm' : 'border-slate-300 dark:border-slate-700 text-slate-500'}`}>{t}</button>
                 ))}
               </div>
               <div className="space-y-1 pt-2">
                  <div className="flex justify-between text-[10px] font-bold"><span>Pitch Offset</span><span>{pitch}%</span></div>
                  <input type="range" min="-30" max="30" value={pitch} onChange={e => setPitch(parseInt(e.target.value))} className="w-full h-1 accent-indigo-600 appearance-none bg-slate-300 dark:bg-slate-700 rounded-full cursor-pointer" />
               </div>
               <div className="flex items-center justify-between pt-2">
                  <span className="text-[10px] font-bold uppercase text-slate-400">Audible Breaths</span>
                  <button onClick={() => setIncludeBreaths(!includeBreaths)} className={`w-10 h-5 rounded-full relative transition-colors ${includeBreaths ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-slate-700'}`}>
                    <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${includeBreaths ? 'translate-x-5' : ''}`} />
                  </button>
               </div>
            </div>
          </section>

          <div className="pt-4 pb-12 space-y-2">
            <button onClick={startSynthesis} disabled={isGeneratingAudio} className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-bold text-sm shadow-xl shadow-indigo-600/30 hover:bg-indigo-700 active:scale-95 disabled:opacity-50 transition-all flex items-center justify-center gap-2">
              {isGeneratingAudio ? <ArrowPathIcon className="w-5 h-5 animate-spin" /> : <MusicalNoteIcon className="w-5 h-5" />}
              Generate Narration
            </button>
            {duration > 0 && (
              <button onClick={async () => { await saveAudioToDB(`audio_${selectedChapterId}`, new Blob([])); window.location.reload(); }} className="w-full flex items-center justify-center gap-2 py-2 text-[10px] text-slate-400 hover:text-rose-500 transition-colors uppercase font-bold tracking-widest">
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
          <span className="font-bold text-sm tracking-tight">Ivanchat</span>
          <button onClick={() => setShowChat(!showChat)} className={`p-2 rounded-xl transition-colors ${showChat ? 'bg-indigo-600 text-white' : 'bg-slate-50 dark:bg-slate-900'}`}><ChatBubbleLeftRightIcon className="w-6 h-6" /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 sm:p-8 lg:p-12 flex flex-col scrollbar-hide" ref={scrollContainerRef}>
          <div className="max-w-5xl mx-auto w-full flex flex-col flex-1">
            <header className="hidden lg:flex justify-between items-center mb-8 pb-6 border-b dark:border-slate-800 shrink-0">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-2xl overflow-hidden shadow-xl border dark:border-slate-700 bg-white dark:bg-slate-800 flex items-center justify-center relative">
                  {appLogo ? <img src={appLogo} alt="Logo" className="w-full h-full object-cover" /> : <div className="text-indigo-600 font-bold text-xl">IV</div>}
                </div>
                <div>
                  <h2 className="text-4xl font-serif font-bold text-slate-800 dark:text-slate-100">{viewMode === 'editor' ? 'Manuscript Editor' : 'Immersive Reader'}</h2>
                  <div className="flex items-center gap-2 text-slate-400 text-[10px] font-bold uppercase tracking-widest mt-1">
                    <span className="text-indigo-500">{activeChapter?.title}</span>
                    <span className="opacity-20">/</span>
                    <span className="text-emerald-500 font-bold">{duration > 0 ? `${Math.round(duration / 60)}m Master` : "Draft"}</span>
                  </div>
                </div>
              </div>
            </header>

            <article className="flex-1 pb-96">
              {viewMode === 'reader' && duration > 0 && (
                <div className="sticky top-0 lg:top-4 z-20 py-4 mb-12">
                   <div className="flex flex-col sm:flex-row items-center gap-6 bg-slate-900/95 text-white p-6 sm:p-8 rounded-[3rem] shadow-[0_30px_60px_rgba(0,0,0,0.5)] border border-white/5 backdrop-blur-xl">
                      <button onClick={togglePlayback} className="w-20 h-20 bg-indigo-600 rounded-full flex items-center justify-center hover:bg-indigo-500 shadow-2xl shadow-indigo-600/30 active:scale-95 transition-all shrink-0">
                        {isAudioPlaying ? <PauseIcon className="w-10 h-10" /> : <PlayIcon className="w-10 h-10 ml-1" />}
                      </button>
                      <div className="flex-1 flex flex-col gap-3 w-full">
                        <div className="flex justify-between text-[11px] font-mono text-indigo-400 uppercase font-bold px-1 tracking-widest">
                          <span>{new Date(currentTime * 1000).toISOString().substr(14, 5)}</span>
                          <span>{new Date(duration * 1000).toISOString().substr(14, 5)}</span>
                        </div>
                        <div className="relative h-2 group flex items-center">
                          <input type="range" min="0" max={duration} step="0.01" value={currentTime} onChange={e => { setCurrentTime(parseFloat(e.target.value)); pausedTimeRef.current = parseFloat(e.target.value); if (isAudioPlaying) playBuffer(currentAudioBufferRef.current!, parseFloat(e.target.value)); }} className="absolute inset-0 w-full h-1 bg-slate-800 rounded-full appearance-none cursor-pointer accent-indigo-500 z-10" />
                          <div className="absolute left-0 h-1 bg-indigo-500 rounded-full pointer-events-none shadow-[0_0_15px_rgba(99,102,241,0.6)]" style={{ width: `${(currentTime / duration) * 100}%` }} />
                        </div>
                      </div>
                      <div className="flex items-center gap-4 shrink-0">
                         <button onClick={() => setFollowActiveText(!followActiveText)} title="Toggle Scroll Tracking" className={`p-4 rounded-2xl border transition-all ${followActiveText ? 'bg-indigo-600 text-white border-indigo-500 shadow-lg' : 'bg-slate-800 text-slate-500 border-white/5'}`}>
                            {followActiveText ? <EyeIcon className="w-6 h-6" /> : <EyeSlashIcon className="w-6 h-6" />}
                         </button>
                         <div className="flex items-center gap-3 px-5 py-3 bg-slate-800 rounded-2xl border border-white/5">
                            <select value={audioSpeed} onChange={e => setAudioSpeed(parseFloat(e.target.value))} className="bg-transparent text-[12px] font-bold outline-none text-white cursor-pointer hover:text-indigo-400 transition-colors">
                               <option className="bg-slate-900" value="0.75">0.75x</option>
                               <option className="bg-slate-900" value="1.0">1.0x</option>
                               <option className="bg-slate-900" value="1.5">1.5x</option>
                            </select>
                         </div>
                      </div>
                   </div>
                </div>
              )}

              {viewMode === 'editor' ? (
                <textarea 
                  value={novelText} 
                  onChange={e => setNovelText(e.target.value)} 
                  placeholder="Paste your epic here..." 
                  className="w-full flex-1 min-h-[90vh] p-8 sm:p-16 bg-white dark:bg-slate-900 rounded-[3rem] shadow-2xl font-serif text-xl sm:text-2xl leading-[2.2] focus:ring-8 focus:ring-indigo-500/5 border-none resize-none transition-all scrollbar-hide text-slate-800 dark:text-slate-100" 
                />
              ) : (
                <div className="w-full min-h-[90vh] p-8 sm:p-16 bg-white dark:bg-slate-900 rounded-[3rem] shadow-2xl font-serif text-xl sm:text-2xl leading-[2.2] whitespace-pre-wrap transition-all relative">
                  {processedData.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-64 opacity-20">
                       <BookOpenIcon className="w-24 h-24 mb-6" />
                       <p className="font-sans font-bold uppercase tracking-widest text-sm">No Content Detected</p>
                    </div>
                  ) : (
                    processedData.map((s, si) => {
                      const sentenceActive = si === currentTimelineIndices.sIdx;
                      return (
                        <span key={si} className={`inline-block transition-all duration-700 ease-in-out my-1 ${sentenceActive ? 'active-sentence' : ''}`}>
                          {s.words.map((w, wi) => {
                            const wordActive = sentenceActive && wi === currentTimelineIndices.wIdx;
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

        {/* FLOATING CHAT */}
        {showChat && (
          <div className="fixed lg:absolute bottom-0 right-0 z-50 flex flex-col glass-panel shadow-[0_-20px_60px_rgba(0,0,0,0.3)] w-full lg:w-[450px] h-[95vh] lg:h-[750px] lg:bottom-12 lg:right-12 rounded-t-[3rem] lg:rounded-[3rem] animate-in slide-in-from-bottom duration-500 border border-slate-200 dark:border-slate-800 overflow-hidden">
            <header className="p-8 bg-indigo-600 text-white flex justify-between items-center shrink-0">
               <div className="flex items-center gap-3">
                 <SparklesIcon className="w-6 h-6" />
                 <h3 className="font-bold">Story Architect</h3>
               </div>
               <button onClick={() => setShowChat(false)} className="p-2 hover:bg-white/10 rounded-xl transition-all"><XMarkIcon className="w-8 h-8" /></button>
            </header>
            <div className="flex-1 overflow-y-auto p-8 space-y-6 scrollbar-hide bg-slate-50/50 dark:bg-slate-950/50">
              {messages.length === 0 && <div className="text-center py-24 opacity-20 italic text-sm">Analyze character arcs, symbolism, or plot structure with your assistant.</div>}
              {messages.map(m => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] p-5 rounded-[2rem] text-[15px] leading-relaxed ${m.role === 'user' ? 'bg-indigo-600 text-white rounded-tr-none shadow-indigo-600/20' : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-tl-none border dark:border-slate-700 shadow-sm'}`}>
                    {m.text}
                  </div>
                </div>
              ))}
              {isChatting && <div className="text-indigo-600 font-bold text-xs animate-pulse flex items-center gap-2"><ArrowPathIcon className="w-3 h-3 animate-spin" /> Assistant Thinking...</div>}
            </div>
            <footer className="p-6 border-t dark:border-slate-800 bg-white dark:bg-slate-900 shrink-0">
              <div className="flex gap-3">
                <input type="text" value={userInput} onChange={e => setUserInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && !isChatting && handleSendMessage()} className="flex-1 px-6 py-4 bg-slate-100 dark:bg-slate-800 rounded-2xl outline-none focus:ring-2 ring-indigo-500 transition-all text-sm" placeholder="Query the assistant..." />
                <button onClick={handleSendMessage} disabled={isChatting || !userInput.trim()} className="p-4 bg-indigo-600 text-white rounded-2xl hover:bg-indigo-700 active:scale-95 disabled:opacity-30 transition-all"><ArrowPathIcon className={`w-5 h-5 ${isChatting ? 'animate-spin' : ''}`} /></button>
              </div>
            </footer>
          </div>
        )}

        {!showChat && (
          <button onClick={() => setShowChat(true)} className="fixed lg:absolute bottom-12 right-12 w-20 h-20 bg-indigo-600 text-white rounded-[2.2rem] flex items-center justify-center shadow-[0_20px_50px_rgba(99,102,241,0.5)] hover:scale-110 active:scale-95 transition-all z-50 border border-white/10">
            <ChatBubbleLeftRightIcon className="w-10 h-10" />
          </button>
        )}
      </main>
    </div>
  );
};

export default App;
