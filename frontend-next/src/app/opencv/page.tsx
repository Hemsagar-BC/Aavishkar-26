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

type HandPoint = { x: number; y: number };

type HandSnapshot = {
  x: number;
  y: number;
  confidence: number;
  points?: HandPoint[];
};

type Fruit = {
  x: number;
  y: number;
  radius: number;
  speed: number;
  letter: string;
  sliced: boolean;
  type: "bomb" | "fruit";
};

type GameState = {
  score: number;
  missed: number;
  gameOver: boolean;
  feedback: string;
  feedbackTimer: number;
};

const CANVAS_WIDTH = 640;
const CANVAS_HEIGHT = 480;
const MAX_MISSES = 5;
const TOP_BAR_HEIGHT = 70;
const TOP_BAR_PADDING_X = 16;
const TOP_BAR_SCORE_Y = 44;
const FRUIT_LETTERS = ["A", "B", "C", "D", "E"];
const HAND_CONNECTIONS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17],
];
const FINGERTIPS = [4, 8, 12, 16, 20];

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const createInitialGameState = (): GameState => ({
  score: 0,
  missed: 0,
  gameOver: false,
  feedback: "",
  feedbackTimer: 0,
});

export default function OpenCvPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const handsRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);
  const rafRef = useRef<number | null>(null);
  const handLoopRef = useRef<number | null>(null);
  const handBusyRef = useRef(false);
  const runningRef = useRef(false);
  const lastSpawnRef = useRef(0);
  const lastUiUpdateRef = useRef(0);
  const lastHandRef = useRef<HandSnapshot>({ x: 0.5, y: 0.5, confidence: 0 });
  const fruitsRef = useRef<Fruit[]>([]);
  const trailRef = useRef<Array<{ x: number; y: number }>>([]);
  const gameRef = useRef<GameState>(createInitialGameState());

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
    maxMisses: MAX_MISSES,
    gameOver: false,
  });

  const resetGameState = useCallback(() => {
    gameRef.current = createInitialGameState();
    fruitsRef.current = [];
    trailRef.current = [];
    lastSpawnRef.current = performance.now();

    setStream((prev) => ({
      ...prev,
      score: 0,
      missed: 0,
      maxMisses: MAX_MISSES,
      gameOver: false,
      feedback: "",
    }));
  }, []);

  const cleanupMedia = useCallback(() => {
    runningRef.current = false;

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    if (handLoopRef.current !== null) {
      cancelAnimationFrame(handLoopRef.current);
      handLoopRef.current = null;
    }

    if (cameraRef.current?.stop) {
      cameraRef.current.stop();
      cameraRef.current = null;
    }

    if (handsRef.current?.close) {
      handsRef.current.close();
      handsRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const drawFrame = useCallback((now: number) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) {
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    if (video.readyState >= 2) {
      // Mirror the camera feed to match the on-screen hand orientation.
      ctx.save();
      ctx.translate(CANVAS_WIDTH, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      ctx.restore();
    } else {
      ctx.fillStyle = "#0b0b0f";
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }

    const hand = lastHandRef.current;
    const game = gameRef.current;
    const fruits = fruitsRef.current;

    if (game.missed >= MAX_MISSES) {
      game.gameOver = true;
    }

    if (!game.gameOver && now - lastSpawnRef.current > 1500) {
      const x = Math.floor(100 + Math.random() * (CANVAS_WIDTH - 200));
      const isBomb = Math.random() < 0.2;
      fruits.push({
        x,
        y: CANVAS_HEIGHT,
        radius: isBomb ? 40 : 35,
        speed: Math.floor(8 + Math.random() * 5),
        letter: isBomb ? "X" : FRUIT_LETTERS[Math.floor(Math.random() * FRUIT_LETTERS.length)],
        sliced: false,
        type: isBomb ? "bomb" : "fruit",
      });
      lastSpawnRef.current = now;
    }

    const cursor = hand.confidence > 0.2
      ? { x: hand.x * CANVAS_WIDTH, y: hand.y * CANVAS_HEIGHT }
      : null;

    if (cursor && !game.gameOver) {
      trailRef.current.push(cursor);
      if (trailRef.current.length > 15) {
        trailRef.current.shift();
      }
    } else {
      trailRef.current = [];
    }

    ctx.save();
    ctx.fillStyle = "rgba(30, 30, 30, 0.6)";
    ctx.fillRect(0, 0, CANVAS_WIDTH, TOP_BAR_HEIGHT);
    ctx.font = "bold 18px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = "#22c55e";
    ctx.fillText(`Score: ${game.score}`, TOP_BAR_PADDING_X, TOP_BAR_SCORE_Y);
    ctx.textAlign = "right";
    ctx.fillStyle = "#ef4444";
    ctx.fillText(
      `Misses: ${Math.min(game.missed, MAX_MISSES)}/${MAX_MISSES}`,
      CANVAS_WIDTH - TOP_BAR_PADDING_X,
      TOP_BAR_SCORE_Y,
    );
    ctx.restore();

    const removeIndices: number[] = [];
    fruits.forEach((fruit, index) => {
      if (fruit.sliced) {
        removeIndices.push(index);
        return;
      }

      fruit.y -= fruit.speed;
      fruit.speed -= 0.25;

      let color = fruit.type === "bomb" ? "#ef4444" : "#f97316";
      if (fruit.type === "bomb" && Math.floor(now / 200) % 2 === 0) {
        color = "#ffffff";
      }

      ctx.beginPath();
      ctx.arc(fruit.x, fruit.y, fruit.radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();

      ctx.font = "bold 30px system-ui, sans-serif";
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(fruit.letter, fruit.x, fruit.y + 2);

      if (fruit.y > CANVAS_HEIGHT + fruit.radius) {
        removeIndices.push(index);
        if (fruit.type === "fruit" && !game.gameOver) {
          game.missed = Math.min(game.missed + 1, MAX_MISSES);
        }
      }
    });

    for (let i = removeIndices.length - 1; i >= 0; i -= 1) {
      fruits.splice(removeIndices[i], 1);
    }

    if (cursor && !game.gameOver) {
      for (const fruit of fruits) {
        if (fruit.sliced) {
          continue;
        }
        const distance = Math.hypot(cursor.x - fruit.x, cursor.y - fruit.y);
        if (distance >= fruit.radius) {
          continue;
        }

        fruit.sliced = true;
        if (fruit.type === "bomb") {
          game.score -= 5;
          if (!game.gameOver) {
            game.missed = Math.min(game.missed + 1, MAX_MISSES);
          }
          game.feedback = "BOMB HIT!";
          game.feedbackTimer = 30;
        } else {
          game.score += 1;
          game.feedback = "GOOD!";
          game.feedbackTimer = 20;
        }
      }
    }

    if (trailRef.current.length > 1) {
      ctx.save();
      ctx.strokeStyle = "#facc15";
      ctx.lineWidth = 5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      trailRef.current.forEach((point, index) => {
        if (index === 0) {
          ctx.moveTo(point.x, point.y);
        } else {
          ctx.lineTo(point.x, point.y);
        }
      });
      ctx.stroke();
      ctx.restore();
    }

    if (cursor && !game.gameOver) {
      ctx.save();
      ctx.fillStyle = "#fde047";
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
      ctx.restore();
    }

    if (hand.points && hand.confidence > 0.1) {
      ctx.save();
      HAND_CONNECTIONS.forEach(([start, end]) => {
        const p1 = hand.points?.[start];
        const p2 = hand.points?.[end];
        if (!p1 || !p2) {
          return;
        }
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p1.x * CANVAS_WIDTH, p1.y * CANVAS_HEIGHT);
        ctx.lineTo(p2.x * CANVAS_WIDTH, p2.y * CANVAS_HEIGHT);
        ctx.stroke();
      });

      hand.points.forEach((point, index) => {
        ctx.beginPath();
        ctx.fillStyle = FINGERTIPS.includes(index) ? "#f472b6" : "#22c55e";
        ctx.arc(point.x * CANVAS_WIDTH, point.y * CANVAS_HEIGHT, 4, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();
    }

    if (game.feedbackTimer > 0) {
      ctx.save();
      ctx.font = "bold 32px system-ui, sans-serif";
      ctx.fillStyle = game.feedback.includes("BOMB") ? "#ef4444" : "#22c55e";
      ctx.textAlign = "center";
      ctx.fillText(game.feedback, CANVAS_WIDTH / 2, 120);
      ctx.restore();
      game.feedbackTimer -= 1;
      if (game.feedbackTimer <= 0) {
        game.feedback = "";
      }
    }

    if (game.gameOver) {
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(80, 120, 480, 240);
      ctx.fillStyle = "#ef4444";
      ctx.font = "bold 40px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("GAME OVER", CANVAS_WIDTH / 2, 210);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 24px system-ui, sans-serif";
      ctx.fillText(`Final Score: ${game.score}`, CANVAS_WIDTH / 2, 260);
      ctx.fillStyle = "#fde047";
      ctx.font = "bold 20px system-ui, sans-serif";
      ctx.fillText("Click Restart", CANVAS_WIDTH / 2, 310);
      ctx.restore();
    }

    if (now - lastUiUpdateRef.current > 120) {
      lastUiUpdateRef.current = now;
      setStream({
        x: hand.x,
        y: hand.y,
        confidence: hand.confidence,
        gesture: hand.confidence > 0.2 ? "pointing" : "none",
        score: game.score,
        missed: Math.min(game.missed, MAX_MISSES),
        maxMisses: MAX_MISSES,
        gameOver: game.gameOver,
        feedback: game.feedback,
      });
    }
  }, []);

  const renderLoop = useCallback(() => {
    if (!runningRef.current) {
      return;
    }
    const now = performance.now();
    drawFrame(now);
    rafRef.current = requestAnimationFrame(renderLoop);
  }, [drawFrame]);

  const handLoop = useCallback(() => {
    if (!runningRef.current) {
      return;
    }

    const video = videoRef.current;
    const hands = handsRef.current;

    if (video && hands && video.readyState >= 2 && !handBusyRef.current) {
      handBusyRef.current = true;
      hands.send({ image: video })
        .catch(() => {
          // Ignore per-frame errors; camera stays live.
        })
        .finally(() => {
          handBusyRef.current = false;
        });
    }

    handLoopRef.current = requestAnimationFrame(handLoop);
  }, []);

  const startBackend = useCallback(async () => {
    if (isStarting || isConnected) {
      return;
    }

    setHasStarted(true);
    setIsStarting(true);
    setError(null);
    resetGameState();

    try {
      const video = videoRef.current;
      if (!video) {
        throw new Error("Camera element not ready.");
      }

      video.playsInline = true;
      video.muted = true;

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT, facingMode: "user" },
      });
      mediaStreamRef.current = stream;
      video.srcObject = stream;
      await video.play();

      const handsModule = await import("@mediapipe/hands");

      const hands = new handsModule.Hands({
        locateFile: (file: string) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`,
      });

      hands.setOptions({
        selfieMode: true,
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.7,
        minTrackingConfidence: 0.7,
      });

      hands.onResults((results: any) => {
        const landmarks = results?.multiHandLandmarks?.[0];
        if (!landmarks || !landmarks[8]) {
          lastHandRef.current = {
            ...lastHandRef.current,
            confidence: 0,
            points: undefined,
          };
          return;
        }

        const tip = landmarks[8];
        const score = results?.multiHandedness?.[0]?.score ?? 1;
        lastHandRef.current = {
          x: clamp01(tip.x),
          y: clamp01(tip.y),
          confidence: clamp01(score),
          points: landmarks.map((point: any) => ({
            x: clamp01(point.x),
            y: clamp01(point.y),
          })),
        };
      });

      handsRef.current = hands;

      runningRef.current = true;
      setIsConnected(true);
      renderLoop();
      handLoop();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || "Could not access the camera.");
      setHasStarted(false);
      cleanupMedia();
    } finally {
      setIsStarting(false);
    }
  }, [cleanupMedia, isConnected, isStarting, renderLoop, resetGameState]);

  const stopBackend = useCallback(async () => {
    setIsStopping(true);
    setError(null);
    setHasStarted(false);

    cleanupMedia();
    setIsConnected(false);

    setIsStopping(false);
  }, [cleanupMedia]);

  const resetGame = useCallback(() => {
    resetGameState();
  }, [resetGameState]);

  useEffect(() => {
    return () => {
      cleanupMedia();
    };
  }, [cleanupMedia]);

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
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-bold text-foreground transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
              type="button"
              disabled={isStarting || isConnected}
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
              <span className="text-xs text-muted-foreground">Browser camera</span>
            </div>

            <div className="relative aspect-[4/3] w-full bg-slate-950">
              {isLive ? (
                <canvas
                  ref={canvasRef}
                  width={CANVAS_WIDTH}
                  height={CANVAS_HEIGHT}
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
              <video ref={videoRef} className="hidden" />
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
                    {Math.min(stream.missed ?? 0, MAX_MISSES)}/{stream.maxMisses ?? MAX_MISSES}
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
