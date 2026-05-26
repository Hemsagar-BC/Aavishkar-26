"use client";

// Lecture page with live transcription and AI processing
// Side-by-side layout: Audio recorder on left, tabs on right
// 5 tabs: Live Transcription, Simple Text, Detailed Steps, Mind Map, Summary

import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import AudioRecorder from '@/components/lecture/AudioRecorder';

import { useTheme } from '@/context/ThemeContext';
import { useAuth } from '@/context/AuthContext';
import { Trash2, Volume2, VolumeX, Pause, Play } from 'lucide-react';
import useTextToSpeech from '@/hooks/useTextToSpeech';
import {
  createLecture,
  getLecture,
  getLatestLecture,
  processLecture,
  deleteLecture
} from '@/services/backendApi';
import { logLectureSession } from '@/services/progressService';

const PROCESS_TIMEOUT_MS = 120000;
const LOAD_TIMEOUT_MS = 15000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

export default function LecturePage() {
  const { isDark } = useTheme();
  const { currentUser } = useAuth();
  const { speak, pause, resume, stop, isSpeaking, isPaused, isSupported } = useTextToSpeech();
  const [activeTab, setActiveTab] = useState('live');
  const [currentLectureId, setCurrentLectureId] = useState(null);
  const [liveTranscription, setLiveTranscription] = useState('');
  const [breakdownText, setBreakdownText] = useState('');
  const [detailedSteps, setDetailedSteps] = useState('');
  const [mindMap, setMindMap] = useState('');
  const [summary, setSummary] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStage, setProcessingStage] = useState('');
  const [isLoadingLecture, setIsLoadingLecture] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [loadingBreakdown, setLoadingBreakdown] = useState(false);
  const [loadingSteps, setLoadingSteps] = useState(false);
  const [loadingMindMap, setLoadingMindMap] = useState(false);
  const [loadingSummary, setLoadingSummary] = useState(false);

  const tabs = [
    { id: 'live', label: 'Live Transcription', icon: '🎤️' },
    { id: 'breakdown', label: 'Breakdown Text', icon: '🔤' },
    { id: 'steps', label: 'Detailed Steps', icon: '📋' },
    { id: 'mindmap', label: 'Mind Map', icon: '🧠' },
    { id: 'summary', label: 'Summary', icon: '📄' }
  ];

  // TTS Button Component - for dyslexic users (slow speech)
  const TTSButton = ({ content }: { content: string }) => {
    if (!content || !isSupported) return null;

    const handleTTSClick = () => {
      if (isSpeaking) {
        if (isPaused) {
          resume();
        } else {
          pause();
        }
      } else {
        speak(content);
      }
    };

    const handleStop = () => {
      stop();
    };

    return (
      <div className="flex items-center gap-2 mb-4">
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={handleTTSClick}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg font-semibold transition-all ${isDark
            ? 'bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 border border-blue-500/50'
            : 'bg-blue-100 hover:bg-blue-200 text-blue-700 border border-blue-300'
            }`}
        >
          {isSpeaking ? (
            isPaused ? (
              <>
                <Play className="w-5 h-5" />
                Resume Reading
              </>
            ) : (
              <>
                <Pause className="w-5 h-5" />
                Pause Reading
              </>
            )
          ) : (
            <>
              <Volume2 className="w-5 h-5" />
              Read Aloud (Slow)
            </>
          )}
        </motion.button>
        {isSpeaking && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={handleStop}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-semibold transition-all ${isDark
              ? 'bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/50'
              : 'bg-red-100 hover:bg-red-200 text-red-700 border border-red-300'
              }`}
          >
            <VolumeX className="w-5 h-5" />
            Stop
          </motion.button>
        )}
      </div>
    );
  };

  // Load a specific lecture by ID or the latest lecture
  const loadLatestLecture = useCallback(async (lectureId = null) => {
    if (!currentUser) return;

    setIsLoadingLecture(true);
    try {
      let lecture;
      if (lectureId) {
        lecture = await getLecture(lectureId);
      } else {
        lecture = await getLatestLecture(currentUser.uid);
      }

      if (lecture) {
        setCurrentLectureId(lecture.id);
        setLiveTranscription(lecture.transcription || '');
        setBreakdownText(lecture.simpleText || '');
        setDetailedSteps(lecture.detailedSteps || '');
        setMindMap(lecture.mindMap || '');
        setSummary(lecture.summary || '');
      }
    } catch (error) {
      console.error('Error loading lecture:', error);
    } finally {
      setIsLoadingLecture(false);
    }
  }, [currentUser]);

  // Load lecture on component mount - check URL params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const lectureId = params.get('id');
    const autoProcess = params.get('autoProcess') === 'true';

    if (lectureId) {
      loadLatestLecture(lectureId).then(() => {
        // Auto-process if requested (from audio upload)
        if (autoProcess) {
          processTranscription(lectureId);
        }
      });
    } else {
      loadLatestLecture();
    }
  }, [loadLatestLecture]);

  // Handle live transcription updates
  const handleTranscriptionUpdate = (text: string) => {
    setLiveTranscription(text);
  };

  // Clear all data and start fresh
  const handleClearLecture = async () => {
    if (!currentLectureId) {
      // Just clear local state if no lecture ID
      setLiveTranscription('');
      setBreakdownText('');
      setDetailedSteps('');
      setMindMap('');
      setSummary('');
      return;
    }

    if (window.confirm('Are you sure you want to delete this lecture? This action cannot be undone.')) {
      try {
        await deleteLecture(currentLectureId);
        setCurrentLectureId(null);
        setLiveTranscription('');
        setBreakdownText('');
        setDetailedSteps('');
        setMindMap('');
        setSummary('');
        alert('Lecture deleted successfully!');
      } catch (error) {
        console.error('Error deleting lecture:', error);
        alert('Failed to delete lecture. Please try again.');
      }
    }
  };

  // Process transcription through backend API (memoized)
  const processTranscription = useCallback(async (lectureId: string) => {
    if (!lectureId) return;

    setIsProcessing(true);
    setLoadingBreakdown(true);
    setLoadingSteps(true);
    setLoadingMindMap(true);
    setLoadingSummary(true);

    try {
      setProcessingStage('Processing lecture through AI...');

      const result = await withTimeout(
        processLecture(lectureId),
        PROCESS_TIMEOUT_MS,
        'Processing timed out. Checking for saved results...'
      );

      if (result && (result.simpleText || result.detailedSteps || result.mindMap || result.summary)) {
        setBreakdownText(result.simpleText || '');
        setDetailedSteps(result.detailedSteps || '');
        setMindMap(result.mindMap || '');
        setSummary(result.summary || '');
        setProcessingStage('Processing complete!');
        return;
      }

      setProcessingStage('Checking for saved results...');
      const lecture = await withTimeout(
        getLecture(lectureId),
        LOAD_TIMEOUT_MS,
        'Unable to load processed results.'
      );

      if (lecture) {
        setBreakdownText(lecture.simpleText || '');
        setDetailedSteps(lecture.detailedSteps || '');
        setMindMap(lecture.mindMap || '');
        setSummary(lecture.summary || '');
        setProcessingStage('Processing complete!');
      } else {
        setProcessingStage('Processing complete, but no results were returned.');
      }
    } catch (error) {
      console.error('Error processing transcription:', error);
      const message = error instanceof Error ? error.message : 'Error processing. Please try again.';
      setProcessingStage(message);
    } finally {
      setLoadingBreakdown(false);
      setLoadingSteps(false);
      setLoadingMindMap(false);
      setLoadingSummary(false);
      setTimeout(() => {
        setIsProcessing(false);
        setProcessingStage('');
      }, 2000);
    }
  }, []);

  const handleProcessClick = useCallback(async () => {
    if (isRecording) {
      return;
    }

    const text = (liveTranscription || '').trim();
    if (!text) {
      setProcessingStage('No transcription available to process');
      setTimeout(() => setProcessingStage(''), 3000);
      return;
    }

    try {
      if (currentLectureId) {
        await processTranscription(currentLectureId);
        return;
      }

      setProcessingStage('Saving transcription...');
      const userId = currentUser?.uid || 'anonymous';
      const lectureId = await createLecture(userId, text);
      setCurrentLectureId(lectureId);
      await processTranscription(lectureId);
    } catch (error) {
      console.error('Error processing lecture:', error);
      setProcessingStage('Error processing. Please try again.');
      setTimeout(() => setProcessingStage(''), 3000);
    }
  }, [currentLectureId, currentUser, isRecording, liveTranscription, processTranscription]);

  // Handle recording complete - save to Firestore and auto-process
  const handleRecordingComplete = useCallback(async (audioBlob: Blob, transcription: string) => {
    if (!transcription || !transcription.trim()) {
      setProcessingStage('No speech detected. Please try speaking again.');
      setTimeout(() => setProcessingStage(''), 3000);
      return;
    }

    try {
      // Save transcription to Firestore
      setProcessingStage('Saving transcription...');
      const userId = currentUser?.uid || 'anonymous';
      const lectureId = await createLecture(userId, transcription);
      setCurrentLectureId(lectureId);

      // Track lecture creation in Firebase
      if (currentUser?.uid) {
        logLectureSession(currentUser.uid, { lectureId });
      }

      // Auto-trigger AI processing immediately after saving
      setProcessingStage('Processing with AI...');
      await processTranscription(lectureId);

    } catch (error) {
      console.error('Error saving or processing transcription:', error);
      alert('Failed to save transcription. Please try again.');
    }
  }, [currentUser, processTranscription]);

  const renderTabContent = () => {
    switch (activeTab) {
      case 'live':
        return (
          <div className="space-y-4">
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              Live transcription appears here as you speak...
            </p>
            <div className={`reading-content whitespace-pre-wrap ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {liveTranscription || 'Start recording to see live transcription...'}
            </div>
            {liveTranscription && !isRecording && (
              <button
                onClick={handleProcessClick}
                className={`mt-4 px-6 py-2 rounded-lg font-medium transition-all ${isDark
                  ? 'bg-blue-600 hover:bg-blue-700 text-white'
                  : 'bg-blue-500 hover:bg-blue-600 text-white'
                  }`}
                disabled={isProcessing}
              >
                {isProcessing ? 'Processing...' : 'Process with AI'}
              </button>
            )}
          </div>
        );

      case 'breakdown':
        return (
          <div className="space-y-4">
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              Text broken down into syllables for easier reading
            </p>
            <TTSButton content={breakdownText} />
            {loadingBreakdown ? (
              <div className="flex flex-col items-center justify-center py-12 space-y-4">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  Breaking down text into syllables...
                </p>
              </div>
            ) : (
              <div className={`reading-content whitespace-pre-wrap ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {breakdownText || 'Processing will begin after recording stops...'}
              </div>
            )}
          </div>
        );

      case 'steps':
        return (
          <div className="space-y-4">
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              Step-by-step breakdown
            </p>
            <TTSButton content={detailedSteps} />
            {loadingSteps ? (
              <div className="flex flex-col items-center justify-center py-12 space-y-4">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  Generating step-by-step breakdown...
                </p>
              </div>
            ) : (
              <div className={`reading-content whitespace-pre-wrap ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {detailedSteps || 'Detailed steps will appear here...'}
              </div>
            )}
          </div>
        );

      case 'mindmap':
        return (
          <div className="space-y-4">
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              Brief mind map with key points
            </p>
            <TTSButton content={mindMap} />
            {loadingMindMap ? (
              <div className="flex flex-col items-center justify-center py-12 space-y-4">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  Creating mind map...
                </p>
              </div>
            ) : (
              <div className={`reading-content whitespace-pre-wrap font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {mindMap || 'Mind map will be generated...'}
              </div>
            )}
          </div>
        );

      case 'summary':
        return (
          <div className="space-y-4">
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              Final NeuroLex summary
            </p>
            <TTSButton content={summary} />
            {loadingSummary ? (
              <div className="flex flex-col items-center justify-center py-12 space-y-4">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  Generating summary...
                </p>
              </div>
            ) : (
              <div className={`reading-content whitespace-pre-wrap ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {summary || 'Summary will be generated...'}
              </div>
            )}
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen">
      {/* Main Content */}
      <div className="px-3 sm:px-4 md:px-6 lg:px-8 py-6 md:py-8">
        <div className="w-full mx-auto max-w-7xl content-blur-card p-4 sm:p-6 md:p-8">
          {/* Header */}
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6 md:mb-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4"
          >
            <div>
              <h1 className={`text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-black mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                📚 New Lecture
              </h1>
              <p className={`text-base sm:text-lg ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                Record your lecture and get AI-powered transcription
              </p>
            </div>
            {/* Delete Button */}
            {(liveTranscription || breakdownText || detailedSteps || mindMap || summary) && (
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleClearLecture}
                className={`flex items-center gap-2 px-3 sm:px-4 py-2 md:py-3 rounded-lg font-semibold transition-all flex-shrink-0 touch-target ${isDark
                  ? 'bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/50'
                  : 'bg-red-100 hover:bg-red-200 text-red-700 border border-red-300'
                  }`}
              >
                <Trash2 className="w-4 sm:w-5 h-4 sm:h-5" />
                <span className="hidden sm:inline">Delete</span>
              </motion.button>
            )}
          </motion.div>

          {/* Processing Status */}
          {(isProcessing || processingStage) && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`mb-6 p-4 rounded-lg ${isDark ? 'bg-blue-500/20 border border-blue-500/50' : 'bg-blue-100 border border-blue-300'}`}
            >
              <div className="flex items-center gap-3">
                {isProcessing ? (
                  <div className="animate-spin w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full"></div>
                ) : (
                  <div className={`w-2.5 h-2.5 rounded-full ${isDark ? 'bg-blue-300' : 'bg-blue-600'}`}></div>
                )}
                <span className={isDark ? 'text-blue-200' : 'text-blue-900'}>{processingStage}</span>
              </div>
            </motion.div>
          )}

          {/* Side-by-Side Layout - Stack on mobile */}
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 md:gap-6">
            {/* Left: Audio Recorder - 1/4 width */}
            <motion.div
              initial={{ opacity: 0, x: -50 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 }}
              className="lg:col-span-1"
            >
              <AudioRecorder
                onRecordingComplete={handleRecordingComplete}
                onTranscriptionUpdate={handleTranscriptionUpdate}
                onRecordingStateChange={setIsRecording}
              />
            </motion.div>

            {/* Right: Tabs */}
            <motion.div
              initial={{ opacity: 0, x: 50 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.3 }}
              className={`backdrop-blur-md rounded-3xl shadow-2xl border-2 overflow-hidden lg:col-span-3 ${isDark
                ? 'bg-white/10 border-white/20'
                : 'bg-white/70 border-white/40'
                }`}
            >
              {/* Tab Headers */}
              <div className={`flex gap-0 overflow-x-auto scrollbar-hide border-b ${isDark ? 'border-white/20' : 'border-gray-300'}`}>
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex-shrink-0 min-w-max px-2 sm:px-3 md:px-4 py-3 md:py-4 text-xs sm:text-sm font-semibold transition-all whitespace-nowrap touch-target ${activeTab === tab.id
                      ? isDark
                        ? 'bg-white/20 text-white border-b-2 border-blue-400'
                        : 'bg-white/90 text-gray-900 border-b-2 border-blue-600'
                      : isDark
                        ? 'text-gray-300 hover:bg-white/10'
                        : 'text-gray-600 hover:bg-white/50'
                      }`}
                  >
                    <span className="mr-1">{tab.icon}</span>
                    <span className="hidden sm:inline">{tab.label}</span>
                  </button>
                ))}
              </div>

              {/* Tab Content */}
              <div className="p-3 sm:p-4 md:p-6 max-h-[500px] sm:max-h-[600px] overflow-y-auto">
                {renderTabContent()}
              </div>
            </motion.div>
          </div>
        </div>
      </div>
    </div>
  );
}
