
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ReadingTone, VoiceGender, ChatMessage, Chapter, SentenceTimeline, AudioChunkMetadata } from './types.ts';
import { geminiService } from './services/geminiService.ts';
import { decodeBase64, decodeAudioData, audioBufferToWav, saveAudioToDB, getAudioFromDB } from './services/audioService.ts';
import { 
  PlayIcon, PauseIcon, ChatBubbleLeftRightIcon, ArrowPathIcon, BookOpenIcon, 
  SpeakerWaveIcon, UserIcon, MoonIcon, SunIcon, SparklesIcon, HashtagIcon, 
  ArrowDownTrayIcon, Bars3Icon, XMarkIcon, TrashIcon, EyeIcon, EyeSlashIcon,
  MusicalNoteIcon, SparklesIcon as SparklesOutline
} from '@heroicons/react/24/outline';

const App: React.FC = () => {
  // --- States ---
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
  const [audioSpeed, setAudioSpeed] = useState(1.0);
  const [pitch, setPitch] = useState(0);
  const [includeBreaths, setIncludeBreaths] = useState(true);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isGeneratingAudio, setIsGeneratingAudio] = useState(false);
  const [genProgress, setGenProgress] = useState(0);
  const [audioChunks, setAudioChunks] = useState<AudioChunkMetadata[]>([]);
  const [showChat, setShowChat] = useState(false);
  const [followActiveText, setFollowActiveText] = useState(true);

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

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
    localStorage.setItem('ivanchat_theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  useEffect(() => {
    localStorage.setItem('ivanchat_novel_text', novelText);
  }, [novelText]);

  // --- Chapter & Highlighting Engine ---
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

  // Precise Timeline Resolver
  const currentTimelineIndices = useMemo(() => {
    if (duration === 0 || audioChunks.length === 0) return { sIdx: -1, wIdx: -1 };
    
    const chunk = audioChunks.find(c => currentTime >= c.audioStart && currentTime <= c.audioEnd);
    if (!chunk) return { sIdx: -1, wIdx: -1 };

    const sentence = chunk.sentences.find(s => currentTime >= s.audioStart && currentTime <= s.audioEnd);
    if (!sentence) return { sIdx: -1, wIdx: -1 };

    const sData = processedData[sentence.globalIndex];
    if (!sData) return { sIdx: -1, wIdx: -1 };

    const sProgress = (currentTime - sentence.audioStart) / (sentence.audioEnd - sentence.audioStart || 1);
    const wIdx = Math.floor(sProgress * sData.words.length);
    
    return { sIdx: sentence.globalIndex, wIdx: Math.min(wIdx, sData.words.length - 1) };
  }, [currentTime, audioChunks, duration, processedData]);

  useEffect(() => {
    if (viewMode === 'reader' && followActiveText && activeWordRef.current && scrollContainerRef.current) {
      activeWordRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentTimelineIndices.wIdx, viewMode, followActiveText]);

  const loadChapterCache = useCallback(async (chapterId: string) => {
    try {
      const blob = await getAudioFromDB(`audio_${chapterId}`);
      if (blob && blob.size > 0) {
        if (!audioContextRef.current) audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        const buffer = await audioContextRef.current.decodeAudioData(await blob.arrayBuffer());
        const storedMeta = localStorage.getItem(`ivanchat_meta_${chapterId}`);
        if (storedMeta) {
          const metaArr = JSON.parse(storedMeta);
          currentAudioBufferRef.current = buffer;
          setAudioChunks(metaArr);
          setDuration(buffer.duration);
          setCurrentTime(0);
          pausedTimeRef.current = 0;
          addToast("Cache restored", "info");
        }
      } else {
        currentAudioBufferRef.current = null;
        setAudioChunks([]);
        setDuration(0);
      }
    } catch (e) {
      console.error("Cache restoration failed:", e);
    }
  }, [addToast]);

  useEffect(() => {
    loadChapterCache(selectedChapterId);
  }, [selectedChapterId, loadChapterCache]);

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
      const s = Math.min(pausedTimeRef.current, currentAudioBufferRef.current.duration);
      playBuffer(currentAudioBufferRef.current, s);
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

  // --- Synthesis Engine (Fault-Tolerant, Ordered Pipeline) ---
  const startSynthesis = async () => {
    const content = activeChapter?.content.trim();
    if (!content) return addToast("Manuscript is empty", "error");

    try {
      setIsGeneratingAudio(true);
      setGenProgress(0);
      setIsSidebarOpen(false);

      // Deterministic Sizing: 2.8 words/sec * 175s (~2:55m) = ~490 words per chunk
      const targetWordsPerChunk = 490;
      const chunks: { text: string; sentences: any[] }[] = [];
      let curChunkText = "";
      let curChunkSents: any[] = [];
      let curWordCount = 0;

      processedData.forEach((s) => {
        const sWC = s.words.length;
        if (curWordCount + sWC > targetWordsPerChunk && curChunkText.length > 0) {
          chunks.push({ text: curChunkText, sentences: curChunkSents });
          curChunkText = s.text; curChunkSents = [s]; curWordCount = sWC;
        } else {
          curChunkText += s.text; curChunkSents.push(s); curWordCount += sWC;
        }
      });
      if (curChunkText) chunks.push({ text: curChunkText, sentences: curChunkSents });

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

      const totalSamples = results.reduce((acc, r) => acc + r.buf.length, 0);
      const merged = ctx.createBuffer(1, totalSamples, 24000);
      let sampleOffset = 0;
      let timeOffset = 0;
      const metadata: AudioChunkMetadata[] = [];

      results.forEach((r, idx) => {
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
      addToast("High-fidelity narration ready", "success");
    } catch (e) {
      console.error(e);
      addToast("Synthesis drift or API error. Retrying recommended.", "error");
    } finally {
      setIsGeneratingAudio(false);
    }
  };

  const toggleTone = (tone: ReadingTone) => {
    setSelectedTones(prev => {
      if (prev.includes(tone)) {
        if (prev.length === 1) return prev;
        return prev.filter(t => t !== tone);
      }
      return [...prev, tone];
    });
  };

  return (
    <div className="flex h-screen-safe bg-slate-50 dark:bg-slate-950 overflow-hidden text-slate-900 dark:text-slate-100 font-sans transition-colors duration-500 relative">
      
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
            <div className="text-slate-400 font-bold uppercase text-[10px] tracking-widest mb-3 flex justify-between items-center">
              <span>Chapter Select</span>
              <HashtagIcon className="w-3 h-3" />
            </div>
            <div className="space-y-1 max-h-40 overflow-y-auto scrollbar-hide border-l dark:border-slate-800 pl-4">
              {chapters.map(ch => (
                <button key={ch.id} onClick={() => setSelectedChapterId(ch.id)} className={`w-full text-left px-3 py-2 rounded-xl text-xs transition-all flex items-center gap-3 ${selectedChapterId === ch.id ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'bg-transparent text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
                  <span className="truncate font-medium">{ch.title}</span>
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="text-slate-400 font-bold uppercase text-[10px] tracking-widest mb-3">Narrative Profile</div>
            <div className="bg-slate-100 dark:bg-slate-800 p-4 rounded-2xl space-y-4">
               <div className="flex gap-1">
                  {Object.values(VoiceGender).map(g => (
                    <button key={g} onClick={() => setGender(g)} className={`flex-1 py-1.5 text-[10px] rounded-lg border transition-all ${gender === g ? 'bg-indigo-600 border-indigo-600 text-white shadow-md' : 'border-slate-300 dark:border-slate-700 text-slate-500 hover:border-indigo-400'}`}>{g}</button>
                  ))}
               </div>
               <div className="grid grid-cols-2 gap-2">
                 {Object.values(ReadingTone).map(t => (
                   <button key={t} onClick={() => toggleTone(t)} className={`px-2 py-1.5 rounded-lg text-[10px] border transition-all truncate ${selectedTones.includes(t) ? 'bg-indigo-600 border-indigo-600 text-white shadow-sm' : 'border-slate-300 dark:border-slate-700 text-slate-500'}`}>{t}</button>
                 ))}
               </div>
               <div className="space-y-1 pt-2">
                  <div className="flex justify-between text-[10px] font-bold"><span>Vocal Pitch</span><span>{pitch}%</span></div>
                  <input type="range" min="-30" max="30" value={pitch} onChange={e => setPitch(parseInt(e.target.value))} className="w-full h-1 accent-indigo-600 appearance-none bg-slate-300 dark:bg-slate-700 rounded-full cursor-pointer" />
               </div>
               <div className="flex items-center justify-between pt-2">
                  <span className="text-[10px] font-bold uppercase text-slate-400">Natural Breaths</span>
                  <button onClick={() => setIncludeBreaths(!includeBreaths)} className={`w-10 h-5 rounded-full relative transition-colors ${includeBreaths ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-slate-700'}`}>
                    <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${includeBreaths ? 'translate-x-5' : ''}`} />
                  </button>
               </div>
            </div>
          </section>

          <div className="pt-4 pb-12 space-y-2">
            <button onClick={startSynthesis} disabled={isGeneratingAudio} className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-bold text-sm shadow-xl shadow-indigo-600/30 hover:bg-indigo-700 active:scale-95 disabled:opacity-50 transition-all flex items-center justify-center gap-2">
              {isGeneratingAudio ? <ArrowPathIcon className="w-5 h-5 animate-spin" /> : <PlayIcon className="w-5 h-5" />}
              {isGeneratingAudio ? `Encoding ${Math.round(genProgress)}%` : 'Generate Master Track'}
            </button>
            {duration > 0 && (
              <button onClick={async () => { await saveAudioToDB(`audio_${selectedChapterId}`, new Blob([])); window.location.reload(); }} className="w-full flex items-center justify-center gap-2 py-2 text-[10px] text-slate-400 hover:text-rose-500 transition-colors uppercase font-bold tracking-widest">
                <TrashIcon className="w-3 h-3" /> Purge Chapter Cache
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
                  {duration > 0 && <div className="absolute -bottom-1 -right-1 bg-emerald-500 w-4 h-4 rounded-full border-2 border-white dark:border-slate-900" />}
                </div>
                <div>
                  <h2 className="text-4xl font-serif font-bold text-slate-800 dark:text-slate-100">{viewMode === 'editor' ? 'Manuscript Editor' : 'Immersive Reader'}</h2>
                  <div className="flex items-center gap-2 text-slate-400 text-[10px] font-bold uppercase tracking-widest mt-1">
                    <span className="text-indigo-500">{activeChapter?.title}</span>
                    <span className="opacity-20">/</span>
                    <span className="text-emerald-500 font-bold">{duration > 0 ? `${Math.round(duration / 60)}m Narrated` : "Draft Mode"}</span>
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
                         <button onClick={() => setFollowActiveText(!followActiveText)} title="Toggle Scroll Lock" className={`p-4 rounded-2xl border transition-all ${followActiveText ? 'bg-indigo-600 text-white border-indigo-500 shadow-lg' : 'bg-slate-800 text-slate-500 border-white/5'}`}>
                            {followActiveText ? <EyeIcon className="w-6 h-6" /> : <EyeSlashIcon className="w-6 h-6" />}
                         </button>
                         <div className="flex items-center gap-3 px-5 py-3 bg-slate-800 rounded-2xl border border-white/5">
                            <select value={audioSpeed} onChange={e => setAudioSpeed(parseFloat(e.target.value))} className="bg-transparent text-[12px] font-bold outline-none text-white cursor-pointer hover:text-indigo-400 transition-colors">
                               <option className="bg-slate-900" value="0.75">0.75x</option>
                               <option className="bg-slate-900" value="1.0">1.0x</option>
                               <option className="bg-slate-900" value="1.25">1.25x</option>
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
                  className="w-full flex-1 min-h-[90vh] p-8 sm:p-16 bg-white dark:bg-slate-900 rounded-[3rem] shadow-2xl font-serif text-xl sm:text-2xl leading-[2] focus:ring-8 focus:ring-indigo-500/5 border-none resize-none transition-all scrollbar-hide text-slate-800 dark:text-slate-100" 
                />
              ) : (
                <div className="w-full min-h-[90vh] p-8 sm:p-16 bg-white dark:bg-slate-900 rounded-[3rem] shadow-2xl font-serif text-xl sm:text-2xl leading-[2] whitespace-pre-wrap transition-all relative">
                  {processedData.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-64 opacity-20">
                       <BookOpenIcon className="w-24 h-24 mb-6" />
                       <p className="font-sans font-bold uppercase tracking-widest text-sm">Waiting for Narration</p>
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

        {/* CHAT FAB */}
        {!showChat && (
          <button 
            onClick={() => setShowChat(true)} 
            className="fixed bottom-12 right-12 w-20 h-20 bg-indigo-600 text-white rounded-[2.2rem] flex items-center justify-center shadow-[0_20px_50px_rgba(99,102,241,0.5)] hover:scale-110 hover:bg-indigo-500 active:scale-95 transition-all z-50 border border-white/10"
          >
            <ChatBubbleLeftRightIcon className="w-10 h-10" />
          </button>
        )}

        {showChat && (
          <div className="fixed lg:absolute bottom-0 right-0 z-50 flex flex-col glass-panel shadow-[0_-20px_60px_rgba(0,0,0,0.3)] w-full lg:w-[450px] h-[95vh] lg:h-[700px] lg:bottom-12 lg:right-12 rounded-t-[3rem] lg:rounded-[3rem] animate-in slide-in-from-bottom duration-500 border border-slate-200 dark:border-slate-800">
            <header className="p-8 bg-indigo-600 text-white flex justify-between items-center rounded-t-[3rem] shrink-0">
               <div className="flex items-center gap-3">
                 <SparklesIcon className="w-6 h-6" />
                 <h3 className="font-bold">Story Architect</h3>
               </div>
               <button onClick={() => setShowChat(false)} className="p-2 hover:bg-white/10 rounded-xl transition-all"><XMarkIcon className="w-8 h-8" /></button>
            </header>
            <div className="flex-1 overflow-y-auto p-8 space-y-6 scrollbar-hide">
              {messages.length === 0 && <div className="text-center py-20 opacity-30 italic text-sm">Analyze character arcs or thematic structure.</div>}
              {messages.map(m => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] p-5 rounded-[2rem] text-[15px] ${m.role === 'user' ? 'bg-indigo-600 text-white rounded-tr-none' : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-tl-none border'}`}>
                    {m.text}
                  </div>
                </div>
              ))}
              {isChatting && <div className="text-indigo-600 font-bold text-xs animate-pulse">Assistant is thinking...</div>}
            </div>
            <footer className="p-6 border-t dark:border-slate-800 shrink-0">
              <div className="flex gap-3">
                <input type="text" value={userInput} onChange={e => setUserInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && !isChatting && handleSendMessage()} className="flex-1 px-6 py-4 bg-slate-100 dark:bg-slate-800 rounded-2xl outline-none focus:ring-2 ring-indigo-500 transition-all" placeholder="Ask about the plot..." />
              </div>
            </footer>
          </div>
        )}
      </main>
    </div>
  );

  async function handleSendMessage() {
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
      addToast("AI Assistant unavailable", "error");
    } finally {
      setIsChatting(false);
    }
  }
};

export default App;
