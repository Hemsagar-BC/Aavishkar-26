import { NextResponse } from "next/server";
import type { ChildProcessWithoutNullStreams } from "child_process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const globalForOpenCv = globalThis as typeof globalThis & {
  openCvGestureProcess?: ChildProcessWithoutNullStreams;
  openCvGestureLog?: string[];
};

function rememberLog(line: string) {
  globalForOpenCv.openCvGestureLog ??= [];
  globalForOpenCv.openCvGestureLog.push(line);
  globalForOpenCv.openCvGestureLog = globalForOpenCv.openCvGestureLog.slice(-20);
}

export async function POST() {
  const processRef = globalForOpenCv.openCvGestureProcess;

  if (!processRef || processRef.exitCode !== null) {
    rememberLog("No page-started OpenCV backend process is running.");
    return NextResponse.json({
      ok: true,
      status: "not-running",
      logs: globalForOpenCv.openCvGestureLog ?? [],
    });
  }

  processRef.kill();
  globalForOpenCv.openCvGestureProcess = undefined;
  rememberLog("Stopped the page-started OpenCV backend process.");

  return NextResponse.json({
    ok: true,
    status: "stopped",
    logs: globalForOpenCv.openCvGestureLog ?? [],
  });
}
