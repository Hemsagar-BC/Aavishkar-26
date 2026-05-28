import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { existsSync } from "fs";
import net from "net";
import path from "path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const globalForOpenCv = globalThis as typeof globalThis & {
  openCvGestureProcess?: ChildProcessWithoutNullStreams;
  openCvGestureLog?: string[];
};

const OPENCV_HOST = "127.0.0.1";
const OPENCV_PORT = 8765;
const OPENCV_WS_URL = `ws://localhost:${OPENCV_PORT}`;

function rememberLog(line: string) {
  globalForOpenCv.openCvGestureLog ??= [];
  globalForOpenCv.openCvGestureLog.push(line);
  globalForOpenCv.openCvGestureLog = globalForOpenCv.openCvGestureLog.slice(-20);
}

function isPortOpen(host: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

export async function POST() {
  const existing = globalForOpenCv.openCvGestureProcess;
  if (existing && existing.exitCode === null) {
    if (!(await isPortOpen(OPENCV_HOST, OPENCV_PORT))) {
      existing.kill();
      globalForOpenCv.openCvGestureProcess = undefined;
      rememberLog(`Restarting OpenCV backend because the process was alive but ${OPENCV_WS_URL} was not listening.`);
    } else {
      return NextResponse.json({
        ok: true,
        status: "already-running",
        wsUrl: OPENCV_WS_URL,
        logs: globalForOpenCv.openCvGestureLog ?? [],
      });
    }
  }

  if (await isPortOpen(OPENCV_HOST, OPENCV_PORT)) {
    rememberLog(`Gesture backend is already listening on ${OPENCV_WS_URL}`);
    return NextResponse.json({
      ok: true,
      status: "already-listening",
      wsUrl: OPENCV_WS_URL,
      logs: globalForOpenCv.openCvGestureLog ?? [],
    });
  }

  const candidates = [
    path.resolve(process.cwd(), "..", "gesture-backend"),
    path.resolve(process.cwd(), "gesture-backend"),
  ];
  const gestureBackendDir =
    candidates.find((candidate) => existsSync(path.join(candidate, "ws_server.py"))) ?? candidates[0];
  const serverPath = path.join(gestureBackendDir, "ws_server.py");

  if (!existsSync(serverPath)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Could not find gesture backend at ${serverPath}`,
      },
      { status: 500 },
    );
  }

  const venvPython = process.platform === "win32"
    ? path.join(gestureBackendDir, "venv", "Scripts", "python.exe")
    : path.join(gestureBackendDir, "venv", "bin", "python");
  const pythonCommand = existsSync(venvPython)
    ? venvPython
    : process.platform === "win32" ? "python" : "python3";
  const child = spawn(pythonCommand, ["ws_server.py"], {
    cwd: gestureBackendDir,
    env: {
      ...process.env,
      HOST: OPENCV_HOST,
      PORT: String(OPENCV_PORT),
    },
    stdio: "pipe",
    windowsHide: true,
  });

  globalForOpenCv.openCvGestureProcess = child;
  rememberLog(`Started ${pythonCommand} ws_server.py in ${gestureBackendDir}`);

  child.stdout.on("data", (chunk) => rememberLog(chunk.toString().trim()));
  child.stderr.on("data", (chunk) => rememberLog(chunk.toString().trim()));
  child.on("exit", (code) => rememberLog(`Gesture backend exited with code ${code}`));

  return NextResponse.json({
    ok: true,
    status: "started",
    wsUrl: OPENCV_WS_URL,
    logs: globalForOpenCv.openCvGestureLog ?? [],
  });
}
