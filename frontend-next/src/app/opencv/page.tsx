"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Loader2, Play, RefreshCcw, Square, Wifi, WifiOff } from "lucide-react";

type StreamMessage = {
  x: number;
  y: number;
  confidence: number;
  gesture: string;
  frame?: string;
  score?: number;
  missed?: number;
  maxMisses?: number;
  gameOver?: boolean;
  feedback?: string;
};

// const RAW_WS_URL =
//   process.env.NEXT_PUBLIC_OPENCV_WS_URL || "wss://aavishkar-26-production.up.railway.app";
// const WS_URL = RAW_WS_URL.includes("://") ? RAW_WS_URL : `wss://${RAW_WS_URL}`;

const WS_URL = "ws://localhost:8765";
const IS_LOCAL_WS = /^ws:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(WS_URL);

export default function OpenCvPage() {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldReconnectRef = useRef(true);
  const [frame, setFrame] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [stream, setStream] = useState<StreamMessage>({
    x: 0.5,
    y: 0.5,
    confidence: 0,
    gesture: "none",
    score: 0,
    missed: 0,
    maxMisses: 5,
    gameOver: false,
  });

  const connectSocket = useCallback(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    const socket = new WebSocket(WS_URL);
    socketRef.current = socket;

    socket.onopen = () => {
      setIsConnected(true);
      setError(null);
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as StreamMessage;
        setStream(message);
        if (message.frame) {
          setFrame(message.frame);
        }
      } catch {
        setError("OpenCV stream sent an invalid message.");
      }
    };

    socket.onerror = () => {
      setError(`Waiting for the OpenCV backend on ${WS_URL}.`);
      setIsConnected(false);
    };

    socket.onclose = () => {
      setIsConnected(false);
      if (shouldReconnectRef.current) {
        reconnectTimerRef.current = setTimeout(connectSocket, 1500);
      }
    };
  }, []);

  const startBackend = useCallback(async () => {
    shouldReconnectRef.current = true;
    setHasStarted(true);
    setIsStarting(true);
    setError(null);

    try {
      if (!IS_LOCAL_WS) {
        setLogs([`Connecting to hosted OpenCV backend at ${WS_URL}`]);
        connectSocket();
        return;
      }

      const response = await fetch("/api/opencv/start", { method: "POST" });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || "Could not start the local OpenCV backend.");
      }

      setLogs(data.logs ?? []);
      connectSocket();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setHasStarted(false);
      setError(message);
    } finally {
      setIsStarting(false);
    }
  }, [connectSocket]);

  const stopBackend = useCallback(async () => {
    shouldReconnectRef.current = false;
    setIsStopping(true);
    setError(null);
    setHasStarted(false);

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    socketRef.current?.close();
    socketRef.current = null;
    setIsConnected(false);
    setFrame("");

    try {
      if (!IS_LOCAL_WS) {
        setLogs([`Disconnected from hosted OpenCV backend at ${WS_URL}`]);
        return;
      }

      const response = await fetch("/api/opencv/stop", { method: "POST" });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || "Could not stop the OpenCV backend.");
      }

      setLogs(data.logs ?? []);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setIsStopping(false);
    }
  }, []);

  const resetGame = useCallback(() => {
    socketRef.current?.send(JSON.stringify({ type: "reset" }));
  }, []);

  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      socketRef.current?.close();
    };
  }, []);

  const isLive = isConnected;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-3 md:px-8 md:py-4">
        <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-cyan-700 dark:text-cyan-100">
              <Camera size={14} />
              OPENCV Integrated Web
            </div>
            <h1 className="text-3xl font-black tracking-normal md:text-5xl">
              Gesture Slice Trainer
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground md:text-base">
              The Python OpenCV backend captures the webcam, detects the index finger with MediaPipe, and streams the live game frame into this Next.js page for dyslexia-friendly gesture practice.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={startBackend}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-bold text-foreground transition hover:bg-accent"
              type="button"
            >
              {isStarting ? <Loader2 className="animate-spin" size={16} /> : <Play size={16} />}
              Start
            </button>
            {isLive && (
              <button
                onClick={stopBackend}
                className="inline-flex items-center gap-2 rounded-lg border border-red-500/35 bg-red-500/10 px-4 py-2 text-sm font-bold text-red-700 transition hover:bg-red-500/20 dark:text-red-100"
                type="button"
              >
                {isStopping ? <Loader2 className="animate-spin" size={16} /> : <Square size={16} />}
                Stop
              </button>
            )}
            <button
              onClick={resetGame}
              className="inline-flex items-center gap-2 rounded-lg bg-yellow-300 px-4 py-2 text-sm font-black text-slate-950 transition hover:bg-yellow-200"
              type="button"
            >
              <RefreshCcw size={16} />
              Restart
            </button>
          </div>
        </header>

        <section className="grid gap-3 lg:grid-cols-[1fr_280px]">
          <div className="overflow-hidden rounded-lg border border-cyan-500/25 bg-black shadow-2xl shadow-cyan-950/20 dark:shadow-cyan-950/40">
            <div className="flex items-center justify-between border-b border-border bg-card px-4 py-3">
              <div className="inline-flex items-center gap-2 text-sm font-bold">
                {isConnected ? (
                  <Wifi className="text-emerald-600 dark:text-emerald-300" size={16} />
                ) : (
                  <WifiOff className="text-red-600 dark:text-red-300" size={16} />
                )}
                {isConnected ? "Live OpenCV stream" : hasStarted ? "Connecting to OpenCV stream" : "OpenCV stream stopped"}
              </div>
              <span className="text-xs text-muted-foreground">{WS_URL}</span>
            </div>

            <div className="relative aspect-[4/3] w-full bg-slate-950">
              {frame ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={frame}
                  alt="Live OpenCV gesture game camera stream"
                  className="h-full w-full object-contain"
                />
              ) : hasStarted ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-300">
                  <Loader2 className="animate-spin text-cyan-200" size={34} />
                  <span className="text-sm font-semibold">
                    Starting camera and loading the OpenCV game...
                  </span>
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-300">
                  <Camera className="text-cyan-200" size={34} />
                  <span className="text-sm font-semibold">
                    Click Start to switch on the camera and begin.
                  </span>
                </div>
              )}
            </div>
          </div>

          <aside className="flex flex-col gap-4">
            <div className="rounded-lg border border-border bg-card p-4">
              <h2 className="mb-3 text-sm font-black uppercase tracking-wide text-muted-foreground">
                Game Status
              </h2>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg bg-muted p-3">
                  <dt className="text-muted-foreground">Score</dt>
                  <dd className="text-2xl font-black text-emerald-600 dark:text-emerald-300">{stream.score ?? 0}</dd>
                </div>
                <div className="rounded-lg bg-muted p-3">
                  <dt className="text-muted-foreground">Misses</dt>
                  <dd className="text-2xl font-black text-red-600 dark:text-red-300">
                    {stream.missed ?? 0}/{stream.maxMisses ?? 5}
                  </dd>
                </div>
                <div className="rounded-lg bg-muted p-3">
                  <dt className="text-muted-foreground">Hand</dt>
                  <dd className="text-lg font-black text-cyan-700 dark:text-cyan-200">
                    {stream.confidence > 0.2 ? "Detected" : "Searching"}
                  </dd>
                </div>
                <div className="rounded-lg bg-muted p-3">
                  <dt className="text-muted-foreground">State</dt>
                  <dd className="text-lg font-black text-amber-700 dark:text-yellow-200">
                    {isLive ? (stream.gameOver ? "Game Over" : "Running") : "Stopped"}
                  </dd>
                </div>
              </dl>
            </div>

            {/* <div className="rounded-lg border border-border bg-card p-4">
              <h2 className="mb-2 text-sm font-black uppercase tracking-wide text-muted-foreground">
                Debug
              </h2>
              {error ? (
                <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-100">
                  {error}
                </p>
              ) : !hasStarted ? (
                <p className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 p-3 text-sm text-cyan-700 dark:text-cyan-100">
                  Camera is off. Press Start to launch the OpenCV backend.
                </p>
              ) : (
                <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-100">
                  Backend started. Camera frames will appear when Python has webcam access.
                </p>
              )}
              {logs.length > 0 && (
                <pre className="mt-3 max-h-44 overflow-auto rounded-lg bg-muted p-3 text-xs text-muted-foreground">
                  {logs.join("\n")}
                </pre>
              )}
            </div> */}
          </aside>
        </section>
      </div>
    </main>
  );
}
