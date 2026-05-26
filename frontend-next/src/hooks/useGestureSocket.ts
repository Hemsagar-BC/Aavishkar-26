'use client';

import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

export interface GestureSocketData {
  x: number;
  y: number;
  confidence: number;
  gesture: string;
}

export interface UseGestureSocketReturn {
  cursorPos: { x: number; y: number };
  cursorRef: MutableRefObject<{ x: number; y: number }>;
  dataRef: MutableRefObject<GestureSocketData>;
  confidence: number;
  gesture: string;
  lastMessageAt: number | null;
  isConnected: boolean;
  error: string | null;
}

export function useGestureSocket(url: string = 'ws://localhost:8765'): UseGestureSocketReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursorPosRef = useRef({ x: 0.5, y: 0.5 });
  const lastDataRef = useRef<GestureSocketData>({
    x: 0.5,
    y: 0.5,
    confidence: 0,
    gesture: 'none',
  });
  const lastMessageAtRef = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    let isMounted = true;

    const connect = () => {
      try {
        const ws = new WebSocket(url);

        ws.onopen = () => {
          if (isMounted) {
            setIsConnected(true);
            setError(null);
          }
        };

        ws.onmessage = (event) => {
          try {
            const data: GestureSocketData = JSON.parse(event.data);
            // Use useRef to avoid re-renders on every cursor move
            cursorPosRef.current = { x: data.x, y: data.y };
            lastDataRef.current = data;
            lastMessageAtRef.current = Date.now();
          } catch (e) {
            console.error('Failed to parse gesture data:', e);
          }
        };

        ws.onerror = () => {
          if (isMounted) {
            setError('WebSocket connection error');
            setIsConnected(false);
          }
        };

        ws.onclose = () => {
          if (isMounted) {
            setIsConnected(false);
            // Auto-reconnect after 2 seconds
            reconnectTimeoutRef.current = setTimeout(connect, 2000);
          }
        };

        wsRef.current = ws;
      } catch (e) {
        if (isMounted) {
          setError(`Connection failed: ${String(e)}`);
        }
      }
    };

    connect();

    return () => {
      isMounted = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [url]);

  return {
    cursorPos: cursorPosRef.current,
    cursorRef: cursorPosRef,
    dataRef: lastDataRef,
    confidence: lastDataRef.current.confidence,
    gesture: lastDataRef.current.gesture,
    lastMessageAt: lastMessageAtRef.current,
    isConnected,
    error,
  };
}
