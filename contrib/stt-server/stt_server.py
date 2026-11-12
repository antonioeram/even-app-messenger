"""Example speech-to-text server for the Even Messenger gateway.

The gateway only needs this contract:

    POST /stt?lang=<code|auto>     multipart form, file field "audio" (WAV)
    -> {"text": "...", "lang": "ro"}      or {"text": "", "error": "..."}

This example uses faster-whisper. Any server that honours the contract works.

    pip install fastapi uvicorn python-multipart faster-whisper
    WHISPER_MODEL=large-v3 uvicorn stt_server:app --host 0.0.0.0 --port 8770
"""

import os
import tempfile

from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "small")
DEVICE = os.environ.get("WHISPER_DEVICE", "auto")  # "cuda", "cpu" or "auto"

app = FastAPI()
model = WhisperModel(MODEL, device=DEVICE, compute_type=os.environ.get("WHISPER_COMPUTE", "default"))


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL}


@app.post("/stt")
async def stt(audio: UploadFile = File(...), lang: str = "auto"):
    with tempfile.NamedTemporaryFile(suffix=".wav") as wav:
        wav.write(await audio.read())
        wav.flush()
        try:
            segments, info = model.transcribe(wav.name, language=None if lang == "auto" else lang)
            text = "".join(segment.text for segment in segments).strip()
        except Exception as error:  # report the reason to the gateway instead of a bare 500
            return JSONResponse({"text": "", "error": str(error)})
    # Do not log the text: it is someone's private message.
    return {"text": text, "lang": info.language}
