import asyncio
import base64
import json
import math
import os
import random
import time
import urllib.request
from typing import Set, Optional, Tuple

import cv2
import websockets

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "hand_landmarker.task")
MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task"
HOST = os.environ.get("HOST", "0.0.0.0")

def get_port(default: int = 8765) -> int:
    raw = os.environ.get("PORT")
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default

PORT = get_port()
CANVAS_WIDTH = 640
CANVAS_HEIGHT = 480
MAX_MISSES = 5
FRUIT_LETTERS = ["A", "B", "C", "D", "E"]
HAND_CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 4),
    (0, 5), (5, 6), (6, 7), (7, 8),
    (0, 9), (9, 10), (10, 11), (11, 12),
    (0, 13), (13, 14), (14, 15), (15, 16),
    (0, 17), (17, 18), (18, 19), (19, 20),
    (5, 9), (9, 13), (13, 17),
]
FINGERTIPS = [4, 8, 12, 16, 20]

connected_clients: Set[websockets.WebSocketServerProtocol] = set()
last_position = {"x": 0.5, "y": 0.5, "confidence": 0.0}
running = True


class GestureSliceGame:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.score = 0
        self.missed = 0
        self.trail_points = []
        self.fruits = []
        self.last_spawn_time = time.time()
        self.game_over = False
        self.feedback = ""
        self.feedback_timer = 0

    def create_fruit(self) -> dict:
        x = random.randint(100, CANVAS_WIDTH - 100)
        is_bomb = random.randint(1, 5) == 1

        return {
            "x": x,
            "y": CANVAS_HEIGHT,
            "radius": 40 if is_bomb else 35,
            "speed": random.randint(8, 12),
            "letter": "X" if is_bomb else random.choice(FRUIT_LETTERS),
            "sliced": False,
            "type": "bomb" if is_bomb else "fruit",
        }

    def maybe_spawn(self) -> None:
        if self.game_over:
            return

        current_time = time.time()
        if current_time - self.last_spawn_time > 1.5:
            self.fruits.append(self.create_fruit())
            self.last_spawn_time = current_time

    def draw_ui(self, frame) -> None:
        overlay = frame.copy()
        cv2.rectangle(overlay, (0, 0), (CANVAS_WIDTH, 80), (30, 30, 30), -1)
        cv2.addWeighted(overlay, 0.6, frame, 0.4, 0, frame)

        cv2.putText(frame, "OpenCV Gesture Slice", (135, 40), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 3)
        cv2.putText(frame, f"Score: {self.score}", (20, 70), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
        cv2.putText(frame, f"Misses: {self.missed}/{MAX_MISSES}", (405, 70), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)

    def draw_fruits(self, frame) -> None:
        remove_list = []

        for fruit in self.fruits:
            if fruit["sliced"]:
                remove_list.append(fruit)
                continue

            fruit["y"] -= fruit["speed"]
            fruit["speed"] -= 0.25

            color = (0, 0, 255) if fruit["type"] == "bomb" else (0, 140, 255)
            if fruit["type"] == "bomb" and int(time.time() * 5) % 2 == 0:
                color = (255, 255, 255)

            cv2.circle(frame, (fruit["x"], int(fruit["y"])), fruit["radius"], color, cv2.FILLED)
            cv2.circle(frame, (fruit["x"], int(fruit["y"])), fruit["radius"], (255, 255, 255), 3)
            cv2.putText(
                frame,
                fruit["letter"],
                (fruit["x"] - 15, int(fruit["y"] + 12)),
                cv2.FONT_HERSHEY_SIMPLEX,
                1.5,
                (255, 255, 255),
                4,
            )

            if fruit["y"] > CANVAS_HEIGHT + fruit["radius"]:
                remove_list.append(fruit)
                if fruit["type"] == "fruit":
                    self.missed += 1

        for fruit in remove_list:
            if fruit in self.fruits:
                self.fruits.remove(fruit)

    def draw_trail(self, frame) -> None:
        for index in range(1, len(self.trail_points)):
            cv2.line(frame, self.trail_points[index - 1], self.trail_points[index], (255, 255, 0), 5)

    def check_slice(self, cursor_x: int, cursor_y: int) -> None:
        for fruit in self.fruits:
            if fruit["sliced"]:
                continue

            distance = math.hypot(cursor_x - fruit["x"], cursor_y - fruit["y"])
            if distance >= fruit["radius"]:
                continue

            fruit["sliced"] = True
            if fruit["type"] == "bomb":
                self.score -= 5
                self.missed += 1
                self.feedback = "BOMB HIT!"
                self.feedback_timer = 30
            else:
                self.score += 1
                self.feedback = "GOOD!"
                self.feedback_timer = 20

    def draw_feedback(self, frame) -> None:
        if self.feedback_timer <= 0:
            return

        color = (0, 0, 255) if "BOMB" in self.feedback else (0, 255, 0)
        cv2.putText(frame, self.feedback, (220, 120), cv2.FONT_HERSHEY_SIMPLEX, 1.3, color, 4)
        self.feedback_timer -= 1

    def draw_game_over(self, frame) -> None:
        if not self.game_over:
            return

        overlay = frame.copy()
        cv2.rectangle(overlay, (80, 120), (560, 360), (0, 0, 0), -1)
        cv2.addWeighted(overlay, 0.7, frame, 0.3, 0, frame)
        cv2.putText(frame, "GAME OVER", (180, 200), cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 0, 255), 5)
        cv2.putText(frame, f"Final Score: {self.score}", (180, 280), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 3)
        cv2.putText(frame, "Click Restart", (200, 340), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 255), 3)

    def update(self, frame, cursor: Optional[Tuple[int, int]]) -> None:
        if self.missed >= MAX_MISSES:
            self.game_over = True

        self.maybe_spawn()
        self.draw_ui(frame)
        self.draw_fruits(frame)

        if cursor and not self.game_over:
            cursor_x, cursor_y = cursor
            cv2.circle(frame, (cursor_x, cursor_y), 18, (255, 255, 0), cv2.FILLED)
            cv2.circle(frame, (cursor_x, cursor_y), 28, (255, 255, 255), 2)
            self.trail_points.append((cursor_x, cursor_y))
            if len(self.trail_points) > 15:
                self.trail_points.pop(0)
            self.draw_trail(frame)
            self.check_slice(cursor_x, cursor_y)

        self.draw_feedback(frame)
        self.draw_game_over(frame)

    def state(self) -> dict:
        return {
            "score": self.score,
            "missed": self.missed,
            "maxMisses": MAX_MISSES,
            "gameOver": self.game_over,
            "feedback": self.feedback if self.feedback_timer > 0 else "",
        }


game = GestureSliceGame()


def ensure_model_file() -> None:
    if os.path.exists(MODEL_PATH):
        return

    print("Downloading MediaPipe model...")
    urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
    print("Download complete!")


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def normalize_coords(x: float, y: float, confidence: float) -> dict:
    return {
        "x": clamp01(x),
        "y": clamp01(y),
        "confidence": clamp01(confidence),
    }


def get_tasks_tracker(mp) -> Optional[Tuple[str, object]]:
    try:
        if not hasattr(mp, "tasks"):
            return None

        ensure_model_file()
        BaseOptions = mp.tasks.BaseOptions
        HandLandmarker = mp.tasks.vision.HandLandmarker
        HandLandmarkerOptions = mp.tasks.vision.HandLandmarkerOptions
        VisionRunningMode = mp.tasks.vision.RunningMode

        options = HandLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=MODEL_PATH),
            running_mode=VisionRunningMode.VIDEO,
            num_hands=1,
            min_hand_detection_confidence=0.7,
            min_hand_presence_confidence=0.7,
            min_tracking_confidence=0.7,
        )
        tracker = HandLandmarker.create_from_options(options)
        return "tasks", tracker
    except Exception as exc:
        print(f"MediaPipe tasks init failed: {exc}")
        return None


def get_solutions_tracker(mp) -> Optional[Tuple[str, object]]:
    try:
        if not hasattr(mp, "solutions"):
            return None

        hands_module = mp.solutions.hands
        tracker = hands_module.Hands(
            static_image_mode=False,
            max_num_hands=1,
            min_detection_confidence=0.7,
            min_tracking_confidence=0.5,
        )
        return "solutions", tracker
    except Exception as exc:
        print(f"MediaPipe solutions init failed: {exc}")
        return None


def extract_tasks_coords(mp, result) -> Optional[dict]:
    if not result.hand_landmarks:
        return None

    landmark = result.hand_landmarks[0][8]
    confidence = 1.0
    if result.handedness and result.handedness[0]:
        confidence = result.handedness[0][0].score

    return normalize_coords(landmark.x, landmark.y, confidence)


def extract_tasks_points(result, width: int, height: int) -> Optional[dict]:
    if not result.hand_landmarks:
        return None

    return {
        index: (int(landmark.x * width), int(landmark.y * height))
        for index, landmark in enumerate(result.hand_landmarks[0])
    }


def extract_solutions_coords(results) -> Optional[dict]:
    if not results.multi_hand_landmarks:
        return None

    fingertip = results.multi_hand_landmarks[0].landmark[8]
    confidence = 1.0
    if results.multi_handedness:
        confidence = results.multi_handedness[0].classification[0].score

    return normalize_coords(fingertip.x, fingertip.y, confidence)


def extract_solutions_points(results, width: int, height: int) -> Optional[dict]:
    if not results.multi_hand_landmarks:
        return None

    return {
        index: (int(landmark.x * width), int(landmark.y * height))
        for index, landmark in enumerate(results.multi_hand_landmarks[0].landmark)
    }


def draw_hand_landmarks(frame, points: Optional[dict]) -> Optional[Tuple[int, int]]:
    if not points:
        return None

    raised_fingers = []
    for tip, pip in [(8, 6), (12, 10), (16, 14), (20, 18)]:
        if tip in points and pip in points and points[tip][1] < points[pip][1]:
            raised_fingers.append(tip)

    for start, end in HAND_CONNECTIONS:
        if start in points and end in points:
            cv2.line(frame, points[start], points[end], (0, 200, 255), 2)

    for index, point in points.items():
        color = (0, 255, 0)
        if index in FINGERTIPS:
            color = (255, 0, 255)
        if index in raised_fingers:
            color = (255, 255, 0)
        cv2.circle(frame, point, 5, color, cv2.FILLED)

    return points.get(8)


def encode_frame(frame) -> str:
    success, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 72])
    if not success:
        return ""

    encoded = base64.b64encode(buffer).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


async def broadcast(message: str) -> None:
    if not connected_clients:
        return

    await asyncio.gather(
        *[client.send(message) for client in connected_clients],
        return_exceptions=True,
    )


async def handle_client(websocket, path=None):
    if path is None:
        path = getattr(websocket, "path", "")
    connected_clients.add(websocket)
    print(f"Client connected {path}. Total clients: {len(connected_clients)}")

    try:
        async for message in websocket:
            try:
                payload = json.loads(message)
            except json.JSONDecodeError:
                continue

            if payload.get("type") == "reset":
                game.reset()
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        connected_clients.discard(websocket)
        print(f"Client disconnected. Total clients: {len(connected_clients)}")


async def mock_gesture_stream() -> None:
    global last_position

    start_time = time.time()
    while running:
        elapsed = (time.time() - start_time) % 10
        t = (elapsed / 10) * 2 * math.pi
        x = 0.5 + 0.3 * math.sin(t)
        y = 0.3 + 0.2 * math.sin(t / 2)
        confidence = min(1.0, elapsed / 0.5) if elapsed > 0.1 else 0.0

        last_position = normalize_coords(x, y, confidence)

        message = json.dumps({
            "x": last_position["x"],
            "y": last_position["y"],
            "confidence": last_position["confidence"],
            "gesture": "mock",
            "frame": "",
            **game.state(),
        })
        await broadcast(message)
        await asyncio.sleep(0.033)


async def gesture_stream() -> None:
    global last_position, running

    try:
        import mediapipe as mp
    except Exception as exc:
        print(f"MediaPipe import failed: {exc}")
        mp = None

    tracker_mode = None
    tracker = None
    if mp is not None:
        tasks_tracker = get_tasks_tracker(mp)
        if tasks_tracker:
            tracker_mode, tracker = tasks_tracker
        else:
            solutions_tracker = get_solutions_tracker(mp)
            if solutions_tracker:
                tracker_mode, tracker = solutions_tracker

    if tracker is None:
        print("MediaPipe unavailable. Using mock stream.")
        await mock_gesture_stream()
        return

    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("Camera not found. Using mock stream.")
        await mock_gesture_stream()
        return

    target_fps = 30
    frame_delay = 1.0 / target_fps

    try:
        while running:
            success, frame = cap.read()
            if not success:
                await asyncio.sleep(0.01)
                continue

            frame = cv2.flip(frame, 1)
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

            coords = None
            if tracker_mode == "tasks":
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=frame_rgb)
                timestamp = int(time.time() * 1000)

                result = tracker.detect_for_video(
                    mp_image,
                    timestamp
                )
                coords = extract_tasks_coords(mp, result)
            else:
                results = tracker.process(frame_rgb)
                coords = extract_solutions_coords(results)

            points = None
            if coords:
                last_position = coords
            else:
                coords = last_position.copy()
                coords["confidence"] = 0.0

            if tracker_mode == "tasks":
                points = extract_tasks_points(result, frame.shape[1], frame.shape[0])
            else:
                points = extract_solutions_points(results, frame.shape[1], frame.shape[0])

            cursor = draw_hand_landmarks(frame, points)
            game.update(frame, cursor if coords["confidence"] > 0 else None)

            message = json.dumps({
                "x": coords["x"],
                "y": coords["y"],
                "confidence": coords["confidence"],
                "gesture": "pointing",
                "frame": encode_frame(frame),
                **game.state(),
            })

            await broadcast(message)
            await asyncio.sleep(frame_delay)
    finally:
        cap.release()
        if hasattr(tracker, "close"):
            tracker.close()


async def main() -> None:
    print(f"Starting GestureNinja backend on ws://{HOST}:{PORT}")

    gesture_task = asyncio.create_task(gesture_stream())
    async with websockets.serve(handle_client, HOST, PORT):
        try:
            await asyncio.gather(gesture_task)
        except KeyboardInterrupt:
            print("Shutting down...")
            global running
            running = False


if __name__ == "__main__":
    asyncio.run(main())
