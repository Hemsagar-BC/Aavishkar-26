'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useGestureSocket } from '@/hooks/useGestureSocket';

type FruitType = 'fruit' | 'bomb';

interface Fruit {
  id: number;
  x: number;
  y: number;
  radius: number;
  speed: number;
  letter: string;
  sliced: boolean;
  type: FruitType;
}

const CANVAS_WIDTH = 640;
const CANVAS_HEIGHT = 480;
const TOP_BAR_HEIGHT = 80;
const FRUIT_SPAWN_INTERVAL = 1500;
const MAX_MISSES = 5;
const GRAVITY = 0.25;
const TRAIL_LENGTH = 15;
const CURSOR_CONFIDENCE_MIN = 0.2;
const FRUIT_LETTERS = ['A', 'B', 'C', 'D', 'E'];

export function GameCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationIdRef = useRef<number | null>(null);
  const lastSpawnRef = useRef(0);
  const trailRef = useRef<Array<{ x: number; y: number }>>([]);
  const lastCursorRef = useRef<{ x: number; y: number } | null>(null);
  const gameRef = useRef({
    fruits: [] as Fruit[],
    score: 0,
    missed: 0,
    feedback: '',
    feedbackTimer: 0,
    nextFruitId: 0,
    gameOver: false,
  });
  const displayRef = useRef({ score: 0, missed: 0 });
  const gameOverRef = useRef(false);

  const { cursorRef, dataRef, isConnected, error } = useGestureSocket();
  const [displayScore, setDisplayScore] = useState(0);
  const [displayMissed, setDisplayMissed] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const resetGame = useCallback(() => {
    gameRef.current = {
      fruits: [],
      score: 0,
      missed: 0,
      feedback: '',
      feedbackTimer: 0,
      nextFruitId: 0,
      gameOver: false,
    };
    displayRef.current = { score: 0, missed: 0 };
    gameOverRef.current = false;
    trailRef.current = [];
    lastCursorRef.current = null;
    lastSpawnRef.current = 0;
    setDisplayScore(0);
    setDisplayMissed(0);
    setGameOver(false);
  }, []);

  const createFruit = useCallback((): Fruit => {
    const isBomb = Math.floor(Math.random() * 5) === 0;
    const baseX = Math.round(Math.random() * (CANVAS_WIDTH - 200)) + 100;

    if (isBomb) {
      return {
        id: gameRef.current.nextFruitId++,
        x: baseX,
        y: CANVAS_HEIGHT,
        radius: 40,
        speed: Math.round(Math.random() * 4) + 8,
        letter: 'X',
        sliced: false,
        type: 'bomb',
      };
    }

    return {
      id: gameRef.current.nextFruitId++,
      x: baseX,
      y: CANVAS_HEIGHT,
      radius: 35,
      speed: Math.round(Math.random() * 4) + 8,
      letter: FRUIT_LETTERS[Math.floor(Math.random() * FRUIT_LETTERS.length)],
      sliced: false,
      type: 'fruit',
    };
  }, []);

  const spawnFruit = useCallback((now: number) => {
    if (now - lastSpawnRef.current < FRUIT_SPAWN_INTERVAL) return;
    if (gameRef.current.gameOver) return;

    gameRef.current.fruits.push(createFruit());
    lastSpawnRef.current = now;
  }, [createFruit]);

  const applySlice = useCallback((fruit: Fruit) => {
    if (fruit.sliced || gameRef.current.gameOver) return;

    fruit.sliced = true;

    if (fruit.type === 'bomb') {
      gameRef.current.score -= 5;
      gameRef.current.missed += 1;
      gameRef.current.feedback = 'BOMB HIT!';
      gameRef.current.feedbackTimer = 30;
    } else {
      gameRef.current.score += 1;
      gameRef.current.feedback = 'GOOD!';
      gameRef.current.feedbackTimer = 20;
    }
  }, []);

  const updateDisplayState = useCallback(() => {
    const { score, missed } = gameRef.current;

    if (score !== displayRef.current.score) {
      displayRef.current.score = score;
      setDisplayScore(score);
    }

    if (missed !== displayRef.current.missed) {
      displayRef.current.missed = missed;
      setDisplayMissed(missed);
    }

    if (gameRef.current.gameOver !== gameOverRef.current) {
      gameOverRef.current = gameRef.current.gameOver;
      setGameOver(gameRef.current.gameOver);
    }
  }, []);

  const drawTopBar = (ctx: CanvasRenderingContext2D) => {
    ctx.save();
    ctx.fillStyle = 'rgba(30, 30, 30, 0.6)';
    ctx.fillRect(0, 0, CANVAS_WIDTH, TOP_BAR_HEIGHT);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px "OpenDyslexic", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Gesture Slice Trainer', CANVAS_WIDTH / 2, 40);
    ctx.font = 'bold 18px "OpenDyslexic", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#00ff99';
    ctx.fillText(`Score: ${displayScore}`, 20, 70);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ff4d4d';
    ctx.fillText(`Misses: ${displayMissed}/${MAX_MISSES}`, CANVAS_WIDTH - 20, 70);
    ctx.restore();
  };

  const drawFruit = (ctx: CanvasRenderingContext2D, fruit: Fruit) => {
    const isBomb = fruit.type === 'bomb';
    const pulse = Math.floor(Date.now() / 200) % 2 === 0;
    const fillColor = isBomb ? (pulse ? '#ffffff' : '#ff2e2e') : '#ff8c00';

    ctx.save();
    ctx.fillStyle = fillColor;
    ctx.beginPath();
    ctx.arc(fruit.x, fruit.y, fruit.radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 28px "OpenDyslexic", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(fruit.letter, fruit.x, fruit.y + 2);
    ctx.restore();
  };

  const drawTrail = (ctx: CanvasRenderingContext2D) => {
    if (trailRef.current.length < 2) return;

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 0, 0.8)';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(trailRef.current[0].x, trailRef.current[0].y);
    trailRef.current.forEach((point) => {
      ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();
    ctx.restore();
  };

  const drawCursor = (ctx: CanvasRenderingContext2D, x: number, y: number) => {
    ctx.save();
    ctx.fillStyle = '#fff000';
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 28, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  };

  const drawFeedback = (ctx: CanvasRenderingContext2D) => {
    if (gameRef.current.feedbackTimer <= 0) return;

    const color = gameRef.current.feedback.includes('BOMB') ? '#ff3b3b' : '#00ff99';
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = 'bold 32px "OpenDyslexic", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(gameRef.current.feedback, CANVAS_WIDTH / 2, 120);
    ctx.restore();
  };

  const drawStatus = (ctx: CanvasRenderingContext2D) => {
    ctx.save();
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = isConnected ? '#7CFF5B' : '#ff6b6b';
    const status = isConnected ? 'WS: Connected' : 'WS: Disconnected';
    ctx.fillText(status, CANVAS_WIDTH - 12, 20);

    if (isConnected && dataRef.current.confidence < CURSOR_CONFIDENCE_MIN) {
      ctx.fillStyle = '#ffd166';
      ctx.fillText('Hand not detected', CANVAS_WIDTH - 12, 40);
    }
    ctx.restore();
  };

  const drawGameOver = (ctx: CanvasRenderingContext2D) => {
    if (!gameRef.current.gameOver) return;

    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(60, 120, CANVAS_WIDTH - 120, 240);

    ctx.fillStyle = '#ff3b3b';
    ctx.font = 'bold 40px "OpenDyslexic", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('GAME OVER', CANVAS_WIDTH / 2, 200);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px "OpenDyslexic", sans-serif';
    ctx.fillText(`Final Score: ${gameRef.current.score}`, CANVAS_WIDTH / 2, 260);

    ctx.fillStyle = '#ffd166';
    ctx.font = 'bold 18px "OpenDyslexic", sans-serif';
    ctx.fillText('Press R to Restart', CANVAS_WIDTH / 2, 310);
    ctx.restore();
  };

  const gameLoop = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const now = Date.now();
    const cursor = cursorRef.current;
    const cursorX = cursor.x * CANVAS_WIDTH;
    const cursorY = cursor.y * CANVAS_HEIGHT;
    const cursorActive = isConnected && dataRef.current.confidence >= CURSOR_CONFIDENCE_MIN;

    spawnFruit(now);

    if (!gameRef.current.gameOver) {
      const nextFruits: Fruit[] = [];
      for (const fruit of gameRef.current.fruits) {
        if (fruit.sliced) {
          continue;
        }

        fruit.y -= fruit.speed;
        fruit.speed -= GRAVITY;

        if (fruit.y > CANVAS_HEIGHT + fruit.radius) {
          if (fruit.type === 'fruit') {
            gameRef.current.missed += 1;
          }
          continue;
        }

        if (cursorActive) {
          const distance = Math.hypot(cursorX - fruit.x, cursorY - fruit.y);
          if (distance < fruit.radius) {
            applySlice(fruit);
            continue;
          }
        }

        nextFruits.push(fruit);
      }

      gameRef.current.fruits = nextFruits;

      if (gameRef.current.feedbackTimer > 0) {
        gameRef.current.feedbackTimer -= 1;
      }

      if (gameRef.current.missed >= MAX_MISSES) {
        gameRef.current.gameOver = true;
      }
    }

    if (cursorActive) {
      if (!lastCursorRef.current || lastCursorRef.current.x !== cursorX || lastCursorRef.current.y !== cursorY) {
        trailRef.current.push({ x: cursorX, y: cursorY });
        if (trailRef.current.length > TRAIL_LENGTH) {
          trailRef.current.shift();
        }
        lastCursorRef.current = { x: cursorX, y: cursorY };
      }
    } else {
      trailRef.current = [];
      lastCursorRef.current = null;
    }

    const video = videoRef.current;
    if (video && video.readyState >= 2) {
      ctx.drawImage(video, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    } else {
      ctx.fillStyle = '#0b0b0f';
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }

    drawTopBar(ctx);
    drawStatus(ctx);

    gameRef.current.fruits.forEach((fruit) => drawFruit(ctx, fruit));

    drawTrail(ctx);

    if (cursorActive) {
      drawCursor(ctx, cursorX, cursorY);
    }

    drawFeedback(ctx);
    drawGameOver(ctx);

    updateDisplayState();

    animationIdRef.current = requestAnimationFrame(gameLoop);
  }, [applySlice, cursorRef, dataRef, drawFeedback, drawGameOver, drawStatus, drawTopBar, drawTrail, drawCursor, drawFruit, isConnected, spawnFruit, updateDisplayState]);

  useEffect(() => {
    animationIdRef.current = requestAnimationFrame(gameLoop);
    return () => {
      if (animationIdRef.current) {
        cancelAnimationFrame(animationIdRef.current);
      }
    };
  }, [gameLoop]);

  const requestCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('Webcam not supported in this browser.');
      return;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: CANVAS_WIDTH,
          height: CANVAS_HEIGHT,
        },
        audio: false,
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
        videoRef.current.playsInline = true;
        await videoRef.current.play();
      }
      setCameraError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setCameraError(`Webcam access failed. ${message}`);
    }
  }, []);

  useEffect(() => {
    requestCamera();
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, [requestCamera]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'r') {
        resetGame();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [resetGame]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900">
      <div className="relative" style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT }}>
        <video
          ref={videoRef}
          className="absolute inset-0 opacity-0 pointer-events-none"
          style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT }}
          playsInline
          muted
        />
        <canvas
          ref={canvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          className="border-2 border-yellow-400 shadow-lg"
        />
      </div>
      {gameOver && (
        <button
          onClick={resetGame}
          className="mt-4 px-6 py-2 bg-yellow-400 text-black font-bold rounded"
          style={{ fontFamily: 'OpenDyslexic' }}
        >
          Restart
        </button>
      )}
      {error && (
        <p className="text-red-500 mt-2" style={{ fontFamily: 'OpenDyslexic' }}>
          Connection Error: {error}
        </p>
      )}
      {cameraError && (
        <div className="mt-2 text-center" style={{ fontFamily: 'OpenDyslexic' }}>
          <p className="text-yellow-300">{cameraError}</p>
          <button
            onClick={requestCamera}
            className="mt-2 px-4 py-2 bg-yellow-400 text-black font-bold rounded"
          >
            Retry Camera
          </button>
        </div>
      )}
    </div>
  );
}
