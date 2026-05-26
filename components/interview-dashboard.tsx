'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import type { MetricConfig, ScoringMetricsPayload } from '@/lib/types';

type InterviewTurnView = {
  id: string;
  turnSequence: number;
  aiQuestion: string;
  userAnswer: string | null;
  originalAnswer?: string | null;
};

function getLevenshteinDistanceLocal(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prevRow = Array.from({ length: b.length + 1 }, (_, i) => i);
  let currentRow = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    currentRow[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const insert = prevRow[j] + 1;
      const deleteCost = currentRow[j - 1] + 1;
      const substitute = prevRow[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      currentRow[j] = Math.min(insert, deleteCost, substitute);
    }
    prevRow = [...currentRow];
  }
  return prevRow[b.length];
}

function getHeuristicStatus(userAnswer: string | null, originalAnswer?: string | null) {
  if (!userAnswer || !originalAnswer) return null;

  const cleanMetadata = (text: string) => {
    return text.replace(/^\[Silence:.*?\]/i, '').trim();
  };

  const cleanUser = cleanMetadata(userAnswer);
  const cleanOrig = cleanMetadata(originalAnswer);

  if (!cleanOrig || !cleanUser) return null;
  if (cleanUser === cleanOrig) return null;

  const distance = getLevenshteinDistanceLocal(cleanOrig.toLowerCase().replace(/[^a-z0-9]/g, ''), cleanUser.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const maxLength = Math.max(cleanOrig.toLowerCase().replace(/[^a-z0-9]/g, '').length, cleanUser.toLowerCase().replace(/[^a-z0-9]/g, '').length);
  const similarity = maxLength > 0 ? 1.0 - distance / maxLength : 1.0;

  if (similarity < 0.75) {
    return { type: 'rewrite', similarity };
  } else {
    return { type: 'spelling', similarity };
  }
}

function getTurnTheme(turnSequence: number): string {
  switch (turnSequence) {
    case 1: return 'Problem Selection & Motivation';
    case 2: return 'Tech Stack Justification';
    case 3: return 'Progress & Architectural Approach';
    case 4: return 'Code & Role Evaluation (Commit details)';
    case 5: return 'Secondary Code Evaluation (Commit details)';
    case 6: return 'Wrong-Answer Probing Defense';
    case 7: return 'Technical Blockers & Debugging';
    case 8: return 'Future Scope & Production Scaling';
    default: return 'Hackathon Evaluation';
  }
}

const defaultMetrics: MetricConfig[] = [
  {
    name: 'Problem Clarity',
    weight: 20,
    description: 'Do they understand the problem statement deeply?'
  },
  {
    name: 'Solution Ownership',
    weight: 25,
    description: 'Can they defend their architectural choices?'
  },
  {
    name: 'Code Comprehension',
    weight: 40,
    description: 'Can they explain specific code blocks?'
  },
  {
    name: 'Communication',
    weight: 15,
    description: 'Clarity and confidence'
  }
];

function totalWeight(metrics: MetricConfig[]): number {
  return metrics.reduce((sum, metric) => sum + Number(metric.weight || 0), 0);
}

function normalizeWeights(metrics: MetricConfig[]): MetricConfig[] {
  if (!metrics.length) {
    return metrics;
  }

  const total = totalWeight(metrics);

  if (total <= 0) {
    const baseWeight = Math.floor(100 / metrics.length);
    let remainder = 100 - baseWeight * metrics.length;

    return metrics.map((metric, index) => ({
      ...metric,
      weight: baseWeight + (index < remainder ? 1 : 0)
    }));
  }

  const scaled = metrics.slice(0, -1).map((metric) => Math.floor((metric.weight / total) * 100));
  const assigned = scaled.reduce((sum, weight) => sum + weight, 0);

  return metrics.map((metric, index) => {
    if (index === metrics.length - 1) {
      return {
        ...metric,
        weight: 100 - assigned
      };
    }

    return {
      ...metric,
      weight: scaled[index]
    };
  });
}

function formatSummaryWeight(value: number): string {
  return `${value}%`;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Helper to parse userAnswer metadata (waveform silence/pauses and tab switching)
function parseAnswer(answerText: string | null) {
  if (!answerText) return { cleanText: 'No answer recorded yet.', silence: null, cheat: null };
  const match = answerText.match(/^\[Silence:\s*([\d.]+)s,\s*Pauses:\s*(\d+),\s*Max\s*Pause:\s*([\d.]+)s(?:,\s*TabSwitches:\s*(\d+),\s*TabAway:\s*([\d.]+)s)?\]\s*([\s\S]*)/i);
  if (match) {
    const totalSilence = match[1];
    const pauses = match[2];
    const maxPause = match[3];
    const tabSwitches = match[4] || '0';
    const tabAway = match[5] || '0';
    const cleanText = match[6];

    return {
      silence: {
        total: totalSilence,
        pauses: pauses,
        max: maxPause
      },
      cheat: tabSwitches !== '0' ? {
        switches: tabSwitches,
        duration: tabAway
      } : null,
      cleanText
    };
  }
  return { cleanText: answerText, silence: null, cheat: null };
}

// ─── Audio Level Visualizer ──────────────────────────────────────────
function AudioLevelMeter({ stream }: { stream: MediaStream | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);

  useEffect(() => {
    if (!stream || !canvasRef.current) return;

    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    function draw() {
      if (!ctx || !canvas) return;
      animFrameRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 2.5;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * canvas.height;
        const hue = 30 + (dataArray[i] / 255) * 20; // warm amber range
        ctx.fillStyle = `hsla(${hue}, 100%, 65%, ${0.5 + (dataArray[i] / 255) * 0.5})`;
        ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
        x += barWidth + 1;
      }
    }

    draw();

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      audioCtx.close();
    };
  }, [stream]);

  return (
    <canvas
      ref={canvasRef}
      width={280}
      height={48}
      className="w-full rounded-xl"
      style={{ background: 'rgba(6,12,22,0.5)' }}
    />
  );
}

// ─── Main Dashboard ──────────────────────────────────────────────────
export default function InterviewDashboard() {
  const [userId, setUserId] = useState('candidate-001');
  const [fullName, setFullName] = useState('Candidate One');
  const [initialTopic, setInitialTopic] = useState('Senior frontend architecture');
  const [metrics, setMetrics] = useState<MetricConfig[]>(defaultMetrics);
  const [githubUsername, setGithubUsername] = useState('');
  const [githubRepo, setGithubRepo] = useState('');
  const [problemStatementPdf, setProblemStatementPdf] = useState<File | null>(null);
  const [interviewId, setInterviewId] = useState<string | null>(null);
  const [currentTurnId, setCurrentTurnId] = useState<string | null>(null);
  const [currentQuestion, setCurrentQuestion] = useState('');
  const [turns, setTurns] = useState<InterviewTurnView[]>([]);
  const [report, setReport] = useState<ScoringMetricsPayload | null>(null);
  const [reportTab, setReportTab] = useState<'overview' | 'metrics' | 'turns'>('overview');
  const [statusMessage, setStatusMessage] = useState('Ready to start.');
  const [errorMessage, setErrorMessage] = useState('');
  const [recognizedTranscript, setRecognizedTranscript] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [isPending, startTransition] = useTransition();
  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationTranscript, setVerificationTranscript] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const rawTranscriptRef = useRef('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcriptContainerRef = useRef<HTMLDivElement | null>(null);

  // Silence & pause waveform tracking refs
  const silenceAudioCtxRef = useRef<AudioContext | null>(null);
  const silenceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const silenceMetricsRef = useRef({
    totalSilenceDurationSec: 0,
    pauseCount: 0,
    longestPauseSec: 0
  });

  // Tab-switching & window focus anti-cheat tracking refs
  const tabSwitchesRef = useRef(0);
  const tabAwayDurationRef = useRef(0);
  const activeFocusLossRef = useRef(false);
  const lastLossTimeRef = useRef(0);
  const visibilityListenerRef = useRef<(() => void) | null>(null);
  const blurListenerRef = useRef<(() => void) | null>(null);
  const focusListenerRef = useRef<(() => void) | null>(null);

  const speechRef = useRef<SpeechSynthesisUtterance | null>(null);
  const beginRecordingRef = useRef<() => Promise<void>>(undefined);

  // Keep callback ref fresh to prevent stale state closures during auto-start
  useEffect(() => {
    beginRecordingRef.current = beginRecording;
  });

  // ─── TTS: Speak each new question aloud ─────────────────────────
  useEffect(() => {
    if (!currentQuestion || typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return;
    }

    window.speechSynthesis.cancel();
    const speech = new SpeechSynthesisUtterance(currentQuestion);
    speech.rate = 1.0;

    speech.onstart = () => {
      setIsSpeaking(true);
      setStatusMessage('AI is speaking the question...');
    };

    speech.onend = () => {
      setIsSpeaking(false);
      setStatusMessage('AI finished speaking. Recording starting automatically...');
      beginRecordingRef.current?.();
    };

    speech.onerror = (e) => {
      setIsSpeaking(false);
      console.error('TTS speech error:', e);
      // Fallback: start recording immediately if speech fails or is blocked
      beginRecordingRef.current?.();
    };

    speechRef.current = speech;
    window.speechSynthesis.speak(speech);

    return () => {
      window.speechSynthesis.cancel();
      speechRef.current = null;
    };
  }, [currentQuestion]);

  // ─── Cleanup on unmount ─────────────────────────────────────────
  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stop();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());

      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }

      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
      }

      if (silenceIntervalRef.current) {
        clearInterval(silenceIntervalRef.current);
      }

      if (silenceAudioCtxRef.current) {
        silenceAudioCtxRef.current.close().catch(() => { });
      }

      // Cleanup window focus loss listeners
      if (visibilityListenerRef.current) {
        document.removeEventListener('visibilitychange', visibilityListenerRef.current);
      }
      if (blurListenerRef.current) {
        window.removeEventListener('blur', blurListenerRef.current);
      }
      if (focusListenerRef.current) {
        window.removeEventListener('focus', focusListenerRef.current);
      }
    };
  }, []);

  // ─── Auto-scroll transcript locally without window jumping ─────────
  useEffect(() => {
    if (turns.length > 0 && transcriptContainerRef.current) {
      const container = transcriptContainerRef.current;
      container.scrollTo({
        top: container.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [turns.length]);

  const metricSum = totalWeight(metrics);
  const interviewActive = Boolean(interviewId);
  const interviewProgress = turns.length > 0 ? `${turns.length} turn${turns.length > 1 ? 's' : ''}` : 'No turns yet';

  const updateMetric = (index: number, patch: Partial<MetricConfig>) => {
    setMetrics((previous) => previous.map((metric, metricIndex) => (metricIndex === index ? { ...metric, ...patch } : metric)));
  };

  const addMetric = () => {
    setMetrics((previous) => [
      ...previous,
      {
        name: `Custom metric ${previous.length + 1}`,
        description: 'Explain the signal you want the Judge LLM to score.',
        weight: 0
      }
    ]);
  };

  const removeMetric = (index: number) => {
    setMetrics((previous) => {
      const next = previous.filter((_, metricIndex) => metricIndex !== index);
      return next.length ? next : defaultMetrics;
    });
  };

  const resetInterview = () => {
    setInterviewId(null);
    setCurrentTurnId(null);
    setCurrentQuestion('');
    setTurns([]);
    setReport(null);
    setRecognizedTranscript('');
    setErrorMessage('');
    setStatusMessage('Ready to start.');
    setIsRecording(false);
    setIsTranscribing(false);
    setIsSpeaking(false);
    setRecordingSeconds(0);
    setIsVerifying(false);
    setVerificationTranscript('');
    setIsSubmitting(false);
    rawTranscriptRef.current = '';

    mediaRecorderRef.current?.stop();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;

    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }

    if (silenceIntervalRef.current) {
      clearInterval(silenceIntervalRef.current);
      silenceIntervalRef.current = null;
    }

    if (silenceAudioCtxRef.current) {
      silenceAudioCtxRef.current.close().catch(() => { });
      silenceAudioCtxRef.current = null;
    }

    // Cleanup window focus loss listeners
    if (visibilityListenerRef.current) {
      document.removeEventListener('visibilitychange', visibilityListenerRef.current);
      visibilityListenerRef.current = null;
    }
    if (blurListenerRef.current) {
      window.removeEventListener('blur', blurListenerRef.current);
      blurListenerRef.current = null;
    }
    if (focusListenerRef.current) {
      window.removeEventListener('focus', focusListenerRef.current);
      focusListenerRef.current = null;
    }

    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  };

  // ─── Start Interview ────────────────────────────────────────────
  const startInterview = async () => {
    setErrorMessage('');

    if (!userId.trim() || !fullName.trim() || !initialTopic.trim()) {
      setErrorMessage('User, name, and hackathon project topic/idea are required.');
      return;
    }

    if (metricSum !== 100) {
      setErrorMessage('Metric weights must total 100 before starting.');
      return;
    }

    setStatusMessage('Starting hackathon evaluation...');

    try {
      let response;
      if (problemStatementPdf) {
        const formData = new FormData();
        formData.append('userId', userId.trim());
        formData.append('fullName', fullName.trim());
        formData.append('initialTopic', initialTopic.trim());
        formData.append('githubUsername', githubUsername.trim());
        formData.append('githubRepo', githubRepo.trim());
        formData.append('metrics', JSON.stringify(metrics));
        formData.append('problemStatementPdf', problemStatementPdf);

        response = await fetch('/api/interview/start', {
          method: 'POST',
          body: formData
        });
      } else {
        response = await fetch('/api/interview/start', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            userId: userId.trim(),
            fullName: fullName.trim(),
            initialTopic: initialTopic.trim(),
            githubUsername: githubUsername.trim(),
            githubRepo: githubRepo.trim(),
            metrics
          })
        });
      }

      const payload = (await response.json()) as {
        interviewId?: string;
        turnId?: string;
        aiQuestion?: string;
        error?: string;
      };

      if (!response.ok || !payload.interviewId || !payload.turnId || !payload.aiQuestion) {
        setErrorMessage(payload.error || 'Unable to start hackathon evaluation.');
        setStatusMessage('Ready to start.');
        return;
      }

      setInterviewId(payload.interviewId);
      setCurrentTurnId(payload.turnId);
      setCurrentQuestion(payload.aiQuestion);
      setTurns([
        {
          id: payload.turnId,
          turnSequence: 1,
          aiQuestion: payload.aiQuestion,
          userAnswer: null
        }
      ]);
      setReport(null);
      setRecognizedTranscript('');
      setStatusMessage('Evaluation started — listen to the opening question and record your answer.');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to start interview.');
      setStatusMessage('Ready to start.');
    }
  };

  // ─── Recording ──────────────────────────────────────────────────
  const beginRecording = async () => {
    setErrorMessage('');

    if (!interviewId || !currentTurnId) {
      setErrorMessage('Start an interview before recording.');
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMessage('Microphone capture is not available in this browser.');
      return;
    }

    try {
      const stream = mediaStreamRef.current ?? (await navigator.mediaDevices.getUserMedia({ audio: true }));
      mediaStreamRef.current = stream;
      audioChunksRef.current = [];
      setRecognizedTranscript('');
      setRecordingSeconds(0);

      // Reset client silence analytics
      silenceMetricsRef.current = {
        totalSilenceDurationSec: 0,
        pauseCount: 0,
        longestPauseSec: 0
      };

      // Reset tab-switching & focus anti-cheat tracking
      tabSwitchesRef.current = 0;
      tabAwayDurationRef.current = 0;
      activeFocusLossRef.current = false;
      lastLossTimeRef.current = 0;

      // ─── Real-time Focus/Tab Loss Anti-Cheat Tracking ──────────────
      const registerFocusLoss = () => {
        if (!activeFocusLossRef.current) {
          activeFocusLossRef.current = true;
          tabSwitchesRef.current++;
          lastLossTimeRef.current = Date.now();
        }
      };

      const registerFocusGain = () => {
        if (activeFocusLossRef.current) {
          activeFocusLossRef.current = false;
          if (lastLossTimeRef.current > 0) {
            const awayDuration = (Date.now() - lastLossTimeRef.current) / 1000;
            tabAwayDurationRef.current += awayDuration;
          }
          lastLossTimeRef.current = 0;
        }
      };

      const handleVisibilityChange = () => {
        if (document.visibilityState === 'hidden') {
          registerFocusLoss();
        } else {
          registerFocusGain();
        }
      };

      const handleBlur = () => {
        registerFocusLoss();
      };

      const handleFocus = () => {
        registerFocusGain();
      };

      // Store in refs for cleanup
      visibilityListenerRef.current = handleVisibilityChange;
      blurListenerRef.current = handleBlur;
      focusListenerRef.current = handleFocus;

      document.addEventListener('visibilitychange', handleVisibilityChange);
      window.addEventListener('blur', handleBlur);
      window.addEventListener('focus', handleFocus);

      // ─── Real-time Silence & Hesitation Tracking ──────────────────
      try {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioContextClass) {
          const audioCtx = new AudioContextClass();
          silenceAudioCtxRef.current = audioCtx;
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);

          const bufferLength = analyser.frequencyBinCount;
          const dataArray = new Uint8Array(bufferLength);
          const silenceThreshold = 12; // volume threshold for silence
          const sampleIntervalMs = 100;
          let totalSilenceMs = 0;
          let currentSilenceStreakMs = 0;
          let pauseCount = 0;
          let longestPauseMs = 0;

          silenceIntervalRef.current = setInterval(() => {
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < bufferLength; i++) {
              sum += dataArray[i];
            }
            const avgVolume = sum / bufferLength;

            if (avgVolume < silenceThreshold) {
              totalSilenceMs += sampleIntervalMs;
              currentSilenceStreakMs += sampleIntervalMs;

              if (currentSilenceStreakMs === 1000) {
                pauseCount++;
              }
              if (currentSilenceStreakMs > longestPauseMs) {
                longestPauseMs = currentSilenceStreakMs;
              }
            } else {
              currentSilenceStreakMs = 0;
            }

            silenceMetricsRef.current = {
              totalSilenceDurationSec: Number((totalSilenceMs / 1000).toFixed(1)),
              pauseCount,
              longestPauseSec: Number((longestPauseMs / 1000).toFixed(1))
            };
          }, sampleIntervalMs);
        }
      } catch (err) {
        console.error('Error starting silence tracking:', err);
      }

      // Start recording timer
      recordingTimerRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);

      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        // Stop the timer
        if (recordingTimerRef.current) {
          clearInterval(recordingTimerRef.current);
          recordingTimerRef.current = null;
        }

        // Stop silence tracking loop
        if (silenceIntervalRef.current) {
          clearInterval(silenceIntervalRef.current);
          silenceIntervalRef.current = null;
        }
        if (silenceAudioCtxRef.current) {
          silenceAudioCtxRef.current.close().catch(() => { });
          silenceAudioCtxRef.current = null;
        }

        // Cleanup focus loss tracking listeners
        if (visibilityListenerRef.current) {
          document.removeEventListener('visibilitychange', visibilityListenerRef.current);
          visibilityListenerRef.current = null;
        }
        if (blurListenerRef.current) {
          window.removeEventListener('blur', blurListenerRef.current);
          blurListenerRef.current = null;
        }
        if (focusListenerRef.current) {
          window.removeEventListener('focus', focusListenerRef.current);
          focusListenerRef.current = null;
        }

        // Finalize focus loss tracking
        if (activeFocusLossRef.current && lastLossTimeRef.current > 0) {
          const awayDuration = (Date.now() - lastLossTimeRef.current) / 1000;
          tabAwayDurationRef.current += awayDuration;
          activeFocusLossRef.current = false;
          lastLossTimeRef.current = 0;
        }

        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });

        if (!audioBlob.size) {
          setStatusMessage('Recording stopped, but no audio was captured.');
          return;
        }

        setIsTranscribing(true);
        setStatusMessage('Sending audio to Whisper for transcription...');

        const formData = new FormData();
        formData.append('audio', audioBlob, 'answer.webm');
        formData.append('interviewId', interviewId);
        formData.append('currentTurnId', currentTurnId);

        // Append physically tracked waveform hesitation metrics
        formData.append('totalSilence', String(silenceMetricsRef.current.totalSilenceDurationSec));
        formData.append('pauses', String(silenceMetricsRef.current.pauseCount));
        formData.append('longestPause', String(silenceMetricsRef.current.longestPauseSec));

        // Append tab switching focus metrics
        formData.append('tabSwitches', String(tabSwitchesRef.current));
        formData.append('tabAwayDuration', String(Number(tabAwayDurationRef.current.toFixed(1))));

        try {
          const response = await fetch('/api/interview/turn', {
            method: 'POST',
            body: formData
          });

          const payload = (await response.json()) as {
            nextTurnId?: string;
            aiQuestion?: string;
            transcribedUserAnswer?: string;
            error?: string;
          };

          if (!response.ok || !payload.transcribedUserAnswer) {
            setErrorMessage(payload.error || 'Unable to transcribe your answer.');
            setStatusMessage('Waiting for microphone input.');
            setIsTranscribing(false);
            return;
          }

          // Show the server transcription result in the preview
          setRecognizedTranscript(payload.transcribedUserAnswer || '');
          rawTranscriptRef.current = payload.transcribedUserAnswer || '';

          // Parse and populate the verification fields
          const parsed = parseAnswer(payload.transcribedUserAnswer);
          setVerificationTranscript(parsed.cleanText || '');
          setIsVerifying(true);
          setStatusMessage('Answer transcribed. Review and edit before submitting.');
          setIsTranscribing(false);
        } catch (submissionError) {
          setErrorMessage(submissionError instanceof Error ? submissionError.message : 'Failed to submit audio.');
          setStatusMessage('Waiting for microphone input.');
          setIsTranscribing(false);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setStatusMessage('Recording — speak your answer...');
    } catch (recordingError) {
      setErrorMessage(recordingError instanceof Error ? recordingError.message : 'Unable to access the microphone.');
      setStatusMessage('Ready to start.');
    }
  };

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setStatusMessage('Stopping recording...');
    }

    // Clean up silence tracking
    if (silenceIntervalRef.current) {
      clearInterval(silenceIntervalRef.current);
      silenceIntervalRef.current = null;
    }
    if (silenceAudioCtxRef.current) {
      silenceAudioCtxRef.current.close().catch(() => { });
      silenceAudioCtxRef.current = null;
    }

    // Cleanup focus loss tracking listeners
    if (visibilityListenerRef.current) {
      document.removeEventListener('visibilitychange', visibilityListenerRef.current);
      visibilityListenerRef.current = null;
    }
    if (blurListenerRef.current) {
      window.removeEventListener('blur', blurListenerRef.current);
      blurListenerRef.current = null;
    }
    if (focusListenerRef.current) {
      window.removeEventListener('focus', focusListenerRef.current);
      focusListenerRef.current = null;
    }
  }, []);

  const submitFinalAnswer = async () => {
    setErrorMessage('');
    if (!interviewId || !currentTurnId) {
      setErrorMessage('Interview state is invalid.');
      return;
    }

    setIsSubmitting(true);
    setStatusMessage('Submitting final answer...');

    try {
      // Reconstruct the final answer by keeping the silence/focus metadata bracket
      const originalText = rawTranscriptRef.current || '';
      const metadataMatch = originalText.match(/^(\[Silence:\s*[\d.]+s,\s*Pauses:\s*\d+,\s*Max\s*Pause:\s*[\d.]+s(?:,\s*TabSwitches:\s*\d+,\s*TabAway:\s*[\d.]+s)?\])/i);
      const metadataPrefix = metadataMatch ? metadataMatch[1] : '';
      const finalAnswer = metadataPrefix ? `${metadataPrefix} ${verificationTranscript.trim()}` : verificationTranscript.trim();

      const response = await fetch('/api/interview/turn', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          interviewId,
          currentTurnId,
          userAnswer: finalAnswer,
          originalAnswer: originalText
        })
      });

      const payload = (await response.json()) as {
        nextTurnId?: string;
        aiQuestion?: string;
        completed?: boolean;
        error?: string;
      };

      if (!response.ok) {
        setErrorMessage(payload.error || 'Failed to submit the final answer.');
        setStatusMessage('Answer verification failed.');
        setIsSubmitting(false);
        return;
      }

      if (payload.completed) {
        setTurns((previous) => {
          if (!previous.length) {
            return previous;
          }

          const nextTurns = [...previous];
          nextTurns[nextTurns.length - 1] = {
            ...nextTurns[nextTurns.length - 1],
            userAnswer: finalAnswer,
            originalAnswer: originalText
          };

          return nextTurns;
        });

        setCurrentTurnId(null);
        setCurrentQuestion('');
        setIsVerifying(false);
        setVerificationTranscript('');
        rawTranscriptRef.current = '';
        setRecognizedTranscript('');
        setStatusMessage('Hackathon evaluation completed! You can now run the Recruiter report.');
        setIsSubmitting(false);
        return;
      }

      if (!payload.nextTurnId || !payload.aiQuestion) {
        setErrorMessage(payload.error || 'Failed to submit the final answer.');
        setStatusMessage('Answer verification failed.');
        setIsSubmitting(false);
        return;
      }

      // Update local turns history
      setTurns((previous) => {
        if (!previous.length) {
          return previous;
        }

        const nextTurns = [...previous];
        nextTurns[nextTurns.length - 1] = {
          ...nextTurns[nextTurns.length - 1],
          userAnswer: finalAnswer,
          originalAnswer: originalText
        };
        nextTurns.push({
          id: payload.nextTurnId!,
          turnSequence: nextTurns.length + 1,
          aiQuestion: payload.aiQuestion!,
          userAnswer: null
        });

        return nextTurns;
      });

      setCurrentTurnId(payload.nextTurnId!);
      setCurrentQuestion(payload.aiQuestion!);

      // Reset verification state
      setIsVerifying(false);
      setVerificationTranscript('');
      rawTranscriptRef.current = '';
      setRecognizedTranscript('');
      setStatusMessage('Answer submitted — next question loaded.');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'An error occurred during submission.');
      setStatusMessage('Submission error.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const discardAndReRecord = () => {
    setIsVerifying(false);
    setVerificationTranscript('');
    rawTranscriptRef.current = '';
    setRecognizedTranscript('');
    setStatusMessage('Review discarded. Ready to record again.');
  };

  // ─── Evaluate ───────────────────────────────────────────────────
  const evaluateInterview = () => {
    if (!interviewId) {
      setErrorMessage('Start an interview before evaluating it.');
      return;
    }

    setErrorMessage('');
    setStatusMessage('Running judge evaluation...');

    startTransition(async () => {
      try {
        const response = await fetch('/api/interview/evaluate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ interviewId })
        });

        const payload = (await response.json()) as {
          scoringMetrics?: ScoringMetricsPayload;
          error?: string;
        };

        if (!response.ok || !payload.scoringMetrics) {
          setErrorMessage(payload.error || 'Unable to evaluate the interview.');
          setStatusMessage('Evaluation failed.');
          return;
        }

        setReport(payload.scoringMetrics);
        setStatusMessage('Interview completed and evaluated.');
      } catch (evaluationError) {
        setErrorMessage(evaluationError instanceof Error ? evaluationError.message : 'Unable to evaluate the interview.');
        setStatusMessage('Evaluation failed.');
      }
    });
  };

  // ─── Render ─────────────────────────────────────────────────────
  return (
    <div className="subtle-grid min-h-screen px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        {/* ── Header ────────────────────────────────────────── */}
        <section className="glass-panel animate-fade-in overflow-hidden rounded-[2rem] px-6 py-6 sm:px-8">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.34em] text-amber-300/80">Virtual Hackathon Mock Evaluator</p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                Automatic code-commit evaluation with problem statement context.
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300 sm:text-base">
                Provide a GitHub repository, your candidate's username, and upload the hackathon's problem statement PDF. The AI conducts a highly tailored 8-turn technical evaluation of their commits and approach.
              </p>
            </div>

            <div className="grid gap-3 rounded-3xl border border-white/10 bg-white/5 p-4 text-sm text-slate-200 sm:min-w-[260px]">
              <div className="flex items-center justify-between gap-4">
                <span className="text-slate-400">Status</span>
                <span className="font-medium text-white">{statusMessage}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-slate-400">Weight total</span>
                <span className={metricSum === 100 ? 'font-semibold text-emerald-300' : 'font-semibold text-amber-300'}>
                  {formatSummaryWeight(metricSum)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-slate-400">Progress</span>
                <span className="font-medium text-white">{interviewProgress}</span>
              </div>
            </div>
          </div>

          {errorMessage ? (
            <div className="mt-5 animate-fade-in rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              {errorMessage}
            </div>
          ) : null}
        </section>

        <div className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
          {/* ── Setup Panel ─────────────────────────────────── */}
          <section className="glass-panel animate-fade-in rounded-[2rem] p-5 sm:p-6" style={{ animationDelay: '60ms' }}>
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-white">Hackathon setup</h2>
                <p className="mt-1 text-sm text-slate-400">Configure the candidate, topic, GitHub info, and problem statement before starting.</p>
              </div>
              <button type="button" className="button-secondary px-4 py-2 text-sm" onClick={() => setMetrics(normalizeWeights(metrics))}>
                Normalize weights
              </button>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <label className="grid gap-2 text-sm text-slate-200">
                User ID
                <input className="field px-4 py-3" value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="candidate-001" disabled={interviewActive} />
              </label>
              <label className="grid gap-2 text-sm text-slate-200">
                Full name
                <input className="field px-4 py-3" value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Candidate One" disabled={interviewActive} />
              </label>
              <label className="grid gap-2 text-sm text-slate-200">
                GitHub username
                <input className="field px-4 py-3" value={githubUsername} onChange={(event) => setGithubUsername(event.target.value)} placeholder="candidate-dev" disabled={interviewActive} />
              </label>
              <label className="grid gap-2 text-sm text-slate-200">
                GitHub repository URL
                <input className="field px-4 py-3" value={githubRepo} onChange={(event) => setGithubRepo(event.target.value)} placeholder="https://github.com/owner/repo" disabled={interviewActive} />
              </label>
              <label className="grid gap-2 text-sm text-slate-200 sm:col-span-2">
                Hackathon project topic / idea
                <input
                  className="field px-4 py-3"
                  value={initialTopic}
                  onChange={(event) => setInitialTopic(event.target.value)}
                  placeholder="Realtime dashboard, AI assistant, decentralized finance..."
                  disabled={interviewActive}
                />
              </label>
              <label className="grid gap-2 text-sm text-slate-200 sm:col-span-2">
                Problem statements PDF
                <div className="flex flex-wrap items-center gap-3 mt-1">
                  <input
                    type="file"
                    accept=".pdf"
                    onChange={(event) => {
                      const files = event.target.files;
                      if (files && files.length > 0) {
                        setProblemStatementPdf(files[0]);
                      }
                    }}
                    disabled={interviewActive}
                    className="field px-4 py-2 file:mr-4 file:py-1 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-white/10 file:text-white hover:file:bg-white/20"
                  />
                  {problemStatementPdf && (
                    <span className="text-xs text-emerald-300 font-semibold bg-emerald-500/10 border border-emerald-500/20 rounded-full px-3 py-1 animate-fade-in">
                      📄 {problemStatementPdf.name} ({Number(problemStatementPdf.size / 1024).toFixed(1)} KB)
                    </span>
                  )}
                </div>
              </label>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              {!interviewActive ? (
                <button type="button" className="button-primary px-5 py-3 text-sm" onClick={startInterview} disabled={isPending || metricSum !== 100}>
                  Start interview
                </button>
              ) : (
                <button type="button" className="button-secondary px-5 py-3 text-sm" onClick={resetInterview}>
                  ↻ New interview
                </button>
              )}
              <button type="button" className="button-secondary px-5 py-3 text-sm" onClick={addMetric} disabled={interviewActive}>
                + Add metric
              </button>
              <button type="button" className="button-primary px-5 py-3 text-sm" onClick={evaluateInterview} disabled={isPending || !interviewId || turns.filter(t => t.userAnswer).length === 0}>
                Run evaluation
              </button>
            </div>

            <div className="mt-6 space-y-4">
              {metrics.map((metric, index) => (
                <article key={`${metric.name}-${index}`} className="rounded-3xl border border-white/10 bg-white/5 p-4 transition-all duration-200 hover:border-white/20">
                  <div className="flex items-start justify-between gap-4">
                    <div className="grid flex-1 gap-3">
                      <input
                        className="field px-4 py-3 text-base font-semibold"
                        value={metric.name}
                        onChange={(event) => updateMetric(index, { name: event.target.value })}
                        disabled={interviewActive}
                      />
                      <textarea
                        className="field min-h-[90px] px-4 py-3 text-sm leading-6"
                        value={metric.description}
                        onChange={(event) => updateMetric(index, { description: event.target.value })}
                        disabled={interviewActive}
                      />
                    </div>
                    <button type="button" className="button-secondary px-3 py-2 text-xs" onClick={() => removeMetric(index)} disabled={interviewActive}>
                      Remove
                    </button>
                  </div>

                  <div className="mt-4 grid gap-2">
                    <div className="flex items-center justify-between text-xs uppercase tracking-[0.24em] text-slate-400">
                      <span>Weight</span>
                      <span>{formatSummaryWeight(metric.weight)}</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={metric.weight}
                      onChange={(event) => updateMetric(index, { weight: Number(event.target.value) })}
                      disabled={interviewActive}
                      className="accent-amber-400"
                    />
                  </div>
                </article>
              ))}
            </div>
          </section>

          {/* ── Right Column ────────────────────────────────── */}
          <section className="grid gap-6">
            {/* ── Mic & TTS ──────────────────────────────── */}
            <article className="glass-panel animate-fade-in rounded-[2rem] p-5 sm:p-6" style={{ animationDelay: '120ms' }}>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-white">Mic and TTS</h2>
                  <p className="mt-1 text-sm text-slate-400">Use the browser microphone and native speech synthesis.</p>
                </div>
                <div className={`rounded-full border px-3 py-1 text-xs uppercase tracking-[0.3em] ${isRecording
                    ? 'recording-badge border-red-400/30 bg-red-500/20 text-red-200'
                    : isTranscribing
                      ? 'border-cyan-400/30 bg-cyan-500/20 text-cyan-200'
                      : isSpeaking
                        ? 'border-amber-400/30 bg-amber-500/20 text-amber-200'
                        : 'border-white/10 bg-white/5 text-slate-400'
                  }`}>
                  {isRecording ? '● Recording' : isTranscribing ? '⟳ Transcribing' : isSpeaking ? '🔊 Speaking' : 'Idle'}
                </div>
              </div>

              {isVerifying ? (
                <div className="mt-5 space-y-4 animate-fade-in">
                  <div className="rounded-3xl border border-amber-400/20 bg-amber-500/5 p-5">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold uppercase tracking-[0.24em] text-amber-300">Review & Edit Transcription</h3>
                      <span className="rounded-full bg-amber-400/10 border border-amber-400/30 px-3 py-1 text-[10px] font-semibold tracking-wider text-amber-200 uppercase">
                        Action Required
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-slate-300 leading-5">
                      Verify the text generated by Whisper. Correct any speech-to-text typos or grammatical errors.
                      <span className="text-amber-200"> Completely rewriting the answer to bypass the question will trigger anti-cheat metrics.</span>
                    </p>

                    <div className="mt-4">
                      <textarea
                        className="field min-h-[140px] w-full px-4 py-3 text-base leading-7 text-white focus:border-amber-400 focus:ring-1 focus:ring-amber-400 bg-black/45 rounded-2xl"
                        value={verificationTranscript}
                        onChange={(e) => setVerificationTranscript(e.target.value)}
                        placeholder="Type or correct your answer..."
                        disabled={isSubmitting}
                        onCopy={(e) => e.preventDefault()}
                        onPaste={(e) => {
                          e.preventDefault();
                          setErrorMessage('Copy, paste, and cut are disabled in the transcription review box to maintain interview integrity.');
                        }}
                        onCut={(e) => e.preventDefault()}
                      />
                    </div>

                    {(() => {
                      const parsed = parseAnswer(rawTranscriptRef.current);
                      return (
                        (parsed.silence || parsed.cheat) && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {parsed.silence && (
                              <>
                                <span className="inline-flex items-center gap-1 rounded-full bg-slate-900 border border-white/5 text-[10px] font-semibold text-slate-400 px-2.5 py-1">
                                  ⏳ Silence: {parsed.silence.total}s
                                </span>
                                <span className="inline-flex items-center gap-1 rounded-full bg-slate-900 border border-white/5 text-[10px] font-semibold text-slate-400 px-2.5 py-1">
                                  🛑 Pauses: {parsed.silence.pauses}
                                </span>
                                <span className="inline-flex items-center gap-1 rounded-full bg-slate-900 border border-white/5 text-[10px] font-semibold text-slate-400 px-2.5 py-1">
                                  ⏱ Max Pause: {parsed.silence.max}s
                                </span>
                              </>
                            )}
                            {parsed.cheat && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 border border-red-500/30 text-[10px] font-semibold text-red-200 px-2.5 py-1 animate-pulse">
                                ⚠️ Tab Switches: {parsed.cheat.switches} ({parsed.cheat.duration}s away)
                              </span>
                            )}
                          </div>
                        )
                      );
                    })()}
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      className="button-primary px-6 py-3 text-sm flex items-center gap-2 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white font-medium shadow-lg shadow-amber-500/15"
                      onClick={submitFinalAnswer}
                      disabled={isSubmitting || !verificationTranscript.trim()}
                    >
                      {isSubmitting ? (
                        <>
                          <span className="transcribing-spinner inline-block h-4 w-4 rounded-full border-2 border-white/40 border-t-white"></span>
                          Submitting...
                        </>
                      ) : (
                        '✓ Confirm & Submit Answer'
                      )}
                    </button>
                    <button
                      type="button"
                      className="button-secondary px-6 py-3 text-sm border-white/10 hover:bg-white/5 text-slate-300"
                      onClick={discardAndReRecord}
                      disabled={isSubmitting}
                    >
                      🗑 Discard & Re-record
                    </button>
                  </div>
                </div>
              ) : (interviewActive && !currentTurnId && turns.length > 0 && turns[turns.length - 1].userAnswer) ? (
                <div className="mt-5 space-y-4 animate-fade-in text-center p-6 border border-emerald-500/20 bg-emerald-500/5 rounded-3xl">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-400/10 border border-emerald-500/30 text-emerald-300">
                    <span className="text-xl font-bold">✓</span>
                  </div>
                  <h3 className="text-lg font-semibold text-white mt-3">Evaluation Completed Successfully!</h3>
                  <p className="text-sm text-slate-300 leading-relaxed max-w-md mx-auto">
                    Excellent work! The 8-turn dynamic technical mock evaluation is complete.
                    Your code-commits, architecture, wrong-answer probing responses, and stack justification are locked in.
                  </p>
                  <div className="mt-4">
                    <button
                      type="button"
                      className="button-primary px-6 py-3 text-sm bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 text-white font-medium shadow-lg shadow-emerald-500/15"
                      onClick={evaluateInterview}
                      disabled={isPending}
                    >
                      {isPending ? (
                        <>
                          <span className="transcribing-spinner inline-block h-4 w-4 rounded-full border-2 border-white/40 border-t-white mr-2"></span>
                          Running Judge...
                        </>
                      ) : (
                        '📊 Run Recruiter Judge Report'
                      )}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {/* Recording timer */}
                  {isRecording && (
                    <div className="mt-4 animate-fade-in">
                      <div className="flex items-center gap-3 rounded-2xl border border-red-400/15 bg-red-500/8 px-4 py-3">
                        <span className="recording-pulse inline-block h-3 w-3 rounded-full bg-red-400"></span>
                        <span className="font-mono text-lg font-semibold text-red-100">{formatTime(recordingSeconds)}</span>
                        <span className="text-sm text-red-200/80">recording</span>
                      </div>
                      <div className="mt-3">
                        <AudioLevelMeter stream={mediaStreamRef.current} />
                      </div>
                    </div>
                  )}

                  {/* Transcribing spinner */}
                  {isTranscribing && (
                    <div className="mt-4 animate-fade-in flex items-center gap-3 rounded-2xl border border-cyan-400/15 bg-cyan-500/8 px-4 py-3">
                      <span className="transcribing-spinner inline-block h-4 w-4 rounded-full border-2 border-cyan-400/40 border-t-cyan-300"></span>
                      <span className="text-sm text-cyan-100">Transcribing with Whisper…</span>
                    </div>
                  )}

                  <div className="mt-5 flex flex-wrap gap-3">
                    <button type="button" className="button-primary px-5 py-3 text-sm" onClick={beginRecording} disabled={isRecording || isTranscribing || isSpeaking || !interviewId}>
                      {isSpeaking ? '🎙 Auto-starting soon...' : '🎙 Start answer'}
                    </button>
                    <button type="button" className="button-secondary px-5 py-3 text-sm" onClick={stopRecording} disabled={!isRecording}>
                      ⏹ Stop and transcribe
                    </button>
                  </div>

                  <div className="mt-5 rounded-3xl border border-white/10 bg-slate-950/40 p-4 text-sm text-slate-300">
                    <div className="flex items-center justify-between text-xs uppercase tracking-[0.28em] text-slate-500">
                      <span>Current question</span>
                      <span>{currentTurnId ? `Turn ${turns.length} of 8` : 'Waiting'}</span>
                    </div>
                    {currentTurnId && (
                      <div className="mt-3 animate-fade-in">
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-[10px] font-semibold text-amber-200 px-3 py-1 uppercase tracking-wider">
                          🎯 Theme: {getTurnTheme(turns.length)}
                        </span>
                      </div>
                    )}
                    <p className="mt-3 text-base leading-7 text-white">{currentQuestion || 'Start the evaluation to generate the opening question.'}</p>
                  </div>

                  <div className="mt-4 rounded-3xl border border-white/10 bg-white/5 p-4 text-sm text-slate-300">
                    <div className="flex items-center justify-between text-xs uppercase tracking-[0.28em] text-slate-500">
                      <span>Last transcription</span>
                      <span>Server Whisper</span>
                    </div>
                    {(() => {
                      const parsed = parseAnswer(recognizedTranscript);
                      return (
                        <>
                          <p className="mt-3 min-h-10 text-white">
                            {parsed.cleanText || 'Your answer will be transcribed after you stop recording. Server transcription is the source of truth.'}
                          </p>
                          {(parsed.silence || parsed.cheat) && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {parsed.silence && (
                                <>
                                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-800 border border-slate-700/60 text-[10px] font-semibold text-slate-300 px-2 py-0.5">
                                    ⏳ Total Silence: {parsed.silence.total}s
                                  </span>
                                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-800 border border-slate-700/60 text-[10px] font-semibold text-slate-300 px-2 py-0.5">
                                    🛑 Pauses: {parsed.silence.pauses}
                                  </span>
                                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-800 border border-slate-700/60 text-[10px] font-semibold text-slate-300 px-2 py-0.5">
                                    ⏱ Max Pause: {parsed.silence.max}s
                                  </span>
                                </>
                              )}
                              {parsed.cheat && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 border border-red-500/30 text-[10px] font-semibold text-red-200 px-2 py-0.5 animate-pulse">
                                  ⚠️ Tab Switched: {parsed.cheat.switches} ({parsed.cheat.duration}s away)
                                </span>
                              )}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </>
              )}
            </article>

            {/* ── Rolling Transcript ─────────────────────── */}
            <article className="glass-panel animate-fade-in rounded-[2rem] p-5 sm:p-6" style={{ animationDelay: '180ms' }}>
              <h2 className="text-lg font-semibold text-white">Rolling transcript</h2>
              <div ref={transcriptContainerRef} className="mt-4 max-h-[520px] space-y-4 overflow-y-auto pr-1">
                {turns.length === 0 ? (
                  <div className="rounded-3xl border border-dashed border-white/15 bg-white/[0.04] px-4 py-6 text-sm text-slate-400">
                    Transcript will appear here after the first question is generated.
                  </div>
                ) : null}

                {turns.map((turn) => (
                  <div key={turn.id} className="animate-fade-in rounded-3xl border border-white/10 bg-white/5 p-4">
                    <div className="flex items-center justify-between text-xs uppercase tracking-[0.26em] text-slate-500">
                      <span>Turn {turn.turnSequence}</span>
                      <span className={turn.userAnswer ? 'text-emerald-300' : 'text-amber-300'}>{turn.userAnswer ? '✓ Answered' : '● Awaiting answer'}</span>
                    </div>
                    <div className="mt-3 space-y-3 text-sm leading-6">
                      <div>
                        <p className="text-xs uppercase tracking-[0.24em] text-amber-200/80">Question</p>
                        <p className="mt-1 text-slate-100">{turn.aiQuestion}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.24em] text-emerald-200/80">Answer</p>
                        {(() => {
                          const parsed = parseAnswer(turn.userAnswer);
                          const heuristicStatus = getHeuristicStatus(turn.userAnswer, turn.originalAnswer);
                          return (
                            <>
                              <p className="mt-1 text-slate-300">{parsed.cleanText}</p>
                              {heuristicStatus && (
                                <div className="mt-2">
                                  {heuristicStatus.type === 'spelling' ? (
                                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-[10px] font-semibold text-emerald-300 px-2 py-0.5">
                                      ✓ Spelling Corrected ({Math.round(heuristicStatus.similarity * 100)}% match)
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 border border-rose-500/30 text-[10px] font-semibold text-rose-300 px-2 py-0.5 animate-pulse">
                                      ⚠️ Alert: Full Answer Rewrite ({Math.round(heuristicStatus.similarity * 100)}% match)
                                    </span>
                                  )}
                                </div>
                              )}
                              {(parsed.silence || parsed.cheat) && (
                                <div className="mt-2 flex flex-wrap gap-2">
                                  {parsed.silence && (
                                    <>
                                      <span className="inline-flex items-center gap-1 rounded-full bg-slate-900 border border-white/5 text-[10px] font-semibold text-slate-400 px-2 py-0.5">
                                        ⏳ Total Silence: {parsed.silence.total}s
                                      </span>
                                      <span className="inline-flex items-center gap-1 rounded-full bg-slate-800 border border-slate-700/60 text-[10px] font-semibold text-slate-300 px-2 py-0.5">
                                        🛑 Pauses: {parsed.silence.pauses}
                                      </span>
                                      <span className="inline-flex items-center gap-1 rounded-full bg-slate-800 border border-slate-700/60 text-[10px] font-semibold text-slate-300 px-2 py-0.5">
                                        ⏱ Max Pause: {parsed.silence.max}s
                                      </span>
                                    </>
                                  )}
                                  {parsed.cheat && (
                                    <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 border border-red-500/30 text-[10px] font-semibold text-red-200 px-2 py-0.5 animate-pulse">
                                      ⚠️ Tab Switched: {parsed.cheat.switches} ({parsed.cheat.duration}s away)
                                    </span>
                                  )}
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  </div>
                ))}
                {/* End of transcript container reached */}
              </div>
            </article>

            {/* ── Judge Report ────────────────────────────── */}
            <article className="glass-panel animate-fade-in rounded-[2rem] p-5 sm:p-6" style={{ animationDelay: '240ms' }}>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-white/10 pb-5">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.28em] text-amber-300/80">Recruiter Analysis</p>
                  <h2 className="text-xl font-bold text-white mt-1">Judge report</h2>
                </div>
                {report && (
                  <span className="self-start sm:self-auto rounded-full bg-emerald-500/10 border border-emerald-500/30 px-3.5 py-1 text-xs font-bold tracking-wider text-emerald-300 uppercase animate-pulse">
                    ✓ Evaluated
                  </span>
                )}
              </div>

              {report ? (
                <div className="mt-6 space-y-6 animate-fade-in">

                  {/* Segmented Tab Navigation */}
                  <div className="flex justify-start">
                    <div className="flex gap-1.5 p-1.5 rounded-2xl bg-black/45 border border-white/5 w-full sm:w-auto">
                      <button
                        onClick={() => setReportTab('overview')}
                        className={`flex-1 sm:flex-initial px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold tracking-wide transition-all duration-250 flex items-center justify-center gap-2 ${reportTab === 'overview'
                            ? 'bg-gradient-to-r from-amber-400 to-amber-500 text-slate-950 font-bold shadow-md shadow-amber-400/15'
                            : 'text-slate-400 hover:text-white'
                          }`}
                      >
                        <span>📊</span> Overview
                      </button>
                      <button
                        onClick={() => setReportTab('metrics')}
                        className={`flex-1 sm:flex-initial px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold tracking-wide transition-all duration-250 flex items-center justify-center gap-2 ${reportTab === 'metrics'
                            ? 'bg-gradient-to-r from-amber-400 to-amber-500 text-slate-950 font-bold shadow-md shadow-amber-400/15'
                            : 'text-slate-400 hover:text-white'
                          }`}
                      >
                        <span>🎯</span> Competencies
                      </button>
                      <button
                        onClick={() => setReportTab('turns')}
                        className={`flex-1 sm:flex-initial px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold tracking-wide transition-all duration-250 flex items-center justify-center gap-2 ${reportTab === 'turns'
                            ? 'bg-gradient-to-r from-amber-400 to-amber-500 text-slate-950 font-bold shadow-md shadow-amber-400/15'
                            : 'text-slate-400 hover:text-white'
                          }`}
                      >
                        <span>💬</span> Per-Turn Scores
                      </button>
                    </div>
                  </div>

                  {/* ────────────────── OVERVIEW TAB ────────────────── */}
                  {reportTab === 'overview' && (
                    <div className="space-y-6 animate-fade-in">
                      <div className="grid gap-4 sm:grid-cols-2">
                        {/* Score Card */}
                        <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-slate-950/80 to-slate-900/60 p-6 flex flex-col justify-between">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Weighted Performance</span>
                            <span className="text-xs font-bold bg-amber-400/10 border border-amber-400/20 text-amber-300 rounded-full px-2.5 py-1">Score: {report.weightedScore.toFixed(2)}</span>
                          </div>
                          <div className="mt-4 flex items-baseline gap-2">
                            <span className="text-5xl font-extrabold tracking-tight text-white">{report.weightedPercentage.toFixed(1)}%</span>
                            <span className="text-xs text-slate-400">overall grade</span>
                          </div>
                          <div className="mt-5">
                            <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5 font-medium">
                              <span>Passing threshold</span>
                              <span>75%</span>
                            </div>
                            <div className="h-2.5 w-full rounded-full bg-slate-950 border border-white/5 overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all duration-700 ${report.weightedPercentage >= 75 ? 'bg-gradient-to-r from-emerald-500 to-emerald-400' : report.weightedPercentage >= 45 ? 'bg-gradient-to-r from-amber-500 to-amber-400' : 'bg-gradient-to-r from-rose-600 to-rose-500'
                                  }`}
                                style={{ width: `${report.weightedPercentage}%` }}
                              />
                            </div>
                          </div>
                        </div>

                        {/* Transcript Confidence Card */}
                        <div className="relative overflow-hidden rounded-3xl border border-cyan-500/20 bg-gradient-to-br from-cyan-950/20 to-slate-950 p-6 flex flex-col justify-between">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-200">Transcript Confidence</span>
                            <span className="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-[10px] font-semibold text-cyan-300 px-2 py-0.5 animate-pulse uppercase">
                              AI Verify
                            </span>
                          </div>
                          <div className="mt-4 flex items-baseline gap-2">
                            <span className="text-4xl font-extrabold tracking-tight text-cyan-300">{report.answerQualityCap.toFixed(1)}<span className="text-lg font-medium text-slate-500">/10</span></span>
                            <span className="text-xs text-slate-400">Integrity Factor</span>
                          </div>
                          <p className="mt-4 text-xs leading-5 text-slate-300">
                            Derived from relevance, specificity, completeness, fluency, and anti-cheat indicators like Levenshtein checks.
                          </p>
                        </div>
                      </div>

                      {/* Summary Block */}
                      <div className="rounded-3xl border border-white/10 bg-slate-950/40 p-6 space-y-5">
                        <div>
                          <h3 className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500 flex items-center gap-2">
                            <span>📋</span> Overall Assessment
                          </h3>
                          <p className="mt-3 text-base leading-7 text-slate-200 italic border-l-2 border-amber-400/40 pl-4 py-0.5">
                            "{report.summary}"
                          </p>
                        </div>

                        <div className="grid gap-5 sm:grid-cols-2 pt-4 border-t border-white/5">
                          <div className="space-y-3">
                            <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-400 flex items-center gap-2">
                              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/10 text-xs font-bold">✓</span> Key Strengths
                            </h4>
                            <ul className="space-y-2 text-sm text-slate-300 pl-1">
                              {(report.strengths || []).map((item, index) => (
                                <li key={item + index} className="flex items-start gap-2.5">
                                  <span className="text-emerald-400 mt-1 text-xs">•</span>
                                  <span className="leading-6">{item}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                          <div className="space-y-3">
                            <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-400 flex items-center gap-2">
                              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-500/10 text-xs font-bold">!</span> Areas for Growth
                            </h4>
                            <ul className="space-y-2 text-sm text-slate-300 pl-1">
                              {(report.improvements || []).map((item, index) => (
                                <li key={item + index} className="flex items-start gap-2.5">
                                  <span className="text-amber-400 mt-1 text-xs">•</span>
                                  <span className="leading-6">{item}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      </div>

                      {/* Confidence Notes */}
                      <div className="rounded-3xl border border-white/10 bg-white/5 p-5">
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500 mb-3 flex items-center gap-2">
                          <span>🔍</span> Transcript confidence notes
                        </p>
                        <ul className="space-y-2 text-sm text-slate-300">
                          {report.qualitySignals.notes.map((note, index) => (
                            <li key={`${note}-${index}`} className="flex items-start gap-2">
                              <span className="text-slate-500">•</span>
                              <span className="leading-6">{note}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}

                  {/* ────────────────── COMPETENCIES TAB ────────────────── */}
                  {reportTab === 'metrics' && (
                    <div className="space-y-4 animate-fade-in">
                      {Object.entries(report.criteria).map(([metricName, metricResult]) => (
                        <div key={metricName} className="rounded-3xl border border-white/10 bg-slate-950/45 p-6 space-y-4">
                          <div className="flex items-center justify-between gap-4 border-b border-white/5 pb-3">
                            <div>
                              <h3 className="font-bold text-white text-lg">{metricName}</h3>
                              <p className="text-xs text-slate-400 mt-0.5">Competency Evaluation</p>
                            </div>
                            <span className="rounded-full border border-amber-400/20 bg-amber-400/10 px-3.5 py-1 text-sm font-extrabold text-amber-200 shadow-sm shadow-amber-400/5">
                              {metricResult.score.toFixed(1)} / 10
                            </span>
                          </div>

                          <p className="text-sm leading-7 text-slate-300">{metricResult.feedback}</p>

                          {report.metricBreakdowns?.[metricName] ? (
                            <div className="space-y-4 pt-3">
                              <div className="rounded-2xl border border-white/[0.08] bg-white/5 p-4 space-y-4">
                                <div>
                                  <div className="flex items-center justify-between text-xs uppercase tracking-[0.24em] text-slate-500">
                                    <span>Score Rationale</span>
                                    <span>Calculated: {report.metricBreakdowns[metricName].finalScore.toFixed(1)} / 10</span>
                                  </div>
                                  <p className="text-sm leading-6 text-slate-200 mt-2">{report.metricBreakdowns[metricName].rationale}</p>
                                </div>

                                <div className="grid gap-3 sm:grid-cols-2">
                                  {report.metricBreakdowns[metricName].components.map((component) => (
                                    <div key={component.name} className="flex flex-col justify-between rounded-xl bg-black/45 border border-white/5 p-3.5">
                                      <div className="flex items-start justify-between gap-3">
                                        <div>
                                          <div className="font-semibold text-white text-sm">{component.name}</div>
                                          <div className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">{component.note}</div>
                                        </div>
                                        <div className="font-extrabold text-amber-300 text-sm whitespace-nowrap">
                                          {component.value.toFixed(1)}<span className="text-[10px] text-slate-500 font-medium">/{component.max}</span>
                                        </div>
                                      </div>

                                      {/* Horizontal gauge for components */}
                                      <div className="mt-3.5 h-1.5 w-full rounded-full bg-slate-900 overflow-hidden">
                                        <div
                                          className="h-full rounded-full bg-amber-400 transition-all duration-500"
                                          style={{ width: `${(component.value / component.max) * 100}%` }}
                                        />
                                      </div>
                                    </div>
                                  ))}
                                </div>

                                <div className="space-y-2 pt-2">
                                  <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Documented Evidence</div>
                                  <ul className="space-y-2 text-sm text-slate-300">
                                    {report.metricBreakdowns[metricName].evidence.map((evidence, index) => (
                                      <li key={`${metricName}-evidence-${index}`} className="flex items-start gap-2">
                                        <span className="text-amber-400 mt-1 select-none">•</span>
                                        <span className="leading-6">{evidence}</span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* ────────────────── PER-TURN SCORES TAB ────────────────── */}
                  {reportTab === 'turns' && (
                    <div className="space-y-4 animate-fade-in relative pl-4 sm:pl-6 border-l border-white/10 ml-2 py-2">
                      {(report.perAnswerScores || []).map((turnScore) => {
                        const parsed = parseAnswer(turnScore.answer);
                        const isRewrite = turnScore.notes.some(n => n.includes('Full Answer Rewrite'));
                        const isSpelling = turnScore.notes.some(n => n.includes('Spelling Corrected'));

                        return (
                          <article key={`turn-score-${turnScore.turnSequence}`} className="relative rounded-3xl border border-white/10 bg-slate-950/35 p-5 hover:border-white/20 transition-all duration-200">

                            {/* Visual Timeline Marker Node */}
                            <span className="absolute -left-[25px] sm:-left-[33px] top-[26px] flex h-4 w-4 sm:h-5 sm:w-5 items-center justify-center rounded-full bg-slate-950 border-2 border-white/20">
                              <span className="h-1.5 w-1.5 sm:h-2 sm:w-2 rounded-full bg-amber-400"></span>
                            </span>

                            {/* Turn Header */}
                            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 pb-3">
                              <div className="flex items-center gap-3">
                                <span className="rounded-xl bg-white/5 border border-white/10 px-3 py-1 text-xs font-extrabold text-white">
                                  Turn {turnScore.turnSequence}
                                </span>
                                <span className="inline-flex items-center gap-1 bg-amber-500/10 border border-amber-500/30 text-[10px] font-semibold text-amber-200 px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                                  🎯 {getTurnTheme(turnScore.turnSequence)}
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-bold text-emerald-300">
                                  {turnScore.weightedPercentage.toFixed(1)}% weight
                                </span>
                                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-xs font-bold text-slate-200">
                                  quality {turnScore.turnQualityScore.toFixed(1)} / 10
                                </span>
                              </div>
                            </div>

                            {/* Chat-style Dialog Layout */}
                            <div className="mt-4 space-y-4">
                              {/* Question card */}
                              <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-4">
                                <div className="text-[10px] font-bold uppercase tracking-[0.24em] text-amber-300">AI Question</div>
                                <p className="mt-2 text-slate-100 text-sm sm:text-base leading-7">{turnScore.question}</p>
                              </div>

                              {/* Answer card */}
                              <div className="rounded-2xl border border-emerald-500/10 bg-emerald-500/5 p-4">
                                <div className="flex items-center justify-between">
                                  <span className="text-[10px] font-bold uppercase tracking-[0.24em] text-emerald-300">Candidate Response</span>

                                  {/* Anti-cheat alerts */}
                                  <div className="flex items-center gap-2">
                                    {isSpelling && (
                                      <span className="rounded-full bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-0.5 text-[9px] font-bold text-emerald-300 uppercase tracking-wide">
                                        ✓ Spelling Corrected
                                      </span>
                                    )}
                                    {isRewrite && (
                                      <span className="rounded-full bg-rose-500/10 border border-rose-500/30 px-2.5 py-0.5 text-[9px] font-bold text-rose-300 uppercase tracking-wide animate-pulse">
                                        ⚠️ Full Answer Rewrite
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <p className="mt-2 text-slate-200 text-sm sm:text-base leading-7">{parsed.cleanText}</p>
                              </div>
                            </div>

                            {/* Waveform, pauses & hesitation tracking */}
                            {(parsed.silence || parsed.cheat) && (
                              <div className="mt-4 flex flex-wrap gap-2 pt-3 border-t border-white/5">
                                {parsed.silence && (
                                  <>
                                    <span className="inline-flex items-center gap-1 rounded-full bg-slate-900 border border-white/5 text-[10px] font-semibold text-slate-400 px-2.5 py-1">
                                      ⏳ Total Silence: {parsed.silence.total}s
                                    </span>
                                    <span className="inline-flex items-center gap-1 rounded-full bg-slate-900 border border-white/5 text-[10px] font-semibold text-slate-400 px-2.5 py-1">
                                      🛑 Pauses: {parsed.silence.pauses}
                                    </span>
                                    <span className="inline-flex items-center gap-1 rounded-full bg-slate-900 border border-white/5 text-[10px] font-semibold text-slate-400 px-2.5 py-1">
                                      ⏱ Max Pause: {parsed.silence.max}s
                                    </span>
                                  </>
                                )}
                                {parsed.cheat && (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 border border-red-500/30 text-[10px] font-semibold text-red-200 px-2.5 py-1 animate-pulse">
                                    ⚠️ Tab Switched: {parsed.cheat.switches} ({parsed.cheat.duration}s away)
                                  </span>
                                )}
                              </div>
                            )}

                            {/* Competency score metrics for this specific turn */}
                            <div className="mt-4 grid gap-2 sm:grid-cols-2 pt-3 border-t border-white/5">
                              {Object.entries(turnScore.metricScores).map(([metricName, score]) => (
                                <div key={`${turnScore.turnSequence}-${metricName}`} className="flex items-center justify-between rounded-xl bg-black/35 border border-white/5 px-3 py-2.5 text-xs sm:text-sm">
                                  <span className="text-slate-400 font-medium">{metricName}</span>
                                  <span className="font-bold text-amber-300">{score.toFixed(1)} / 10</span>
                                </div>
                              ))}
                            </div>

                            {/* Turn feedback notes */}
                            {turnScore.notes.length > 0 && (
                              <div className="mt-4 pt-3 border-t border-white/5">
                                <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-slate-500 mb-2">Turn grading evidence</p>
                                <ul className="space-y-1.5 text-xs sm:text-sm text-slate-300">
                                  {turnScore.notes.map((note, index) => (
                                    <li key={`${turnScore.turnSequence}-note-${index}`} className="flex items-start gap-2">
                                      <span className="text-slate-500">•</span>
                                      <span className="leading-6">{note}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  )}

                </div>
              ) : (
                <p className="mt-4 text-sm leading-7 text-slate-400">Run the evaluation after completing the 8-turn interview to persist the recruiter judge output here.</p>
              )}
            </article>
          </section>
        </div>
      </div>
    </div>
  );
}