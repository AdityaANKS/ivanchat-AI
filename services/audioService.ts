export function decodeBase64(base64: string): Uint8Array {
  try {
    if (!base64 || typeof base64 !== 'string') return new Uint8Array(0);
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  } catch (e) {
    console.error("Base64 decoding failed:", e);
    return new Uint8Array(0);
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number = 24000,
  numChannels: number = 1
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

export function floatTo16BitPCM(data: Float32Array): Uint8Array {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return new Uint8Array(int16.buffer);
}

/**
 * Enhanced WAV exporter with strict RIFF header compliance.
 */
export function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  
  const bufferLength = buffer.length;
  const dataSize = bufferLength * blockAlign;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;
  
  const arrayBuffer = new ArrayBuffer(totalSize);
  const view = new DataView(arrayBuffer);
  
  const writeString = (offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  /* RIFF identifier */
  writeString(0, 'RIFF');
  /* file length */
  view.setUint32(4, totalSize - 8, true);
  /* RIFF type */
  writeString(8, 'WAVE');
  /* format chunk identifier */
  writeString(12, 'fmt ');
  /* format chunk length */
  view.setUint32(16, 16, true);
  /* sample format (raw) */
  view.setUint16(20, format, true);
  /* channel count */
  view.setUint16(22, numChannels, true);
  /* sample rate */
  view.setUint32(24, sampleRate, true);
  /* byte rate (sample rate * block align) */
  view.setUint32(28, sampleRate * blockAlign, true);
  /* block align (channel count * bytes per sample) */
  view.setUint16(32, blockAlign, true);
  /* bits per sample */
  view.setUint16(34, bitDepth, true);
  /* data chunk identifier */
  writeString(36, 'data');
  /* data chunk length */
  view.setUint32(40, dataSize, true);

  const offset = 44;
  const channelData = [];
  for (let i = 0; i < numChannels; i++) {
    channelData.push(buffer.getChannelData(i));
  }

  let index = 0;
  for (let i = 0; i < bufferLength; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      let sample = channelData[channel][i];
      // Clamping and normalization for valid Int16 PCM
      sample = Math.max(-1, Math.min(1, sample));
      sample = sample < 0 ? sample * 32768 : sample * 32767;
      view.setInt16(offset + index, sample, true);
      index += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

/**
 * Advanced MP4/WebM Video exporter.
 * Captures a static frame (App Icon/Title) and combines it with the AudioBuffer.
 */
export async function audioBufferToMp4(buffer: AudioBuffer, title: string, iconUrl?: string | null): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d')!;

  // Background
  ctx.fillStyle = '#0f172a'; // Dark blue-slate
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Gradient Overlay
  const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  grad.addColorStop(0, 'rgba(79, 70, 229, 0.2)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw Icon if available
  if (iconUrl) {
    const img = new Image();
    img.src = iconUrl;
    await new Promise((resolve) => { img.onload = resolve; });
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(canvas.width / 2 - 100, canvas.height / 2 - 180, 200, 200, 40);
    ctx.clip();
    ctx.drawImage(img, canvas.width / 2 - 100, canvas.height / 2 - 180, 200, 200);
    ctx.restore();
  }

  // Draw Text
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 48px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Ivanchat Narrator', canvas.width / 2, canvas.height / 2 + 80);
  
  ctx.fillStyle = '#94a3b8';
  ctx.font = '32px Inter, sans-serif';
  ctx.fillText(title, canvas.width / 2, canvas.height / 2 + 130);

  // Capture Stream
  const stream = canvas.captureStream(1); // 1 FPS for static video
  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  const dest = audioCtx.createMediaStreamDestination();
  source.connect(dest);
  
  stream.addTrack(dest.stream.getAudioTracks()[0]);

  return new Promise((resolve, reject) => {
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
    recorder.onerror = reject;
    
    recorder.start();
    source.start(0);
    
    // Stop recording once audio finishes
    source.onended = () => {
      recorder.stop();
      audioCtx.close();
    };
  });
}

// --- IndexedDB Persistence ---

const DB_NAME = 'IvanchatDB';
const STORE_NAME = 'audioCache';

export async function saveAudioToDB(id: string, blob: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function getAudioFromDB(id: string): Promise<Blob | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(id);
      getReq.onsuccess = () => resolve(getReq.result || null);
      getReq.onerror = () => reject(getReq.error);
    };
    request.onerror = () => reject(request.error);
  });
}