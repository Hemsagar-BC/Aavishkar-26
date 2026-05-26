"""
FastAPI backend with Ollama integration for NeuroLex
Processes lecture transcriptions using local Ollama LLM
"""

# Fix Windows console encoding — Python defaults to cp1252 on Windows which
# crashes on emoji/Unicode chars returned by Gemini AI responses.
import sys
import io
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from fastapi import FastAPI, HTTPException, File, UploadFile, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import firebase_admin
from firebase_admin import credentials, firestore
from datetime import datetime, timezone
import os
from dotenv import load_dotenv
import requests
import time
import asyncio
import json
import threading
import traceback
import hashlib
from uuid import uuid4
from io import BytesIO
from concurrent.futures import ThreadPoolExecutor
try:
    from PIL import Image, ImageEnhance, ImageFilter, ImageOps
except ImportError:
    Image = None
    ImageEnhance = None
    ImageFilter = None
    ImageOps = None
    print("[WARNING] Pillow not installed -- handwriting image enhancement disabled")

from app.routers import assessment as assessment_router
from app.routers import games as games_router
from app.routers import tts as tts_router
from app.services.severity_model import load_model as load_severity_model

# Global rate limiter for Gemini API (free tier: ~15 RPM for 2.0-flash, ~1 RPM for Vision)
_gemini_lock = threading.Lock()
_last_gemini_call = 0
_last_vision_call = 0
MIN_CALL_INTERVAL = 1  # 1s stagger for text API
MIN_VISION_INTERVAL = 3  # 3s minimum for Vision API (free tier is very limited)

# Simple in-memory cache for repeated handwriting uploads (demo-friendly)
HANDWRITING_CACHE_TTL_SECONDS = int(os.getenv("HANDWRITING_CACHE_TTL_SECONDS", "900"))
HANDWRITING_CACHE_MAX_ENTRIES = int(os.getenv("HANDWRITING_CACHE_MAX_ENTRIES", "200"))
HANDWRITING_CACHE_FILE = None
_handwriting_cache = {}
_handwriting_cache_lock = threading.Lock()

def _handwriting_cache_key(file_bytes: bytes) -> str:
    if Image is not None and ImageOps is not None:
        try:
            img = Image.open(BytesIO(file_bytes))
            img = ImageOps.exif_transpose(img)
            if img.mode != "RGB":
                img = img.convert("RGB")
            img = img.resize((512, 512))
            return hashlib.sha256(img.tobytes()).hexdigest()
        except Exception:
            pass
    return hashlib.sha256(file_bytes).hexdigest()

def _get_handwriting_cache(key: str):
    now = time.time()
    with _handwriting_cache_lock:
        entry = _handwriting_cache.get(key)
        if not entry:
            return None
        age = now - entry["created_at"]
        if age > HANDWRITING_CACHE_TTL_SECONDS:
            _handwriting_cache.pop(key, None)
            return None
        return {"result": entry["result"], "age": age}

def _prune_handwriting_cache(now: float = None):
    if now is None:
        now = time.time()
    expired_keys = [
        key for key, entry in _handwriting_cache.items()
        if now - entry.get("created_at", 0) > HANDWRITING_CACHE_TTL_SECONDS
    ]
    for key in expired_keys:
        _handwriting_cache.pop(key, None)

    while len(_handwriting_cache) > HANDWRITING_CACHE_MAX_ENTRIES:
        oldest_key = min(_handwriting_cache, key=lambda k: _handwriting_cache[k]["created_at"])
        _handwriting_cache.pop(oldest_key, None)

def _set_handwriting_cache(key: str, result: dict):
    now = time.time()
    with _handwriting_cache_lock:
        _handwriting_cache[key] = {"result": result, "created_at": now}
        _prune_handwriting_cache(now)
        _persist_handwriting_cache_to_disk()

def _persist_handwriting_cache_to_disk():
    if not HANDWRITING_CACHE_FILE:
        return
    try:
        cache_dir = os.path.dirname(HANDWRITING_CACHE_FILE)
        if cache_dir:
            os.makedirs(cache_dir, exist_ok=True)
        data = {"entries": _handwriting_cache}
        temp_path = f"{HANDWRITING_CACHE_FILE}.tmp"
        with open(temp_path, "w", encoding="utf-8") as handle:
            json.dump(data, handle)
        os.replace(temp_path, HANDWRITING_CACHE_FILE)
    except Exception as exc:
        print(f"[WARN] Failed to persist handwriting cache: {exc}")

def _load_handwriting_cache_from_disk():
    if not HANDWRITING_CACHE_FILE:
        return
    if not os.path.exists(HANDWRITING_CACHE_FILE):
        return
    try:
        with open(HANDWRITING_CACHE_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle) or {}
        entries = data.get("entries", {})
        if not isinstance(entries, dict):
            return
        now = time.time()
        with _handwriting_cache_lock:
            _handwriting_cache.clear()
            for key, entry in entries.items():
                if not isinstance(entry, dict):
                    continue
                created_at = entry.get("created_at")
                result = entry.get("result")
                if not isinstance(created_at, (int, float)):
                    continue
                if now - created_at > HANDWRITING_CACHE_TTL_SECONDS:
                    continue
                _handwriting_cache[key] = {"result": result, "created_at": created_at}
            _prune_handwriting_cache(now)
        print(f"[CACHE] Loaded {len(_handwriting_cache)} handwriting entries from disk")
    except Exception as exc:
        print(f"[WARN] Failed to load handwriting cache: {exc}")

# Load environment variables
load_dotenv()

HANDWRITING_CACHE_TTL_SECONDS = int(
    os.getenv("HANDWRITING_CACHE_TTL_SECONDS", str(HANDWRITING_CACHE_TTL_SECONDS))
)
HANDWRITING_CACHE_MAX_ENTRIES = int(
    os.getenv("HANDWRITING_CACHE_MAX_ENTRIES", str(HANDWRITING_CACHE_MAX_ENTRIES))
)
HANDWRITING_CACHE_FILE = os.getenv(
    "HANDWRITING_CACHE_FILE",
    os.path.join(os.path.dirname(__file__), "handwriting_cache.json"),
)
_load_handwriting_cache_from_disk()

# Initialize FastAPI
app = FastAPI(title="NeuroLex Backend")

# Configure CORS - Allow frontend origins (including all Vercel deployments)
# Vercel creates multiple URLs: production + preview deployments
# Using regex pattern to allow all Vercel domains
import re

# allowed_origin_patterns = [
#     r"http://localhost:\d+",  # Local development
#     r"https://.*\.vercel\.app",  # All Vercel deployments
#     r"https://.*-pushkarrds-projects\.vercel\.app",  # Your Vercel account
# ]
# app.add_middleware(
#     CORSMiddleware,
#     allow_origins=["*"],
#     allow_credentials=True,
#     allow_methods=["*"],
#     allow_headers=["*"],
# )

# def is_allowed_origin(origin: str) -> bool:
#     """Check if origin matches allowed patterns"""
#     if not origin:
#         return False
#     for pattern in allowed_origin_patterns:
#         if re.match(pattern, origin):
#             return True
#     return False

# # Custom CORS handler
# @app.middleware("http")
# async def cors_handler(request: Request, call_next):
#     origin = request.headers.get("origin", "")
    
#     response = await call_next(request)
    
#     # Add CORS headers if origin is allowed
#     if is_allowed_origin(origin):
#         response.headers["Access-Control-Allow-Origin"] = origin
#         response.headers["Access-Control-Allow-Credentials"] = "true"
#         response.headers["Access-Control-Allow-Methods"] = "*"
#         response.headers["Access-Control-Allow-Headers"] = "*"
    
#     return response

# # Handle preflight requests
# app.add_middleware(
#     CORSMiddleware,
#     allow_origin_regex=r"https://.*\.vercel\.app|http://localhost:\d+",
#     allow_credentials=True,
#     allow_methods=["*"],
#     allow_headers=["*"],
# )
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Initialize Firebase Admin SDK (graceful fallback)
# If Firebase credentials are missing in deployment env, keep API running and
# skip Firestore writes instead of crashing the whole service.
firebase_service_account_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
firebase_service_account_path = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH", "serviceAccountKey.json").strip()
db = None

try:
    if firebase_service_account_json:
        try:
            service_account_info = json.loads(firebase_service_account_json)
        except json.JSONDecodeError as exc:
            raise RuntimeError("Invalid FIREBASE_SERVICE_ACCOUNT_JSON. Must be valid JSON.") from exc
        cred = credentials.Certificate(service_account_info)
    elif os.path.exists(firebase_service_account_path):
        cred = credentials.Certificate(firebase_service_account_path)
    else:
        cred = None

    if cred is not None:
        if not firebase_admin._apps:
            firebase_admin.initialize_app(cred)
        db = firestore.client()
        print("[OK] Firebase initialized")
    else:
        print("[WARNING] Firebase credentials not found. Continuing without Firestore logging.")
except Exception as firebase_err:
    db = None
    print(f"[WARNING] Firebase init failed: {firebase_err}. Continuing without Firestore logging.")

# In-memory fallback store when Firestore is unavailable
_lecture_store = {}
_lecture_store_lock = threading.Lock()

def _lecture_now() -> datetime:
    return datetime.now(timezone.utc)

def _create_lecture_fallback(user_id: str, transcription: str) -> dict:
    lecture_id = uuid4().hex
    now = _lecture_now()
    lecture = {
        "id": lecture_id,
        "userId": user_id,
        "transcription": transcription,
        "simpleText": "",
        "detailedSteps": "",
        "mindMap": "",
        "summary": "",
        "createdAt": now,
        "updatedAt": now,
    }
    with _lecture_store_lock:
        _lecture_store[lecture_id] = lecture
    return lecture

def _get_lecture_fallback(lecture_id: str) -> Optional[dict]:
    with _lecture_store_lock:
        lecture = _lecture_store.get(lecture_id)
        return dict(lecture) if lecture else None

def _update_lecture_fallback(lecture_id: str, updates: dict) -> Optional[dict]:
    with _lecture_store_lock:
        lecture = _lecture_store.get(lecture_id)
        if not lecture:
            return None
        lecture.update(updates)
        lecture["updatedAt"] = _lecture_now()
        _lecture_store[lecture_id] = lecture
        return dict(lecture)

def _delete_lecture_fallback(lecture_id: str) -> bool:
    with _lecture_store_lock:
        return _lecture_store.pop(lecture_id, None) is not None

def _get_user_lectures_fallback(user_id: str) -> list:
    with _lecture_store_lock:
        lectures = [dict(v) for v in _lecture_store.values() if v.get("userId") == user_id]
    lectures.sort(key=lambda l: l.get("createdAt") or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return lectures

def _get_latest_lecture_fallback(user_id: str) -> Optional[dict]:
    lectures = _get_user_lectures_fallback(user_id)
    return lectures[0] if lectures else None

# Register assessment screening router
app.include_router(assessment_router.router)
app.include_router(games_router.router)
app.include_router(tts_router.router)


@app.get("/health/model")
def health_model():
    """Health check for the dyslexia severity model."""
    try:
        pkg = load_severity_model()
        model = pkg.get("model") if isinstance(pkg, dict) else None
        model_name = type(model).__name__ if model is not None else "unknown"
        feature_count = None
        if isinstance(pkg, dict):
            feature_names = pkg.get("feature_names")
            if feature_names:
                feature_count = len(feature_names)
            elif model is not None and hasattr(model, "n_features_in_"):
                feature_count = int(getattr(model, "n_features_in_"))
        return {"status": "ok", "model": model_name, "feature_count": feature_count}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Model load failed: {exc}")

# Preload ML severity model at startup
try:
    load_severity_model()
    print("[OK] Dyslexia severity model preloaded successfully")
except FileNotFoundError as e:
    print(f"[WARNING] ML model not found: {e}")

# Pydantic models
class LectureCreate(BaseModel):
    userId: str
    transcription: str

class LectureUpdate(BaseModel):
    transcription: Optional[str] = None
    simpleText: Optional[str] = None
    detailedSteps: Optional[str] = None
    mindMap: Optional[str] = None
    summary: Optional[str] = None

# Google Gemini API Configuration (native REST API)
# Supports multiple API keys for rotation (comma-separated in GEMINI_API_KEYS env var)
_all_gemini_keys = [k.strip() for k in os.getenv("GEMINI_API_KEYS", "").split(",") if k.strip()]
if not _all_gemini_keys:
    # Fallback to single key
    _single_key = os.getenv("GEMINI_API_KEY", "")
    if _single_key:
        _all_gemini_keys = [_single_key]

_current_key_index = 0

if not _all_gemini_keys:
    print("[WARNING] No Gemini API key configured! Set GEMINI_API_KEY or GEMINI_API_KEYS env var. "
          "Endpoints that use Gemini AI will return 500 errors.")

def _get_gemini_key() -> str:
    """Get the current Gemini API key, rotating if multiple are available."""
    global _current_key_index
    if not _all_gemini_keys:
        raise RuntimeError("No Gemini API key configured")
    return _all_gemini_keys[_current_key_index % len(_all_gemini_keys)]

def _rotate_gemini_key():
    """Switch to the next API key after a quota exhaustion."""
    global _current_key_index
    if len(_all_gemini_keys) > 1:
        _current_key_index = (_current_key_index + 1) % len(_all_gemini_keys)
        print(f"[ROTATE] Switched to Gemini API key #{_current_key_index + 1}/{len(_all_gemini_keys)}")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")  # Kept for backward compat
GEMINI_MODEL = "gemini-2.5-flash"  # Gemini model for text tasks
GEMINI_VISION_MODEL = "gemini-2.5-flash"  # Vision model (supports image analysis)
GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

@app.get("/")
async def root():
    return {"message": "NeuroLex Backend with Gemini AI", "status": "running"}

@app.get("/health")
async def health_check():
    return {"status": "ok", "model": GEMINI_MODEL}

def chunk_text(text: str, max_chunk_size: int = 500) -> list:
    """Split text into smaller chunks for faster processing"""
    sentences = text.replace("?", ".").replace("!", ".").split(".")
    sentences = [s.strip() for s in sentences if s.strip()]
    
    chunks = []
    current_chunk = []
    current_length = 0
    
    for sentence in sentences:
        sentence_length = len(sentence)
        if current_length + sentence_length > max_chunk_size and current_chunk:
            chunks.append(". ".join(current_chunk) + ".")
            current_chunk = [sentence]
            current_length = sentence_length
        else:
            current_chunk.append(sentence)
            current_length += sentence_length
    
    if current_chunk:
        chunks.append(". ".join(current_chunk) + ".")
    
    return chunks


def _normalize_text(text: str) -> str:
    """Collapse repeated whitespace and trim text."""
    return " ".join((text or "").split()).strip()


def _split_sentences(text: str) -> list:
    """Split plain text into simple sentence-like chunks."""
    normalized = _normalize_text(text)
    if not normalized:
        return []
    parts = re.split(r'(?<=[.!?])\s+', normalized)
    return [p.strip() for p in parts if p.strip()]


def _syllable_break_word(word: str) -> str:
    """Very lightweight syllable-style splitter for fallback output."""
    clean = re.sub(r'[^A-Za-z]', '', word)
    if len(clean) <= 6:
        return word

    chunks = []
    current = ""
    vowels = "aeiouyAEIOUY"
    for index, ch in enumerate(clean):
        current += ch
        next_char = clean[index + 1] if index + 1 < len(clean) else ""
        if ch in vowels and next_char and next_char not in vowels:
            chunks.append(current)
            current = ""

    if current:
        chunks.append(current)

    if len(chunks) <= 1:
        chunks = [clean[i:i + 3] for i in range(0, len(clean), 3)]

    return "-".join(chunks)


def fallback_breakdown_text(transcription: str) -> str:
    words = transcription.split()
    transformed = [_syllable_break_word(word) for word in words]
    return " ".join(transformed).strip() or _normalize_text(transcription)


def fallback_detailed_steps(transcription: str) -> str:
    sentences = _split_sentences(transcription)
    if not sentences:
        return "1. Review the main lecture topic.\n2. Practice with short examples.\n3. Revise key terms."

    limited = sentences[:6]
    steps = [f"{index + 1}. {sentence}" for index, sentence in enumerate(limited)]
    return "\n".join(steps)


def fallback_mind_map(transcription: str) -> str:
    sentences = _split_sentences(transcription)
    topic_source = sentences[0] if sentences else _normalize_text(transcription)
    topic_words = topic_source.split()
    topic = " ".join(topic_words[:6]).strip() or "Lecture Topic"

    points_source = sentences[1:5] if len(sentences) > 1 else [topic_source]
    points = [re.sub(r'\s+', ' ', p).strip()[:80] for p in points_source if p.strip()]
    while len(points) < 3:
        points.append("Review examples")

    return "\n".join([
        topic,
        f"|- {points[0]}",
        f"|- {points[1]}",
        f"`- {points[2]}",
    ])


def fallback_summary(transcription: str) -> str:
    sentences = _split_sentences(transcription)
    if not sentences:
        return "Summary unavailable. Please review the transcription and try processing again."

    if len(sentences) == 1:
        return sentences[0][:240]

    return f"{sentences[0]} {sentences[1]}"[:320]


def _clamp_score(value: float) -> int:
    return max(0, min(100, int(round(value))))


def _extract_spelling_hints(text: str, max_items: int = 10) -> list:
    hints = []
    seen = set()
    for token in (text or "").split():
        wrong = token.strip()
        cleaned = re.sub(r"[^A-Za-z']", "", wrong)
        if not wrong or not cleaned:
            continue
        if cleaned.lower() == wrong.lower():
            continue
        dedupe_key = wrong.lower()
        if dedupe_key in seen:
            continue

        seen.add(dedupe_key)
        if re.search(r"(.)\1{2,}", cleaned, flags=re.IGNORECASE):
            hint_type = "extra_letter"
        elif "_" in wrong or "-" in wrong:
            hint_type = "missing_letter"
        else:
            hint_type = "misspelling"

        hints.append({
            "wrong": wrong[:40],
            "correct": cleaned[:40],
            "type": hint_type,
        })
        if len(hints) >= max_items:
            break

    return hints


def build_handwriting_fallback_result(extracted_text: str, avg_confidence: float, extracted_lines: list, reason: str = "") -> dict:
    """Build a deterministic OCR-only analysis payload when Gemini is unavailable."""
    normalized_text = _normalize_text(extracted_text)
    if not normalized_text:
        normalized_text = "No readable text could be extracted from the image."

    tokens = normalized_text.split()
    token_count = len(tokens)
    noisy_tokens = sum(1 for t in tokens if re.search(r"[^A-Za-z']", t))
    noise_ratio = (noisy_tokens / token_count) if token_count else 0.0
    confidence = max(0.0, min(1.0, float(avg_confidence or 0.0)))

    category_scores = {
        "letterFormation": _clamp_score(35 + (confidence * 50) - (noise_ratio * 20)),
        "spacing": _clamp_score(38 + (confidence * 48) - (noise_ratio * 10)),
        "alignment": _clamp_score(36 + (confidence * 46) - (noise_ratio * 8)),
        "spelling": _clamp_score(78 - ((1 - confidence) * 30) - (noise_ratio * 45)),
        "sizing": _clamp_score(40 + (confidence * 44) - (noise_ratio * 6)),
        "legibility": _clamp_score(30 + (confidence * 60) - (noise_ratio * 12)),
    }

    weights = {
        "letterFormation": 0.25,
        "spacing": 0.15,
        "alignment": 0.15,
        "spelling": 0.25,
        "sizing": 0.10,
        "legibility": 0.10,
    }
    score = _clamp_score(sum(category_scores[k] * w for k, w in weights.items()))

    spelling_hints = _extract_spelling_hints(extracted_text)
    errors = []

    if confidence < 0.55:
        errors.append({
            "type": "Low OCR confidence",
            "severity": "medium",
            "word": "",
            "correction": "",
            "description": f"OCR confidence is {confidence:.2f}, so analysis may miss details.",
            "suggestion": "Retake the photo with better lighting and keep the page flat.",
        })

    if noise_ratio > 0.25:
        errors.append({
            "type": "Irregular character patterns",
            "severity": "medium",
            "word": "",
            "correction": "",
            "description": "Detected many symbols/merged words in extracted text.",
            "suggestion": "Increase spacing between words and letters while writing.",
        })

    for item in spelling_hints[:3]:
        errors.append({
            "type": "Spelling pattern",
            "severity": "low",
            "word": item["wrong"],
            "correction": item["correct"],
            "description": "Possible spelling or character-order issue from OCR text.",
            "suggestion": "Practice slow copy-writing and verify each word after writing.",
        })

    if not errors:
        errors.append({
            "type": "Minor consistency checks",
            "severity": "low",
            "word": "",
            "correction": "",
            "description": "No major issues detected in fallback analysis.",
            "suggestion": "Keep practicing uniform letter size and spacing.",
        })

    strengths = []
    if category_scores["legibility"] >= 65:
        strengths.append("Overall readability is reasonably clear.")
    if category_scores["spacing"] >= 60:
        strengths.append("Word spacing is mostly consistent.")
    if category_scores["spelling"] >= 60:
        strengths.append("Most words appear close to correct form.")
    if not strengths:
        strengths.append("You provided enough text for baseline handwriting feedback.")

    recommendations = []
    if category_scores["letterFormation"] < 60:
        recommendations.append({
            "title": "Letter formation drills",
            "description": "Practice b/d and p/q pairs using tracing sheets for 10 minutes daily.",
            "priority": "high",
        })
    if category_scores["spacing"] < 60 or category_scores["alignment"] < 60:
        recommendations.append({
            "title": "Spacing and baseline control",
            "description": "Write on ruled paper and leave one finger-space between words.",
            "priority": "medium",
        })
    if category_scores["spelling"] < 60:
        recommendations.append({
            "title": "Word-building practice",
            "description": "Break words into syllables and read aloud before writing.",
            "priority": "medium",
        })
    if not recommendations:
        recommendations.append({
            "title": "Maintain current progress",
            "description": "Continue short daily writing practice to improve consistency.",
            "priority": "low",
        })

    short_reason = _normalize_text(reason)[:180]
    summary = f"Fallback OCR-based analysis completed. Confidence {confidence:.2f}."
    if short_reason:
        summary = f"{summary} AI service note: {short_reason}"

    return {
        "score": score,
        "extractedText": normalized_text[:700],
        "summary": summary,
        "categoryScores": category_scores,
        "errors": errors[:8],
        "spellingErrors": spelling_hints,
        "strengths": strengths,
        "recommendations": recommendations,
        "analysisSource": "ocr-fallback",
        "ocrConfidence": round(confidence, 2),
        "detectedTextRegions": len(extracted_lines or []),
    }


def safe_generate_with_fallback(prompt: str, system: str, fallback_value: str, label: str, errors: list) -> str:
    """Try Gemini generation and fall back to deterministic output when unavailable."""
    try:
        return generate_with_gemini(prompt, system)
    except Exception as exc:
        error_msg = f"{label}: {str(exc)}"
        errors.append(error_msg)
        print(f"[WARN] Using fallback for {label}. Reason: {exc}")
        return fallback_value

def _throttle_gemini():
    """Ensure minimum interval between Gemini API calls to respect rate limits."""
    global _last_gemini_call
    with _gemini_lock:
        now = time.time()
        elapsed = now - _last_gemini_call
        if elapsed < MIN_CALL_INTERVAL:
            wait = MIN_CALL_INTERVAL - elapsed
            print(f"[WAIT] Throttling Gemini text call, waiting {wait:.1f}s...")
            time.sleep(wait)
        _last_gemini_call = time.time()

def _throttle_vision():
    """Stricter throttling for Vision API (free tier is very rate-limited)."""
    global _last_vision_call
    with _gemini_lock:
        now = time.time()
        elapsed = now - _last_vision_call
        if elapsed < MIN_VISION_INTERVAL:
            wait = MIN_VISION_INTERVAL - elapsed
            print(f"[WAIT] Throttling Vision API call, waiting {wait:.1f}s...")
            time.sleep(wait)
        _last_vision_call = time.time()


def generate_with_gemini(prompt: str, system: str = None, stream: bool = False) -> str:
    """Generate text using Google Gemini native REST API with retry for rate limits"""
    headers = {"Content-Type": "application/json"}
    
    # Build contents array
    if system:
        prompt = f"{system}\n\n{prompt}"
    
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 2048
        }
    }

    max_retries = 2
    for attempt in range(max_retries):
        try:
            _throttle_gemini()
            url = f"{GEMINI_API_BASE}/{GEMINI_MODEL}:generateContent?key={_get_gemini_key()}"
            response = requests.post(url, headers=headers, json=payload, timeout=30)

            if response.status_code == 429:
                _rotate_gemini_key()
                retry_after = response.headers.get('Retry-After')
                if retry_after:
                    wait_time = min(int(retry_after), 20)
                else:
                    wait_time = min((2 ** attempt) * 5, 20)  # 5s, 10s
                print(f"[RATE] Rate limited (attempt {attempt+1}/{max_retries}), waiting {wait_time}s...")
                time.sleep(wait_time)
                continue
            
            if response.status_code != 200:
                print(f"[ERROR] Gemini API Error {response.status_code}: {response.text}")
                raise RuntimeError(f"Gemini API error {response.status_code}: {response.text}")

            data = response.json()
            candidates = data.get('candidates', [])
            if not candidates:
                raise RuntimeError(f"Gemini returned no candidates (possible safety block): {data}")
            content = candidates[0].get('content', {})
            parts = content.get('parts', [])
            if not parts:
                raise RuntimeError(f"Gemini candidate has no parts: {candidates[0]}")
            return parts[0]['text']

        except requests.exceptions.RequestException as e:
            print(f"Gemini API error: {e}")
            if attempt < max_retries - 1:
                time.sleep(3)
                continue
            raise RuntimeError(f"Gemini processing failed: {str(e)}")

    raise RuntimeError("Gemini API rate limit exceeded after all retries. Please wait 1-2 minutes and try again.")

@app.post("/api/lectures")
async def create_lecture(lecture: LectureCreate):
    """Create a new lecture with transcription"""
    try:
        if db is None:
            lecture_data = _create_lecture_fallback(lecture.userId, lecture.transcription)
            return lecture_data

        try:
            lecture_data = {
                "userId": lecture.userId,
                "transcription": lecture.transcription,
                "simpleText": "",
                "detailedSteps": "",
                "mindMap": "",
                "summary": "",
                "createdAt": datetime.now(),
                "updatedAt": datetime.now()
            }

            doc_ref = db.collection("lectures").document()
            doc_ref.set(lecture_data)

            return {"id": doc_ref.id, **lecture_data}
        except Exception as firestore_err:
            print(f"[WARN] Firestore create failed, using fallback: {firestore_err}")
            lecture_data = _create_lecture_fallback(lecture.userId, lecture.transcription)
            return lecture_data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/lectures/{lecture_id}")
async def get_lecture(lecture_id: str):
    """Get a specific lecture"""
    try:
        if db is None:
            lecture_data = _get_lecture_fallback(lecture_id)
            if not lecture_data:
                raise HTTPException(status_code=404, detail="Lecture not found")
            return lecture_data

        try:
            doc = db.collection("lectures").document(lecture_id).get()
            if not doc.exists:
                raise HTTPException(status_code=404, detail="Lecture not found")

            data = doc.to_dict()
            return {"id": doc.id, **data}
        except HTTPException:
            raise
        except Exception as firestore_err:
            print(f"[WARN] Firestore fetch failed, using fallback: {firestore_err}")
            lecture_data = _get_lecture_fallback(lecture_id)
            if lecture_data:
                return lecture_data
            raise HTTPException(status_code=500, detail=str(firestore_err))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/lectures/user/{user_id}/latest")
async def get_latest_lecture(user_id: str):
    """Get the latest lecture for a user"""
    try:
        if db is None:
            lecture_data = _get_latest_lecture_fallback(user_id)
            if lecture_data:
                return lecture_data
            raise HTTPException(status_code=404, detail="No lectures found")

        # Prefer server-side ordering for performance, but gracefully fallback if
        # the required composite index is missing.
        try:
            docs = db.collection("lectures")\
                .where("userId", "==", user_id)\
                .order_by("createdAt", direction=firestore.Query.DESCENDING)\
                .limit(1)\
                .stream()
            for doc in docs:
                data = doc.to_dict()
                return {"id": doc.id, **data}
        except Exception as query_error:
            if "requires an index" not in str(query_error).lower():
                raise

            docs = db.collection("lectures")\
                .where("userId", "==", user_id)\
                .stream()

            latest_doc = None
            latest_created_at = float("-inf")

            for doc in docs:
                data = doc.to_dict() or {}
                created_at = data.get("createdAt")
                if isinstance(created_at, datetime):
                    if created_at.tzinfo is None:
                        created_at = created_at.replace(tzinfo=timezone.utc)
                    created_at_value = created_at.timestamp()
                else:
                    created_at_value = float("-inf")

                if created_at_value >= latest_created_at:
                    latest_created_at = created_at_value
                    latest_doc = doc

            if latest_doc is not None:
                data = latest_doc.to_dict() or {}
                return {"id": latest_doc.id, **data}
        
        raise HTTPException(status_code=404, detail="No lectures found")
    except HTTPException:
        raise
    except Exception as firestore_err:
        print(f"[WARN] Firestore latest lookup failed, using fallback: {firestore_err}")
        lecture_data = _get_latest_lecture_fallback(user_id)
        if lecture_data:
            return lecture_data
        raise HTTPException(status_code=500, detail=str(firestore_err))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/lectures/{lecture_id}/process")
async def process_lecture(lecture_id: str):
    """Process lecture transcription through Gemini AI with chunking for faster processing"""
    try:
        # Get the lecture
        if db is None:
            data = _get_lecture_fallback(lecture_id)
            if not data:
                raise HTTPException(status_code=404, detail="Lecture not found")
        else:
            try:
                doc = db.collection("lectures").document(lecture_id).get()
                if not doc.exists:
                    raise HTTPException(status_code=404, detail="Lecture not found")
                data = doc.to_dict()
            except HTTPException:
                raise
            except Exception as firestore_err:
                print(f"[WARN] Firestore fetch failed, using fallback: {firestore_err}")
                data = _get_lecture_fallback(lecture_id)
                if not data:
                    raise HTTPException(status_code=500, detail=str(firestore_err))
        transcription = data.get("transcription", "")
        
        if not transcription:
            raise HTTPException(status_code=400, detail="No transcription to process")
        
        print(f"[START] Processing lecture {lecture_id}...")
        start_time = time.time()
        generation_errors = []
        
        # OPTIMIZED PROMPTS - SHORTER = FASTER
        breakdown_prompt = f"""Break down by splitting words into syllables with hyphens. Keep sentences intact.

Example: "Photosynthesis is the process" → "Pho-to-syn-the-sis is the pro-cess"

Text to process:
{transcription}

Output only the syllable breakdown, no explanations:"""
        
        steps_prompt = f"""Break this lecture into clear, numbered steps (max 5-7 steps). Each step should be concise and actionable.

Text:
{transcription}

Output only the numbered steps, no extra text:"""
        
        mindmap_prompt = f"""Create a brief mind map with main topic and 3-4 key points only.

Text:
{transcription}

Format:
Main Topic
├─ Point 1
├─ Point 2
└─ Point 3

Keep it short:"""
        
        summary_prompt = f"""Summarize in 2-3 sentences: main topic, key points, and conclusion.

Text:
{transcription}

Summary:"""
        
        print("[PROC] Processing outputs with Gemini + fallback...")

        fallback_breakdown = fallback_breakdown_text(transcription)
        fallback_steps = fallback_detailed_steps(transcription)
        fallback_mindmap = fallback_mind_map(transcription)
        fallback_summary_text = fallback_summary(transcription)

        breakdown_text = safe_generate_with_fallback(
            breakdown_prompt,
            "Break words into syllables. Output only the result.",
            fallback_breakdown,
            "simpleText",
            generation_errors,
        )
        detailed_steps = safe_generate_with_fallback(
            steps_prompt,
            "Create numbered steps. Be concise.",
            fallback_steps,
            "detailedSteps",
            generation_errors,
        )
        mind_map = safe_generate_with_fallback(
            mindmap_prompt,
            "Create a brief mind map. Keep it very short.",
            fallback_mindmap,
            "mindMap",
            generation_errors,
        )
        summary = safe_generate_with_fallback(
            summary_prompt,
            "Write a 2-3 sentence summary.",
            fallback_summary_text,
            "summary",
            generation_errors,
        )
        
        elapsed_time = time.time() - start_time
        print(f"[DONE] Processing complete in {elapsed_time:.1f} seconds!")
        
        # Update Firestore
        update_data = {
            "simpleText": breakdown_text,
            "detailedSteps": detailed_steps,
            "mindMap": mind_map,
            "summary": summary,
            "updatedAt": datetime.now(),
            "processingTime": elapsed_time,
            "processingFallbackUsed": len(generation_errors) > 0,
            "processingErrors": generation_errors,
        }
        
        if db is None:
            _update_lecture_fallback(lecture_id, update_data)
        else:
            try:
                db.collection("lectures").document(lecture_id).update(update_data)
            except Exception as firestore_err:
                print(f"[WARN] Firestore update failed, using fallback: {firestore_err}")
                _update_lecture_fallback(lecture_id, update_data)
        
        print("Done! Saved to Firestore.")
        return {
            "id": lecture_id,
            "simpleText": breakdown_text,
            "detailedSteps": detailed_steps,
            "mindMap": mind_map,
            "summary": summary,
            "processingTime": elapsed_time,
            "usedFallback": len(generation_errors) > 0,
            "errors": generation_errors,
        }
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Error processing lecture: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.patch("/api/lectures/{lecture_id}")
async def update_lecture(lecture_id: str, updates: LectureUpdate):
    """Update lecture fields"""
    try:
        update_data = {k: v for k, v in updates.dict().items() if v is not None}
        update_data["updatedAt"] = datetime.now()

        if db is None:
            lecture_data = _update_lecture_fallback(lecture_id, update_data)
            if not lecture_data:
                raise HTTPException(status_code=404, detail="Lecture not found")
            return lecture_data

        try:
            db.collection("lectures").document(lecture_id).update(update_data)

            doc = db.collection("lectures").document(lecture_id).get()
            data = doc.to_dict()
            return {"id": doc.id, **data}
        except Exception as firestore_err:
            print(f"[WARN] Firestore update failed, using fallback: {firestore_err}")
            lecture_data = _update_lecture_fallback(lecture_id, update_data)
            if not lecture_data:
                raise HTTPException(status_code=500, detail=str(firestore_err))
            return lecture_data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/lectures/{lecture_id}")
async def delete_lecture(lecture_id: str):
    """Delete a lecture"""
    try:
        if db is None:
            if not _delete_lecture_fallback(lecture_id):
                raise HTTPException(status_code=404, detail="Lecture not found")
            return {"message": "Lecture deleted successfully"}

        try:
            db.collection("lectures").document(lecture_id).delete()
            return {"message": "Lecture deleted successfully"}
        except Exception as firestore_err:
            print(f"[WARN] Firestore delete failed, using fallback: {firestore_err}")
            if not _delete_lecture_fallback(lecture_id):
                raise HTTPException(status_code=500, detail=str(firestore_err))
            return {"message": "Lecture deleted successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/lectures/user/{user_id}")
async def get_user_lectures(user_id: str):
    """Get all lectures for a user"""
    try:
        if db is None:
            return _get_user_lectures_fallback(user_id)

        lectures = []

        try:
            docs = db.collection("lectures")\
                .where("userId", "==", user_id)\
                .order_by("createdAt", direction=firestore.Query.DESCENDING)\
                .stream()

            for doc in docs:
                data = doc.to_dict()
                lectures.append({"id": doc.id, **data})
        except Exception as query_error:
            if "requires an index" not in str(query_error).lower():
                raise

            docs = db.collection("lectures")\
                .where("userId", "==", user_id)\
                .stream()

            for doc in docs:
                data = doc.to_dict() or {}
                lectures.append({"id": doc.id, **data})

            def _lecture_created_at_sort_key(lecture):
                created_at = lecture.get("createdAt")
                if not isinstance(created_at, datetime):
                    return float("-inf")
                if created_at.tzinfo is None:
                    created_at = created_at.replace(tzinfo=timezone.utc)
                return created_at.timestamp()

            lectures.sort(key=_lecture_created_at_sort_key, reverse=True)
        
        return lectures
    except Exception as firestore_err:
        print(f"[WARN] Firestore user lectures failed, using fallback: {firestore_err}")
        return _get_user_lectures_fallback(user_id)

@app.post("/api/transcribe-audio")
async def transcribe_audio(file: UploadFile = File(...)):
    """
    Transcribe audio file using AssemblyAI
    Requires ASSEMBLYAI_API_KEY in environment variables
    """
    try:
        # Get API key from environment
        api_key = os.getenv("ASSEMBLYAI_API_KEY")
        if not api_key:
            raise HTTPException(
                status_code=500, 
                detail="AssemblyAI API key not configured. Set ASSEMBLYAI_API_KEY in environment variables."
            )
        
        # Read file content
        file_content = await file.read()
        
        # Upload audio to AssemblyAI
        headers = {"authorization": api_key}
        loop = asyncio.get_event_loop()
        upload_response = await loop.run_in_executor(
            None, lambda: requests.post(
                "https://api.assemblyai.com/v2/upload",
                headers=headers,
                data=file_content
            )
        )
        
        if upload_response.status_code != 200:
            raise HTTPException(status_code=500, detail="Failed to upload audio file")
        
        audio_url = upload_response.json()["upload_url"]
        
        # Request transcription
        transcript_request = {
            "audio_url": audio_url,
            "language_code": "en"
        }
        
        transcript_response = await loop.run_in_executor(
            None, lambda: requests.post(
                "https://api.assemblyai.com/v2/transcript",
                headers=headers,
                json=transcript_request
            )
        )
        
        if transcript_response.status_code != 200:
            raise HTTPException(status_code=500, detail="Failed to request transcription")
        
        transcript_id = transcript_response.json()["id"]
        
        # Poll for transcription completion
        polling_endpoint = f"https://api.assemblyai.com/v2/transcript/{transcript_id}"
        max_attempts = 60  # 5 minutes max
        attempt = 0
        
        while attempt < max_attempts:
            polling_response = await loop.run_in_executor(
                None, lambda: requests.get(polling_endpoint, headers=headers)
            )
            transcription_result = polling_response.json()

            if transcription_result["status"] == "completed":
                return {
                    "transcription": transcription_result["text"],
                    "confidence": transcription_result.get("confidence", 0),
                    "words": len(transcription_result["text"].split())
                }
            elif transcription_result["status"] == "error":
                raise HTTPException(
                    status_code=500,
                    detail=f"Transcription failed: {transcription_result.get('error', 'Unknown error')}"
                )

            # Wait before polling again
            await asyncio.sleep(5)
            attempt += 1
        
        raise HTTPException(status_code=408, detail="Transcription timeout. Please try again.")
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"Transcription error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")


# ============================================
# NEW ENDPOINTS: Handwriting, Content, Analytics
# ============================================

import base64

class ContentTransformRequest(BaseModel):
    text: str
    userId: str = "anonymous"

class RecommendationRequest(BaseModel):
    userId: str
    readingSessions: int = 0
    avgQuizScore: float = 0
    handwritingErrors: int = 0


@app.post("/api/handwriting/analyze")
async def analyze_handwriting(file: UploadFile = File(...), userId: str = "anonymous"):
    """
    Analyze handwriting image for dyslexia-related errors using OCR + Gemini Text API.
    Returns detailed scoring, extracted text, error highlights, and improvement tips.
    Uses OCR for text extraction (reliable) + Text API for analysis (better rate limits).
    """
    try:
        import easyocr

        file_content = await file.read()

        # Validate file size (50 MB limit)
        if len(file_content) > 50 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="File size exceeds 50 MB limit.")

        cache_key = _handwriting_cache_key(file_content)
        cached = _get_handwriting_cache(cache_key)
        if cached:
            cached_result = dict(cached["result"])
            cached_result["cached"] = True
            cached_result["cacheAgeSec"] = round(cached["age"], 1)
            print(f"[CACHE] Handwriting hit ({cached_result['cacheAgeSec']}s old)")
            return cached_result
        
        # ── Enhance image for better OCR ──────────────────────────────────
        try:
            if Image is None:
                raise ImportError("Pillow not installed")
            img = Image.open(BytesIO(file_content))
            if img.mode != 'RGB':
                img = img.convert('RGB')
            img = ImageEnhance.Contrast(img).enhance(1.5)
            img = ImageEnhance.Sharpness(img).enhance(2.0)
            img = ImageEnhance.Brightness(img).enhance(1.1)

            # Save enhanced image to temp file for OCR
            import tempfile
            import os as os_module
            with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tmp:
                img.save(tmp, format='JPEG', quality=95)
                tmp_path = tmp.name

            print(f"[IMG] Image enhanced: {img.size[0]}x{img.size[1]}")

            # ── Extract text using OCR ───────────────────────────────────
            print("[OCR] Starting text extraction with EasyOCR...")
            loop = asyncio.get_event_loop()

            # Run OCR in executor to avoid blocking
            def run_ocr():
                reader = easyocr.Reader(['en'], gpu=False)
                results = reader.readtext(tmp_path)
                # Extract text and confidence
                extracted_lines = []
                for detection in results:
                    text = detection[1]
                    confidence = detection[2]
                    extracted_lines.append({"text": text, "confidence": confidence})
                return extracted_lines

            extracted_lines = await loop.run_in_executor(None, run_ocr)

            # Join extracted text
            full_extracted_text = " ".join([line["text"] for line in extracted_lines])
            avg_confidence = sum(line["confidence"] for line in extracted_lines) / len(extracted_lines) if extracted_lines else 0

            print(f"[OCR] Extracted {len(full_extracted_text)} chars, confidence: {avg_confidence:.2f}")
            print(f"[OCR] Text: {full_extracted_text[:200]}...")

            # Clean up temp file
            try:
                os_module.unlink(tmp_path)
            except:
                pass

        except ImportError:
            raise HTTPException(status_code=500, detail="EasyOCR not installed. Run: pip install easyocr")
        except Exception as ocr_err:
            print(f"[ERROR] OCR extraction failed: {ocr_err}")
            raise HTTPException(status_code=500, detail=f"Text extraction failed: {str(ocr_err)}")
        
        # ── Prepare Text API analysis with extracted text ──────────────────
        print("[TEXT_API] Preparing handwriting analysis with Gemini Text API...")

        # Build analysis metadata from OCR results
        text_quality = "high" if avg_confidence > 0.8 else "medium" if avg_confidence > 0.6 else "low"

        system_prompt = """You are a dyslexia handwriting analyst. Analyze the extracted handwriting text and respond with ONLY a JSON object (no markdown, no code fences, no extra text).

Instructions:
1. Extract all text from the provided text as "extractedText" (keep it concise — max 300 chars, truncate with ... if longer)
2. Score each category 0-100 independently (vary scores based on actual quality):
   - letterFormation: letter shapes, b/d p/q reversals (infer from spelling/text patterns)
   - spacing: letter/word/line spacing consistency (infer from OCR quality)
   - alignment: baseline, slant uniformity (infer from OCR confidence and layout)
   - spelling: correct spelling (flag every error found in text)
   - sizing: letter size consistency (infer from OCR detections)
   - legibility: overall readability (use OCR confidence as proxy)
3. Overall score = weighted avg: letterFormation 25%, spacing 15%, alignment 15%, spelling 25%, sizing 10%, legibility 10%
4. List errors (max 8 most important) and spelling errors (max 10)
5. Keep all descriptions SHORT (under 50 chars each)

JSON format — output ONLY this, nothing else:
{"score":N,"extractedText":"...","summary":"...","categoryScores":{"letterFormation":N,"spacing":N,"alignment":N,"spelling":N,"sizing":N,"legibility":N},"errors":[{"type":"...","severity":"high|medium|low","word":"...","correction":"...","description":"...","suggestion":"..."}],"spellingErrors":[{"wrong":"...","correct":"...","type":"misspelling|abbreviation|missing_letter|extra_letter|transposition"}],"strengths":["..."],"recommendations":[{"title":"...","description":"...","priority":"high|medium|low"}]}"""

        user_prompt = f"""Analyze this handwriting text extracted by OCR:

EXTRACTED TEXT:
"{full_extracted_text}"

OCR QUALITY METRICS:
- Text Quality: {text_quality}
- OCR Confidence: {avg_confidence:.2f}/1.0
- Detected Text Regions: {len(extracted_lines)}

Score each category independently (NOT all same scores). Find and flag spelling errors. Keep descriptions SHORT. Output ONLY valid JSON, no markdown fences."""

        headers = {"Content-Type": "application/json"}

        payload = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": f"{system_prompt}\n\n{user_prompt}"}
                    ]
                }
            ],
            "generationConfig": {
                "temperature": 0.2,
                "maxOutputTokens": 2048,
                "responseMimeType": "application/json"
            }
        }

        # Retry with exponential backoff for rate limits. If AI is down, return OCR fallback.
        result_text = None
        fallback_reason = ""
        max_retries = 3

        if not _all_gemini_keys:
            fallback_reason = "No Gemini API key configured on backend."
            print("[FALLBACK] No Gemini API key configured. Using OCR-only analysis.")
        else:
            for attempt in range(max_retries):
                _throttle_gemini()

                try:
                    attempt_url = f"{GEMINI_API_BASE}/{GEMINI_MODEL}:generateContent?key={_get_gemini_key()}"
                except RuntimeError as key_err:
                    fallback_reason = str(key_err)
                    print(f"[FALLBACK] {fallback_reason}")
                    break

                try:
                    loop = asyncio.get_event_loop()
                    response = await loop.run_in_executor(
                        None, lambda: requests.post(attempt_url, headers=headers, json=payload, timeout=30)
                    )
                except requests.exceptions.RequestException as req_err:
                    fallback_reason = f"Network error while calling Gemini: {req_err}"
                    print(f"[WARN] Text API request failed (attempt {attempt+1}/{max_retries}): {req_err}")
                    if attempt < max_retries - 1:
                        await asyncio.sleep(2)
                        continue
                    break

                if response.status_code == 429:
                    _rotate_gemini_key()
                    wait_time = min((2 ** attempt) * 2, 10)
                    fallback_reason = "Gemini rate limited all retry attempts."
                    print(f"[RATE] Text API rate limited (attempt {attempt+1}/{max_retries}), waiting {wait_time}s...")
                    await asyncio.sleep(wait_time)
                    continue

                if response.status_code == 503:
                    wait_time = min((2 ** attempt) * 2, 6)
                    fallback_reason = "Gemini service unavailable after retries."
                    print(f"[UNAVAIL] Gemini Text API unavailable (attempt {attempt+1}/{max_retries}), waiting {wait_time}s...")
                    await asyncio.sleep(wait_time)
                    continue

                if response.status_code >= 500:
                    fallback_reason = f"Gemini server error {response.status_code}."
                    wait_time = min((2 ** attempt), 6)
                    print(f"[WARN] Gemini server error {response.status_code} (attempt {attempt+1}/{max_retries})")
                    if attempt < max_retries - 1:
                        await asyncio.sleep(wait_time)
                        continue
                    break

                if response.status_code != 200:
                    fallback_reason = f"Gemini request rejected ({response.status_code})."
                    print(f"[ERROR] Gemini Text API Error: {response.status_code} - {response.text[:240]}")
                    break

                try:
                    response_json = response.json()
                    result_text = response_json["candidates"][0]["content"]["parts"][0]["text"]
                    break
                except Exception as shape_err:
                    fallback_reason = f"Gemini response format was unexpected: {shape_err}"
                    print(f"[WARN] Unexpected Gemini response shape (attempt {attempt+1}/{max_retries}): {shape_err}")
                    if attempt < max_retries - 1:
                        await asyncio.sleep(1)
                        continue
                    break

        if result_text is None:
            result = build_handwriting_fallback_result(
                full_extracted_text,
                avg_confidence,
                extracted_lines,
                fallback_reason or "Gemini Text API unavailable.",
            )
        else:
            # Parse the JSON response
            try:
                # Strip markdown code fences if present (```json ... ``` or ``` ... ```)
                cleaned = result_text.strip()
                if cleaned.startswith("```"):
                    # Remove opening fence (```json or ```)
                    first_newline = cleaned.index('\n')
                    cleaned = cleaned[first_newline + 1:]
                if cleaned.endswith("```"):
                    cleaned = cleaned[:-3]
                cleaned = cleaned.strip()

                # Try to extract JSON from the cleaned response
                json_start = cleaned.find('{')
                json_end = cleaned.rfind('}') + 1
                if json_start >= 0 and json_end > json_start:
                    json_str = cleaned[json_start:json_end]
                else:
                    json_str = cleaned

                print(f"[PARSE] Parsing JSON response ({len(json_str)} chars)...")
                result = json.loads(json_str)
                print(f"[OK] Parsed successfully. Score from AI: {result.get('score', 'N/A')}")

                # Use AI's category scores directly — do NOT override with defaults
                if "categoryScores" in result and isinstance(result["categoryScores"], dict):
                    cats = result["categoryScores"]
                    # Recompute the overall score from category scores for consistency
                    weights = {
                        "letterFormation": 0.25, "spacing": 0.15, "alignment": 0.15,
                        "spelling": 0.25, "sizing": 0.10, "legibility": 0.10
                    }
                    computed_score = sum(cats.get(k, cats.get(k, 50)) * w for k, w in weights.items())
                    result["score"] = round(computed_score)
                    print(f"[SCORE] Category scores: {cats}")
                    print(f"[SCORE] Computed weighted score: {result['score']}")

                # Only fill truly missing fields — do NOT overwrite AI-provided values
                result.setdefault("extractedText", "")
                result.setdefault("summary", "Analysis complete.")
                if "categoryScores" not in result:
                    # Only use defaults if AI completely failed to provide category scores
                    result["categoryScores"] = {
                        "letterFormation": result.get("score", 50),
                        "spacing": result.get("score", 50),
                        "alignment": result.get("score", 50),
                        "spelling": result.get("score", 50),
                        "sizing": result.get("score", 50),
                        "legibility": result.get("score", 50),
                    }
                result.setdefault("errors", [])
                result.setdefault("spellingErrors", [])
                result.setdefault("strengths", [])
                result.setdefault("recommendations", [])

            except (json.JSONDecodeError, ValueError) as parse_err:
                print(f"[ERROR] JSON parse failed: {parse_err}")
                print(f"[ERROR] Raw response (first 500 chars): {result_text[:500]}")

                # Try to repair truncated JSON
                try:
                    import re as regex_module

                    # Strategy 1: Find the JSON and try to repair truncation
                    json_match = regex_module.search(r'\{[\s\S]*', result_text)
                    if json_match:
                        truncated = json_match.group()
                        # Remove control characters
                        truncated = regex_module.sub(r'[\x00-\x1f\x7f-\x9f]', ' ', truncated)

                        # Try to repair: close any unclosed strings and brackets
                        repaired = truncated.rstrip()
                        # If it ends mid-string, close the string
                        if repaired.count('"') % 2 != 0:
                            repaired += '"'
                        # Count open/close brackets and close any unclosed ones
                        open_brackets = repaired.count('{') - repaired.count('}')
                        open_arrays = repaired.count('[') - repaired.count(']')
                        # Close arrays first, then objects
                        repaired += ']' * max(0, open_arrays)
                        repaired += '}' * max(0, open_brackets)

                        result = json.loads(repaired)
                        print(f"[OK] Recovered truncated JSON. Score: {result.get('score', 'N/A')}")
                        result.setdefault("extractedText", "")
                        result.setdefault("summary", "Analysis complete (response was truncated).")
                        result.setdefault("categoryScores", {})
                        result.setdefault("errors", [])
                        result.setdefault("spellingErrors", [])
                        result.setdefault("strengths", [])
                        result.setdefault("recommendations", [])
                    else:
                        raise ValueError("No JSON object found in response")
                except Exception as repair_err:
                    print(f"[ERROR] JSON repair also failed: {repair_err}")
                    # Extract what we can using regex
                    score_match = re.search(r'"score"\s*:\s*(\d+)', result_text)
                    text_match = re.search(r'"extractedText"\s*:\s*"([^"]*)', result_text)
                    score_val = int(score_match.group(1)) if score_match else 50
                    text_val = text_match.group(1) if text_match else ""

                    # Try to extract category scores individually
                    cats = {}
                    for cat in ["letterFormation", "spacing", "alignment", "spelling", "sizing", "legibility"]:
                        cat_match = re.search(rf'"{cat}"\s*:\s*(\d+)', result_text)
                        cats[cat] = int(cat_match.group(1)) if cat_match else score_val

                    result = {
                        "score": score_val,
                        "extractedText": text_val,
                        "summary": "Analysis partially recovered from AI response.",
                        "categoryScores": cats,
                        "errors": [],
                        "spellingErrors": [],
                        "strengths": [],
                        "recommendations": [
                            {"title": "Try again", "description": "Upload a clearer photo with good lighting for more detailed analysis.", "priority": "medium"}
                        ]
                    }
                    print(f"[WARN] Regex fallback used. Score: {score_val}, Categories: {cats}")
        
        # Save to Firestore
        try:
            db.collection("handwritingUploads").add({
                "userId": userId,
                "score": result.get("score", 0),
                "errorCount": len(result.get("errors", [])),
                "errors": result.get("errors", []),
                "createdAt": datetime.now()
            })
        except Exception as save_err:
            print(f"Failed to save handwriting result: {save_err}")

        result["cached"] = False
        _set_handwriting_cache(cache_key, result)
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"Handwriting analysis error: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")


@app.post("/api/content/transform")
async def transform_content(request: ContentTransformRequest):
    """
    Transform educational content into multiple learning formats:
    NeuroLex notes, flashcards, quiz, mind map
    With fallback content if API calls fail
    """
    try:
        text = request.text
        if not text.strip():
            raise HTTPException(status_code=400, detail="No text provided")
        
        print(f"[TRANSFORM] Transforming content ({len(text)} chars)...")
        start_time = time.time()
        
        # Shortened text for fallback
        short_text = text[:200] if len(text) > 200 else text
        
        # Fallback content (simple, structured, no API needed)
        fallback_notes = f"""NeuroLex NOTES

Main Topic: {short_text[:80]}...

Key Points:
- Read the text carefully
- Look for important ideas
- Break them into smaller parts

Why This Matters:
Understanding the basic ideas helps you learn better and remember longer."""

        fallback_flashcards = """Q: What is the main topic?
A: The content covers important concepts you need to understand.

Q: Why should you study this?
A: Because it helps you learn and remember better."""

        fallback_quiz = """1. What is the main idea?
A. Not important
B. Something you need to learn (correct)
C. Only for smart students
D. A waste of time

2. How should you study?
A. Read and take notes (correct)
B. Do nothing
C. Ask someone else
D. Guess randomly"""

        fallback_mindmap = """Main Topic
├─ Key Ideas
│  ├─ Idea 1
│  └─ Idea 2
├─ Details
│  ├─ Detail 1
│  └─ Detail 2
└─ Examples
   ├─ Example 1
   └─ Example 2"""
        
        notes_prompt = f"""You are a teacher helping a dyslexic student understand this topic. Rewrite the content below in a way that is EASY to read and DETAILED enough to fully understand the topic.

Rules:
- Use simple, everyday words (no jargon)
- Write in short, clear sentences (max 15 words each)
- Use bullet points (start each point with a dash -)
- DO NOT use any markdown symbols like # or * or **
- Group related points under plain text headings (just capitalize the heading, no symbols)
- Explain every key concept — do not skip anything
- Add a brief "Why This Matters" section at the end
- The output should be at least 300 words and cover ALL the main ideas from the text
- Use line breaks between sections for easy reading

Text:
{text}

NeuroLex notes:"""
        
        flashcard_prompt = f"""Create 8-10 flashcards to help a dyslexic student learn this content.

Rules:
- Each question should test ONE key concept
- Keep questions clear and simple (no trick questions)
- Answers should be 1-2 sentences, easy to remember
- Use simple vocabulary
- Cover all the important topics in the text

Format EXACTLY like this (no extra text):
Q: What is photosynthesis?
A: It is the process plants use to make food from sunlight, water, and carbon dioxide.

Q: Why is photosynthesis important?
A: It produces oxygen that all living things need to breathe.

Text:
{text}

Flashcards:"""
        
        quiz_prompt = f"""Create a 5-question multiple choice quiz from this content to help a dyslexic student review.

Rules:
- Use simple, clear language in questions and options
- Each question should have exactly 4 options (A, B, C, D)
- Only ONE option per question is correct
- Mark the correct option by adding (correct) after it
- Make wrong options believable but clearly wrong if you know the material
- Cover different parts of the content

Format EXACTLY like this:

1. What does the heart do?
A. It helps you breathe
B. It pumps blood through your body (correct)
C. It digests food
D. It filters waste

2. Where is the heart located?
A. In your head
B. In your stomach
C. In your chest (correct)
D. In your back

Text:
{text}

Quiz:"""
        
        mindmap_prompt = f"""Create a detailed text-based mind map from this content with at least 4-5 main categories and 2-3 details under each.

Rules:
- Use simple words a dyslexic student can easily read
- Cover ALL the main topics from the text
- Each detail should be a short phrase (not full sentences)
- Use tree-drawing characters for the structure

Format EXACTLY like this:

Main Topic Name
├─ Category 1
│  ├─ Detail 1a
│  └─ Detail 1b
├─ Category 2
│  ├─ Detail 2a
│  ├─ Detail 2b
│  └─ Detail 2c
├─ Category 3
│  ├─ Detail 3a
│  └─ Detail 3b
└─ Category 4
   ├─ Detail 4a
   └─ Detail 4b

Text:
{text}

Mind Map:"""
        
        # Generate all 4 in parallel
        NeuroLex_notes = fallback_notes
        flashcards = fallback_flashcards
        quiz = fallback_quiz
        mind_map = fallback_mindmap

        with ThreadPoolExecutor(max_workers=4) as executor:
            nf = executor.submit(generate_with_gemini, notes_prompt,     "You are a patient dyslexia specialist teacher. Write detailed, easy-to-read notes. NO markdown symbols (no # or * or **). Use plain text with dashes for bullets. Be thorough -- cover every key point.")
            ff = executor.submit(generate_with_gemini, flashcard_prompt, "Create flashcards using ONLY Q: and A: format. No numbering, no extra text. Keep answers clear and simple.")
            qf = executor.submit(generate_with_gemini, quiz_prompt,      "Create a multiple choice quiz. Use simple language. Mark correct answer with (correct). Format exactly as shown.")
            mf = executor.submit(generate_with_gemini, mindmap_prompt,   "Create a detailed text mind map using tree characters (├─ │ └─). Use simple words. Be thorough.")

            for label, future in [("notes", nf), ("flashcards", ff), ("quiz", qf), ("mindmap", mf)]:
                try:
                    result = future.result()
                    if label == "notes":        NeuroLex_notes = result
                    elif label == "flashcards": flashcards = result
                    elif label == "quiz":       quiz = result
                    elif label == "mindmap":    mind_map = result
                    print(f"[OK] {label} generated")
                except Exception as e:
                    print(f"[WARN] {label} generation failed, using fallback: {e}")
                    traceback.print_exc()
        
        elapsed = time.time() - start_time
        print(f"[DONE] Content transformation complete in {elapsed:.1f}s")
        
        return {
            "NeuroLexNotes": NeuroLex_notes,
            "flashcards": flashcards,
            "quiz": quiz,
            "mindMap": mind_map,
            "processingTime": elapsed
        }
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Content transformation failed: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Transformation failed: {str(e)}")


@app.post("/api/analytics/recommend")
async def get_recommendations(request: RecommendationRequest):
    """Generate AI-powered learning recommendations based on user stats"""
    try:
        prompt = f"""Based on these learning statistics for a dyslexic student, provide 4-5 personalized practice recommendations:

- Reading sessions completed: {request.readingSessions}
- Average quiz score: {request.avgQuizScore}%
- Handwriting errors detected: {request.handwritingErrors}

Provide specific, actionable recommendations. Format as a JSON array:
[
  {{"title": "...", "description": "...", "priority": "high|medium|low"}}
]"""
        
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None, lambda: generate_with_gemini(prompt, "You are an educational psychologist specializing in dyslexia. Provide practical learning recommendations. Respond with valid JSON only.")
        )

        try:
            json_start = result.find('[')
            json_end = result.rfind(']') + 1
            recommendations = json.loads(result[json_start:json_end])
        except (json.JSONDecodeError, ValueError, TypeError):
            recommendations = [
                {"title": "Practice daily reading", "description": "Spend 15-20 minutes reading with the Reading Assistant.", "priority": "high"},
                {"title": "Review weak areas", "description": "Focus on topics where quiz scores are lowest.", "priority": "medium"},
            ]
        
        return {"recommendations": recommendations}
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Recommendation failed: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)



