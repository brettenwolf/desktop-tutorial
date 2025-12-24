from fastapi import FastAPI, APIRouter, HTTPException, UploadFile, File
from fastapi.responses import Response, JSONResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional
import uuid
from datetime import datetime, timedelta
import base64
import fitz  # PyMuPDF
from io import BytesIO
from PIL import Image
import asyncio

# Setup logging first
logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection with fallback for production
mongo_url = os.getenv('MONGO_URL', 'mongodb://localhost:27017')
db_name = os.getenv('DB_NAME', 'readqueue_db')

logger.info(f"Connecting to MongoDB at: {mongo_url.split('@')[-1] if '@' in mongo_url else mongo_url}")
logger.info(f"Using database: {db_name}")

try:
    client = AsyncIOMotorClient(mongo_url, serverSelectionTimeoutMS=5000)
    db = client[db_name]
    logger.info("MongoDB client initialized successfully")
except Exception as e:
    logger.error(f"Failed to initialize MongoDB client: {e}")
    raise

# Create the main app without a prefix
app = FastAPI()

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")

# Global document storage (in-memory)
current_document = {
    "data": None,  # base64 encoded document
    "filename": None,
    "contentType": None,
    "loaderSessionId": None
}

# System configuration - Hardcoded to CST (UTC-6)
TIMEZONE_OFFSET = -6  # CST (Central Standard Time)

# Cache for random PDF selection per day
random_pdf_cache = {}

# Cache version for forcing fresh image loads
cache_version = 0

# WebRTC Signaling - Store signaling messages in memory
webrtc_signals = {}  # sessionId -> list of signals


# Define Models
class CreateSubGroupRequest(BaseModel):
    name: str

class SubGroupResponse(BaseModel):
    id: str
    name: str
    createdAt: datetime

class JoinQueueRequest(BaseModel):
    name: str
    subGroup: Optional[str] = "General"

class JoinQueueResponse(BaseModel):
    sessionId: str
    position: int
    message: str
    subGroup: str

class QueueAction(BaseModel):
    sessionId: str
    action: str  # "start", "skip", or "finish"

class QueueStatusResponse(BaseModel):
    position: int
    totalInQueue: int
    position1Name: Optional[str] = None
    position2Name: Optional[str] = None
    isPosition1: bool
    isPosition2: bool
    subGroup: str

class Participant(BaseModel):
    sessionId: str
    name: str
    subGroup: str
    joinedAt: datetime
    lastActive: datetime

class UploadDocumentBase64(BaseModel):
    filename: str
    contentType: str
    data: str  # base64 encoded
    loaderSessionId: str

class WebRTCSignal(BaseModel):
    fromSessionId: str
    toSessionId: str
    type: str  # "offer", "answer", "ice-candidate"
    data: dict


# Health check endpoints
@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "backend"}

@app.get("/api/health")
async def api_health_check():
    try:
        await db.command('ping')
        return {"status": "healthy", "service": "backend", "database": "connected"}
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        raise HTTPException(status_code=503, detail=f"Database connection failed: {str(e)}")


# Sub-group Management Endpoints
@api_router.post("/subgroups/create")
async def create_subgroup(request: CreateSubGroupRequest):
    existing = await db.subgroups.find_one({"name": request.name})
    if existing:
        raise HTTPException(status_code=400, detail="Sub-group with this name already exists")
    
    subgroup_id = str(uuid.uuid4())
    now = datetime.utcnow()
    
    subgroup = {
        "id": subgroup_id,
        "name": request.name,
        "createdAt": now
    }
    
    await db.subgroups.insert_one(subgroup)
    logger.info(f"Sub-group created: {request.name} (ID: {subgroup_id})")
    
    return {
        "id": subgroup_id,
        "name": request.name,
        "createdAt": now.isoformat(),
        "message": f"Sub-group '{request.name}' created successfully"
    }

@api_router.delete("/subgroups/delete/{subgroup_name}")
async def delete_subgroup(subgroup_name: str):
    if subgroup_name.lower() == "general":
        raise HTTPException(status_code=400, detail="Cannot delete the 'General' sub-group")
    
    existing = await db.subgroups.find_one({"name": subgroup_name})
    if not existing:
        raise HTTPException(status_code=404, detail=f"Sub-group '{subgroup_name}' not found")
    
    queue_result = await db.queue.delete_many({"subGroup": subgroup_name})
    await db.subgroups.delete_one({"name": subgroup_name})
    
    logger.info(f"Sub-group deleted: {subgroup_name} (cleared {queue_result.deleted_count} participants)")
    
    return {
        "success": True,
        "name": subgroup_name,
        "participantsCleared": queue_result.deleted_count,
        "message": f"Sub-group '{subgroup_name}' deleted successfully"
    }

@api_router.get("/subgroups/list")
async def list_subgroups():
    subgroups = await db.subgroups.find({}).to_list(length=None)
    for sg in subgroups:
        sg['_id'] = str(sg['_id'])
    return {"subgroups": subgroups}


# Queue Management Endpoints
@api_router.post("/queue/join", response_model=JoinQueueResponse)
async def join_queue(request: JoinQueueRequest):
    subgroup = await db.subgroups.find_one({"name": request.subGroup})
    if not subgroup:
        subgroup_id = str(uuid.uuid4())
        await db.subgroups.insert_one({
            "id": subgroup_id,
            "name": request.subGroup,
            "createdAt": datetime.utcnow()
        })
        logger.info(f"Auto-created sub-group: {request.subGroup}")
    
    current_count = await db.queue.count_documents({"subGroup": request.subGroup})
    
    if current_count >= 20:
        raise HTTPException(status_code=400, detail=f"Queue for '{request.subGroup}' is full (maximum 20 participants)")
    
    session_id = str(uuid.uuid4())
    now = datetime.utcnow()
    
    participant = {
        "sessionId": session_id,
        "name": request.name,
        "subGroup": request.subGroup,
        "joinedAt": now,
        "lastActive": now
    }
    
    await db.queue.insert_one(participant)
    
    position = await db.queue.count_documents({
        "subGroup": request.subGroup,
        "joinedAt": {"$lte": now}
    })
    
    logger.info(f"{request.name} joined sub-group '{request.subGroup}' at position {position}")
    
    return JoinQueueResponse(
        sessionId=session_id,
        position=position,
        subGroup=request.subGroup,
        message=f"Welcome {request.name}! You are at position {position} in {request.subGroup}"
    )

@api_router.get("/queue/status/{sessionId}", response_model=QueueStatusResponse)
async def get_queue_status(sessionId: str):
    participant = await db.queue.find_one({"sessionId": sessionId})
    
    if not participant:
        raise HTTPException(status_code=404, detail="Participant not found in queue")
    
    subGroup = participant["subGroup"]
    
    await db.queue.update_one(
        {"sessionId": sessionId},
        {"$set": {"lastActive": datetime.utcnow()}}
    )
    
    all_participants = await db.queue.find({"subGroup": subGroup}).sort("joinedAt", 1).to_list(20)
    
    position = next((i + 1 for i, p in enumerate(all_participants) if p["sessionId"] == sessionId), 0)
    
    position1_name = all_participants[0]["name"] if len(all_participants) > 0 else None
    position2_name = all_participants[1]["name"] if len(all_participants) > 1 else None
    
    return QueueStatusResponse(
        position=position,
        totalInQueue=len(all_participants),
        position1Name=position1_name,
        position2Name=position2_name,
        isPosition1=(position == 1),
        isPosition2=(position == 2),
        subGroup=subGroup
    )

@api_router.post("/queue/action")
async def handle_queue_action(request: QueueAction):
    participant = await db.queue.find_one({"sessionId": request.sessionId})
    
    if not participant:
        raise HTTPException(status_code=404, detail="Participant not found in queue")
    
    if request.action in ["skip", "finish"]:
        await db.queue.update_one(
            {"sessionId": request.sessionId},
            {"$set": {"joinedAt": datetime.utcnow(), "lastActive": datetime.utcnow()}}
        )
        return {"message": f"Action '{request.action}' processed. You've been moved to the end of the queue in {participant['subGroup']}."}
    
    elif request.action == "start":
        await db.queue.update_one(
            {"sessionId": request.sessionId},
            {"$set": {"lastActive": datetime.utcnow()}}
        )
        return {"message": "You've started reading. Good luck!"}
    
    else:
        raise HTTPException(status_code=400, detail="Invalid action. Use 'start', 'skip', or 'finish'")

@api_router.delete("/queue/leave/{sessionId}")
async def leave_queue(sessionId: str):
    result = await db.queue.delete_one({"sessionId": sessionId})
    
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Participant not found in queue")
    
    return {"message": "You have left the queue"}

@api_router.get("/queue/all")
async def get_all_queue():
    participants = await db.queue.find().sort("joinedAt", 1).to_list(100)
    
    for participant in participants:
        if "_id" in participant:
            participant["_id"] = str(participant["_id"])
    
    return {"queue": participants, "total": len(participants)}

@api_router.delete("/queue/clear/{subGroup}")
async def clear_subgroup_queue(subGroup: str):
    result = await db.queue.delete_many({"subGroup": subGroup})
    logger.info(f"Admin cleared {result.deleted_count} participants from sub-group '{subGroup}'")
    return {"message": f"Cleared {result.deleted_count} participants from {subGroup}", "count": result.deleted_count}


# Document Management Endpoints
@api_router.get("/config/random-cache")
async def get_random_cache():
    return {"cache": random_pdf_cache}

@api_router.delete("/config/random-cache")
async def clear_random_cache():
    random_pdf_cache.clear()
    logger.info("Random PDF cache cleared by admin")
    return {"success": True, "message": "Random PDF cache cleared"}

@api_router.get("/document/auto-load")
async def auto_load_document(loaderSessionId: str = None, force: bool = False):
    global current_document, cache_version
    
    if not force and current_document["data"] is not None:
        logger.info(f"Document already loaded: {current_document.get('filename')}, skipping auto-load")
        return {
            "success": True,
            "filename": current_document.get("filename"),
            "message": f"PDF '{current_document.get('filename')}' already loaded",
            "cached": True
        }
    
    if force and current_document["data"] is not None:
        logger.info(f"Force reload requested, clearing current document: {current_document.get('filename')}")
        current_document["data"] = None
        current_document["filename"] = None
        current_document["contentType"] = None
        current_document["loaderSessionId"] = None
        cache_version += 1
        logger.info(f"Cache version incremented to {cache_version}")
    
    cst_time = datetime.utcnow() + timedelta(hours=TIMEZONE_OFFSET)
    today = cst_time.strftime("%m%d%Y")
    logger.info(f"Using timezone offset: UTC{TIMEZONE_OFFSET:+d} (CST), Date: {today}")
    pdf_folder = Path(__file__).parent / "pdfs-github"
    
    logger.info(f"Searching for PDF with date: {today} in {pdf_folder}")
    
    matching_files = list(pdf_folder.glob(f"{today}_*.pdf"))
    
    if not matching_files:
        logger.warning(f"No PDF found for today's date: {today}, checking Random folder for fallback...")
        
        if today in random_pdf_cache:
            cached_filename = random_pdf_cache[today]
            random_folder = pdf_folder / "Random"
            pdf_file = random_folder / cached_filename
            
            if pdf_file.exists():
                logger.info(f"Using cached random PDF for {today}: {cached_filename}")
            else:
                logger.warning(f"Cached random PDF {cached_filename} no longer exists, selecting new one")
                del random_pdf_cache[today]
                pdf_file = None
        else:
            pdf_file = None
        
        if pdf_file is None or not pdf_file.exists():
            import random
            random_folder = pdf_folder / "Random"
            if random_folder.exists():
                random_files = list(random_folder.glob("*.pdf"))
                if random_files:
                    pdf_file = random.choice(random_files)
                    random_pdf_cache[today] = pdf_file.name
                    logger.info(f"Selected NEW random PDF for {today}: {pdf_file.name}")
                else:
                    logger.error("No PDFs found in Random folder")
                    raise HTTPException(
                        status_code=404, 
                        detail=f"No PDF for today's date ({today}) and Random folder is empty"
                    )
            else:
                logger.error("Random folder does not exist")
                raise HTTPException(
                    status_code=404, 
                    detail=f"There is not a PDF designed for today's date ({today})"
                )
    else:
        if len(matching_files) > 1:
            logger.warning(f"Multiple PDFs found for {today}: {[f.name for f in matching_files]}")
        
        pdf_file = matching_files[0]
        logger.info(f"Loading PDF: {pdf_file.name}")
    
    try:
        with open(pdf_file, 'rb') as f:
            content = f.read()
        
        encoded_content = base64.b64encode(content).decode('utf-8')
        
        current_document["data"] = encoded_content
        current_document["filename"] = pdf_file.name
        current_document["contentType"] = "application/pdf"
        current_document["loaderSessionId"] = loaderSessionId
        
        logger.info(f"Auto-loaded PDF: {pdf_file.name}, size: ~{len(content)} bytes, loader: {loaderSessionId}")
        
        return {
            "success": True,
            "filename": pdf_file.name,
            "message": f"PDF '{pdf_file.name}' loaded successfully"
        }
        
    except Exception as e:
        logger.error(f"Error loading PDF: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error loading PDF: {str(e)}")

@api_router.post("/document/upload")
async def upload_document(file: UploadFile = File(...), loaderSessionId: str = None):
    global current_document
    
    content = await file.read()
    encoded_content = base64.b64encode(content).decode('utf-8')
    
    current_document["data"] = encoded_content
    current_document["filename"] = file.filename
    current_document["contentType"] = file.content_type
    current_document["loaderSessionId"] = loaderSessionId
    
    logger.info(f"Document uploaded: {file.filename}, size: {len(content)} bytes, loader: {loaderSessionId}")
    
    return {
        "success": True,
        "filename": file.filename,
        "size": len(content),
        "message": "Document uploaded successfully"
    }

@api_router.post("/document/upload-base64")
async def upload_document_base64(upload_data: UploadDocumentBase64):
    global current_document
    
    current_document["data"] = upload_data.data
    current_document["filename"] = upload_data.filename
    current_document["contentType"] = upload_data.contentType
    current_document["loaderSessionId"] = upload_data.loaderSessionId
    
    data_size = len(upload_data.data) * 3 // 4
    
    logger.info(f"Document uploaded (base64): {upload_data.filename}, size: ~{data_size} bytes, loader: {upload_data.loaderSessionId}")
    
    return {
        "success": True,
        "filename": upload_data.filename,
        "size": data_size,
        "message": "Document uploaded successfully"
    }

@api_router.get("/document/current")
async def get_current_document():
    global current_document
    
    if not current_document["data"]:
        raise HTTPException(status_code=404, detail="No document loaded")
    
    return {
        "filename": current_document["filename"],
        "contentType": current_document["contentType"],
        "data": current_document["data"]
    }

@api_router.get("/document/view")
async def view_current_document():
    global current_document
    
    if not current_document["data"]:
        raise HTTPException(status_code=404, detail="No document loaded")
    
    pdf_bytes = base64.b64decode(current_document["data"])
    
    return Response(
        content=pdf_bytes,
        media_type=current_document["contentType"] or "application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{current_document["filename"]}"',
            "Cache-Control": "no-cache"
        }
    )

@api_router.get("/document/status")
async def get_document_status():
    global current_document, cache_version
    return {
        "loaded": current_document["data"] is not None,
        "filename": current_document.get("filename"),
        "loaderSessionId": current_document.get("loaderSessionId"),
        "cacheVersion": cache_version
    }

@api_router.delete("/document/clear")
async def clear_document(loaderSessionId: str = None):
    global current_document, cache_version
    
    current_document["data"] = None
    current_document["filename"] = None
    current_document["contentType"] = None
    current_document["loaderSessionId"] = None
    
    cache_version += 1
    
    await db.queue.delete_many({})
    
    logger.info(f"Document cleared by loader: {loaderSessionId}, queue reset, cache version: {cache_version}")
    
    return {
        "success": True,
        "message": "Document cleared and queue reset",
        "cacheVersion": cache_version
    }

@api_router.get("/document/pages")
async def get_document_pages():
    global current_document
    
    if not current_document["data"]:
        raise HTTPException(status_code=404, detail="No document loaded")
    
    try:
        pdf_bytes = base64.b64decode(current_document["data"])
        pdf_document = fitz.open(stream=pdf_bytes, filetype="pdf")
        page_count = pdf_document.page_count
        
        logger.info(f"PDF has {page_count} pages")
        
        pdf_document.close()
        
        return JSONResponse(
            content={
                "pageCount": page_count,
                "filename": current_document["filename"],
                "timestamp": datetime.utcnow().timestamp()
            },
            headers={
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
                "Expires": "0"
            }
        )
    except Exception as e:
        logger.error(f"Error reading PDF: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error processing PDF: {str(e)}")

@api_router.get("/document/page/{page_number}")
async def get_document_page(page_number: int, quality: int = 90, scale: float = 2.0):
    global current_document
    
    if not current_document["data"]:
        raise HTTPException(status_code=404, detail="No document loaded")
    
    pdf_document = None
    try:
        pdf_bytes = base64.b64decode(current_document["data"])
        pdf_document = fitz.open(stream=pdf_bytes, filetype="pdf")
        
        if page_number < 0 or page_number >= pdf_document.page_count:
            page_count = pdf_document.page_count
            pdf_document.close()
            raise HTTPException(
                status_code=400, 
                detail=f"Invalid page number. Document has {page_count} pages (0-indexed)"
            )
        
        page = pdf_document[page_number]
        mat = fitz.Matrix(scale, scale)
        pix = page.get_pixmap(matrix=mat)
        
        img_data = pix.tobytes("jpeg", jpg_quality=quality)
        
        pdf_document.close()
        pdf_document = None
        
        logger.info(f"Rendered page {page_number} at scale {scale}x, quality {quality}")
        
        return Response(
            content=img_data,
            media_type="image/jpeg",
            headers={
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
                "Expires": "0",
                "Content-Disposition": f'inline; filename="page_{page_number}.jpg"'
            }
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error rendering page {page_number}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error rendering page: {str(e)}")
    finally:
        if pdf_document is not None:
            try:
                pdf_document.close()
            except Exception:
                pass


# PDF Library Management
@api_router.get("/document/library")
async def list_pdf_library():
    try:
        pdf_folder = Path(__file__).parent / "pdfs-github"
        if not pdf_folder.exists():
            pdf_folder.mkdir(parents=True, exist_ok=True)
            return {"files": []}
        
        pdf_files = []
        for pdf_file in pdf_folder.glob("*.pdf"):
            if pdf_file.is_file():
                stat = pdf_file.stat()
                pdf_files.append({
                    "filename": pdf_file.name,
                    "size": stat.st_size,
                    "modified": datetime.fromtimestamp(stat.st_mtime).isoformat()
                })
        
        pdf_files.sort(key=lambda x: x["filename"])
        
        return {"files": pdf_files, "count": len(pdf_files)}
    except Exception as e:
        logger.error(f"Error listing PDF library: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.post("/document/library/upload")
async def upload_pdf_to_library(file: UploadFile = File(...)):
    global current_document, cache_version
    
    try:
        if not file.filename.endswith('.pdf'):
            raise HTTPException(status_code=400, detail="Only PDF files are allowed")
        
        pdf_folder = Path(__file__).parent / "pdfs-github"
        if not pdf_folder.exists():
            pdf_folder.mkdir(parents=True, exist_ok=True)
        
        file_path = pdf_folder / file.filename
        
        is_currently_loaded = (current_document["data"] is not None and 
                               current_document.get("filename") == file.filename)
        
        cst_time = datetime.utcnow() + timedelta(hours=TIMEZONE_OFFSET)
        today = cst_time.strftime("%m%d%Y")
        is_todays_pdf = file.filename.startswith(f"{today}_")
        
        should_clear = is_currently_loaded or (is_todays_pdf and current_document["data"] is not None)
        
        if should_clear:
            logger.info(f"Clearing document from memory before upload")
            current_document["data"] = None
            current_document["filename"] = None
            current_document["contentType"] = None
            current_document["loaderSessionId"] = None
            cache_version += 1
        
        content = await file.read()
        with open(file_path, 'wb') as f:
            f.write(content)
        
        logger.info(f"Uploaded PDF to library: {file.filename} ({len(content)} bytes)")
        
        return {
            "success": True,
            "filename": file.filename,
            "size": len(content),
            "cacheVersion": cache_version,
            "message": f"PDF '{file.filename}' uploaded successfully"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error uploading PDF: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.delete("/document/library/{filename}")
async def delete_pdf_from_library(filename: str):
    try:
        pdf_folder = Path(__file__).parent / "pdfs-github"
        file_path = pdf_folder / filename
        
        if not file_path.exists():
            raise HTTPException(status_code=404, detail=f"File '{filename}' not found")
        
        if current_document["data"] is not None and current_document.get("filename") == filename:
            raise HTTPException(
                status_code=400, 
                detail=f"Cannot delete '{filename}' - it is currently loaded. Clear the document first."
            )
        
        file_path.unlink()
        logger.info(f"Deleted PDF from library: {filename}")
        
        return {
            "success": True,
            "filename": filename,
            "message": f"PDF '{filename}' deleted successfully"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting PDF: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Random PDF Management
@api_router.get("/document/library/random")
async def list_random_library():
    try:
        random_folder = Path(__file__).parent / "pdfs-github" / "Random"
        if not random_folder.exists():
            random_folder.mkdir(parents=True, exist_ok=True)
            return {"files": [], "count": 0}
        
        pdf_files = []
        for pdf_file in random_folder.glob("*.pdf"):
            if pdf_file.is_file():
                stat = pdf_file.stat()
                pdf_files.append({
                    "filename": pdf_file.name,
                    "size": stat.st_size,
                    "modified": datetime.fromtimestamp(stat.st_mtime).isoformat()
                })
        
        pdf_files.sort(key=lambda x: x["filename"])
        
        return {"files": pdf_files, "count": len(pdf_files)}
    except Exception as e:
        logger.error(f"Error listing Random library: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.post("/document/library/random/upload")
async def upload_to_random(file: UploadFile = File(...)):
    try:
        if not file.filename.endswith('.pdf'):
            raise HTTPException(status_code=400, detail="Only PDF files are allowed")
        
        random_folder = Path(__file__).parent / "pdfs-github" / "Random"
        if not random_folder.exists():
            random_folder.mkdir(parents=True, exist_ok=True)
        
        file_path = random_folder / file.filename
        content = await file.read()
        
        with open(file_path, 'wb') as f:
            f.write(content)
        
        logger.info(f"Uploaded to Random: {file.filename} ({len(content)} bytes)")
        
        return {
            "success": True,
            "filename": file.filename,
            "size": len(content),
            "message": f"PDF '{file.filename}' uploaded to Random folder"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error uploading to Random: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.delete("/document/library/random/{filename}")
async def delete_random_pdf(filename: str):
    try:
        random_folder = Path(__file__).parent / "pdfs-github" / "Random"
        file_path = random_folder / filename
        
        if not file_path.exists():
            raise HTTPException(status_code=404, detail=f"File '{filename}' not found in Random folder")
        
        file_path.unlink()
        logger.info(f"Deleted from Random: {filename}")
        
        return {
            "success": True,
            "filename": filename,
            "message": f"PDF '{filename}' deleted from Random folder"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting Random PDF: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# WebRTC Signaling Endpoints
@api_router.post("/webrtc/signal")
async def send_webrtc_signal(signal: WebRTCSignal):
    if signal.toSessionId not in webrtc_signals:
        webrtc_signals[signal.toSessionId] = []
    
    webrtc_signals[signal.toSessionId].append({
        "from": signal.fromSessionId,
        "type": signal.type,
        "data": signal.data,
        "timestamp": datetime.utcnow()
    })
    
    logger.info(f"WebRTC signal stored: {signal.type} from {signal.fromSessionId} to {signal.toSessionId}")
    
    return {"success": True, "message": "Signal stored"}

@api_router.get("/webrtc/signals/{sessionId}")
async def get_webrtc_signals(sessionId: str):
    signals = webrtc_signals.get(sessionId, [])
    if sessionId in webrtc_signals:
        webrtc_signals[sessionId] = []
    
    return {"signals": signals}

@api_router.get("/webrtc/peers")
async def get_webrtc_peers(subGroup: str = None):
    if subGroup:
        all_participants = await db.queue.find({"subGroup": subGroup}).sort("joinedAt", 1).to_list(20)
    else:
        all_participants = await db.queue.find().sort("joinedAt", 1).to_list(20)
    
    peers = [
        {
            "sessionId": p["sessionId"],
            "name": p["name"],
            "subGroup": p.get("subGroup", "default")
        }
        for p in all_participants
    ]
    
    return {"peers": peers, "subGroup": subGroup}


# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

cleanup_task = None

@app.on_event("startup")
async def startup_cleanup_task():
    global cleanup_task
    cleanup_task = asyncio.create_task(auto_cleanup_inactive_subgroups())
    logger.info("Started auto-cleanup background task")

@app.on_event("shutdown")
async def shutdown_db_client():
    global cleanup_task
    if cleanup_task:
        cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass
    client.close()

async def auto_cleanup_inactive_subgroups():
    """Background task that automatically cleans up inactive or empty sub-groups"""
    while True:
        try:
            await asyncio.sleep(60)  # Check every 60 seconds
            
            all_participants = await db.queue.find().to_list(100)
            active_subgroups = set(p.get("subGroup") for p in all_participants)
            
            all_subgroups = await db.subgroups.find({}).to_list(100)
            
            for sg in all_subgroups:
                sg_name = sg.get("name")
                if sg_name and sg_name != "General" and sg_name not in active_subgroups:
                    await db.subgroups.delete_one({"name": sg_name})
                    logger.info(f"Auto-cleaned inactive sub-group: {sg_name}")
                    
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Error in auto-cleanup task: {e}")
            await asyncio.sleep(60)
