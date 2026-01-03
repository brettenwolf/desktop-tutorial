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

# System configuration - Hardcoded to CST (UTC-6)
TIMEZONE_OFFSET = -6  # CST (Central Standard Time)

# Cache version for forcing fresh image loads (stored in MongoDB for persistence)
# Note: Document data is now stored in MongoDB collection 'current_document' for production reliability

# Daily reset tracking
last_reset_date = None

# WebRTC Signaling - Note: Signals are now stored in MongoDB for production reliability
# The webrtc_signals collection will be used instead of in-memory storage

# Helper functions for document storage in MongoDB
async def get_current_document():
    """Get current document from MongoDB"""
    doc = await db.current_document.find_one({"_id": "current"})
    if doc:
        return {
            "data": doc.get("data"),
            "filename": doc.get("filename"),
            "contentType": doc.get("contentType"),
            "loaderSessionId": doc.get("loaderSessionId"),
            "cacheVersion": doc.get("cacheVersion", 0)
        }
    return {
        "data": None,
        "filename": None,
        "contentType": None,
        "loaderSessionId": None,
        "cacheVersion": 0
    }

async def set_current_document(data=None, filename=None, contentType=None, loaderSessionId=None, increment_cache=False):
    """Set current document in MongoDB"""
    current = await get_current_document()
    cache_version = current.get("cacheVersion", 0)
    if increment_cache:
        cache_version += 1
    
    await db.current_document.update_one(
        {"_id": "current"},
        {"$set": {
            "data": data,
            "filename": filename,
            "contentType": contentType,
            "loaderSessionId": loaderSessionId,
            "cacheVersion": cache_version,
            "updatedAt": datetime.utcnow().isoformat()
        }},
        upsert=True
    )
    return cache_version

async def get_random_pdf_cache():
    """Get random PDF cache from MongoDB"""
    doc = await db.app_cache.find_one({"_id": "random_pdf_cache"})
    return doc.get("cache", {}) if doc else {}

async def set_random_pdf_cache(cache):
    """Set random PDF cache in MongoDB"""
    await db.app_cache.update_one(
        {"_id": "random_pdf_cache"},
        {"$set": {"cache": cache, "updatedAt": datetime.utcnow().isoformat()}},
        upsert=True
    )


async def check_and_perform_daily_reset():
    """Check if we need to perform a daily reset based on CST date"""
    global last_reset_date
    
    cst_time = datetime.utcnow() + timedelta(hours=TIMEZONE_OFFSET)
    today = cst_time.strftime("%Y-%m-%d")
    
    if last_reset_date != today:
        logger.info(f"Performing daily reset. Last reset: {last_reset_date}, Today: {today}")
        
        # Clear document in MongoDB
        await set_current_document(
            data=None,
            filename=None,
            contentType=None,
            loaderSessionId=None,
            increment_cache=True
        )
        
        # Clear all queues
        await db.queue.delete_many({})
        
        last_reset_date = today
        random_pdf_cache = await get_random_pdf_cache()
        logger.info(f"Daily reset complete. Random PDF cache preserved: {list(random_pdf_cache.keys())}")
        return True
    return False


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
        # Check for daily reset on health check (first activity trigger)
        daily_reset_performed = await check_and_perform_daily_reset()
        return {
            "status": "healthy", 
            "service": "backend", 
            "database": "connected",
            "dailyResetPerformed": daily_reset_performed
        }
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
    subgroups = await db.subgroups.find({}, {"_id": 0}).to_list(100)
    return {"subgroups": subgroups}


# Queue Management Endpoints
@api_router.post("/queue/join", response_model=JoinQueueResponse)
async def join_queue(request: JoinQueueRequest):
    # Check for daily reset on first queue join
    await check_and_perform_daily_reset()
    
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

@api_router.delete("/queue/remove/{sessionId}")
async def remove_participant(sessionId: str):
    """Admin endpoint to remove any participant from the queue"""
    participant = await db.queue.find_one({"sessionId": sessionId})
    
    if not participant:
        raise HTTPException(status_code=404, detail="Participant not found in queue")
    
    result = await db.queue.delete_one({"sessionId": sessionId})
    
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Failed to remove participant")
    
    logger.info(f"Admin removed participant '{participant.get('name')}' from queue")
    return {
        "success": True,
        "message": f"Removed '{participant.get('name')}' from queue",
        "name": participant.get('name'),
        "subGroup": participant.get('subGroup')
    }

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
    return {
        "success": True,
        "message": f"Cleared {result.deleted_count} participants from {subGroup}", 
        "count": result.deleted_count,
        "subGroup": subGroup
    }

@api_router.delete("/queue/clear-all")
async def clear_all_queues():
    """Clear all participants from all queues"""
    result = await db.queue.delete_many({})
    logger.info(f"Admin cleared all queues: {result.deleted_count} participants removed")
    return {
        "success": True,
        "message": f"Cleared all queues ({result.deleted_count} participants removed)",
        "count": result.deleted_count
    }


# Document Management Endpoints
@api_router.get("/config/random-cache")
async def get_random_cache():
    cache = await get_random_pdf_cache()
    return {"cache": cache}

@api_router.delete("/config/random-cache")
async def clear_random_cache():
    await set_random_pdf_cache({})
    logger.info("Random PDF cache cleared by admin")
    return {"success": True, "message": "Random PDF cache cleared"}

@api_router.get("/document/auto-load")
async def auto_load_document(loaderSessionId: str = None, force: bool = False):
    doc = await get_current_document()
    
    if not force and doc["data"] is not None:
        logger.info(f"Document already loaded: {doc.get('filename')}, skipping auto-load")
        return {
            "success": True,
            "filename": doc.get("filename"),
            "message": f"PDF '{doc.get('filename')}' already loaded",
            "cached": True
        }
    
    if force and doc["data"] is not None:
        logger.info(f"Force reload requested, clearing current document: {doc.get('filename')}")
        await set_current_document(data=None, filename=None, contentType=None, loaderSessionId=None, increment_cache=True)
    
    cst_time = datetime.utcnow() + timedelta(hours=TIMEZONE_OFFSET)
    today = cst_time.strftime("%m%d%Y")
    logger.info(f"Using timezone offset: UTC{TIMEZONE_OFFSET:+d} (CST), Date: {today}")
    pdf_folder = Path(__file__).parent / "pdfs-github"
    
    logger.info(f"Searching for PDF with date: {today} in {pdf_folder}")
    
    matching_files = list(pdf_folder.glob(f"{today}_*.pdf"))
    
    random_pdf_cache = await get_random_pdf_cache()
    
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
                await set_random_pdf_cache(random_pdf_cache)
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
                    await set_random_pdf_cache(random_pdf_cache)
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
        
        await set_current_document(
            data=encoded_content,
            filename=pdf_file.name,
            contentType="application/pdf",
            loaderSessionId=loaderSessionId
        )
        
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
    content = await file.read()
    encoded_content = base64.b64encode(content).decode('utf-8')
    
    await set_current_document(
        data=encoded_content,
        filename=file.filename,
        contentType=file.content_type,
        loaderSessionId=loaderSessionId
    )
    
    logger.info(f"Document uploaded: {file.filename}, size: {len(content)} bytes, loader: {loaderSessionId}")
    
    return {
        "success": True,
        "filename": file.filename,
        "size": len(content),
        "message": "Document uploaded successfully"
    }

@api_router.post("/document/upload-base64")
async def upload_document_base64(upload_data: UploadDocumentBase64):
    await set_current_document(
        data=upload_data.data,
        filename=upload_data.filename,
        contentType=upload_data.contentType,
        loaderSessionId=upload_data.loaderSessionId
    )
    
    data_size = len(upload_data.data) * 3 // 4
    
    logger.info(f"Document uploaded (base64): {upload_data.filename}, size: ~{data_size} bytes, loader: {upload_data.loaderSessionId}")
    
    return {
        "success": True,
        "filename": upload_data.filename,
        "size": data_size,
        "message": "Document uploaded successfully"
    }

@api_router.get("/document/current")
async def get_current_document_endpoint():
    doc = await get_current_document()
    
    if not doc["data"]:
        raise HTTPException(status_code=404, detail="No document loaded")
    
    return {
        "filename": doc["filename"],
        "contentType": doc["contentType"],
        "data": doc["data"]
    }

@api_router.get("/document/view")
async def view_current_document():
    doc = await get_current_document()
    
    if not doc["data"]:
        raise HTTPException(status_code=404, detail="No document loaded")
    
    pdf_bytes = base64.b64decode(doc["data"])
    
    return Response(
        content=pdf_bytes,
        media_type=doc["contentType"] or "application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{doc["filename"]}"',
            "Cache-Control": "no-cache"
        }
    )

@api_router.get("/document/status")
async def get_document_status():
    doc = await get_current_document()
    return {
        "loaded": doc["data"] is not None,
        "filename": doc.get("filename"),
        "loaderSessionId": doc.get("loaderSessionId"),
        "cacheVersion": doc.get("cacheVersion", 0)
    }

@api_router.delete("/document/clear")
async def clear_document(loaderSessionId: str = None):
    cache_version = await set_current_document(
        data=None, 
        filename=None, 
        contentType=None, 
        loaderSessionId=None, 
        increment_cache=True
    )
    
    await db.queue.delete_many({})
    
    logger.info(f"Document cleared by loader: {loaderSessionId}, queue reset, cache version: {cache_version}. Random PDF cache preserved.")
    
    return {
        "success": True,
        "message": "Document cleared and queue reset (random PDF selection preserved for today)",
        "cacheVersion": cache_version
    }

@api_router.get("/document/pages")
async def get_document_pages():
    doc = await get_current_document()
    
    if not doc["data"]:
        raise HTTPException(status_code=404, detail="No document loaded")
    
    try:
        pdf_bytes = base64.b64decode(doc["data"])
        pdf_document = fitz.open(stream=pdf_bytes, filetype="pdf")
        page_count = pdf_document.page_count
        
        logger.info(f"PDF has {page_count} pages")
        
        pdf_document.close()
        
        return JSONResponse(
            content={
                "pageCount": page_count,
                "filename": doc["filename"],
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
    doc = await get_current_document()
    
    if not doc["data"]:
        raise HTTPException(status_code=404, detail="No document loaded")
    
    pdf_document = None
    try:
        pdf_bytes = base64.b64decode(doc["data"])
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
    try:
        if not file.filename.endswith('.pdf'):
            raise HTTPException(status_code=400, detail="Only PDF files are allowed")
        
        pdf_folder = Path(__file__).parent / "pdfs-github"
        if not pdf_folder.exists():
            pdf_folder.mkdir(parents=True, exist_ok=True)
        
        file_path = pdf_folder / file.filename
        
        # Check if this file is currently loaded
        doc = await get_current_document()
        is_currently_loaded = (doc["data"] is not None and 
                               doc.get("filename") == file.filename)
        
        cst_time = datetime.utcnow() + timedelta(hours=TIMEZONE_OFFSET)
        today = cst_time.strftime("%m%d%Y")
        is_todays_pdf = file.filename.startswith(f"{today}_")
        
        should_clear = is_currently_loaded or (is_todays_pdf and doc["data"] is not None)
        
        if should_clear:
            logger.info("Clearing document from memory before upload")
            cache_version = await set_current_document(
                data=None, filename=None, contentType=None, loaderSessionId=None, increment_cache=True
            )
        else:
            cache_version = doc.get("cacheVersion", 0)
        
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
        
        doc = await get_current_document()
        if doc["data"] is not None and doc.get("filename") == filename:
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


# WebRTC Signaling Endpoints - Using MongoDB for production reliability
@api_router.post("/webrtc/signal")
async def send_webrtc_signal(signal: WebRTCSignal):
    # Store signal in MongoDB instead of in-memory
    signal_doc = {
        "toSessionId": signal.toSessionId,
        "fromSessionId": signal.fromSessionId,
        "type": signal.type,
        "data": signal.data,
        "timestamp": datetime.utcnow().isoformat(),
        "processed": False
    }
    await db.webrtc_signals.insert_one(signal_doc)
    
    logger.info(f"WebRTC signal stored: {signal.type} from {signal.fromSessionId} to {signal.toSessionId}")
    
    return {"success": True, "message": "Signal stored"}

@api_router.get("/webrtc/signals/{sessionId}")
async def get_webrtc_signals(sessionId: str):
    # Fetch and delete signals for this session from MongoDB
    signals_cursor = db.webrtc_signals.find({"toSessionId": sessionId, "processed": False})
    signals_list = await signals_cursor.to_list(100)
    
    # Mark signals as processed (or delete them)
    if signals_list:
        signal_ids = [s["_id"] for s in signals_list]
        await db.webrtc_signals.delete_many({"_id": {"$in": signal_ids}})
    
    # Format response (exclude MongoDB _id)
    formatted_signals = [
        {
            "from": s["fromSessionId"],
            "type": s["type"],
            "data": s["data"],
            "timestamp": s["timestamp"]
        }
        for s in signals_list
    ]
    
    return {"signals": formatted_signals}

# Cleanup old signals periodically (signals older than 30 seconds)
@api_router.delete("/webrtc/cleanup")
async def cleanup_old_signals():
    cutoff = (datetime.utcnow() - timedelta(seconds=30)).isoformat()
    result = await db.webrtc_signals.delete_many({"timestamp": {"$lt": cutoff}})
    return {"deleted": result.deleted_count}

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
signal_cleanup_task = None

@app.on_event("startup")
async def startup_cleanup_task():
    global cleanup_task, signal_cleanup_task
    
    # Create index for WebRTC signals for faster queries
    await db.webrtc_signals.create_index("toSessionId")
    await db.webrtc_signals.create_index("timestamp")
    
    cleanup_task = asyncio.create_task(auto_cleanup_inactive_subgroups())
    signal_cleanup_task = asyncio.create_task(auto_cleanup_old_signals())
    logger.info("Started auto-cleanup background task")

async def auto_cleanup_old_signals():
    """Clean up WebRTC signals older than 60 seconds"""
    while True:
        try:
            cutoff = (datetime.utcnow() - timedelta(seconds=60)).isoformat()
            result = await db.webrtc_signals.delete_many({"timestamp": {"$lt": cutoff}})
            if result.deleted_count > 0:
                logger.info(f"Cleaned up {result.deleted_count} old WebRTC signals")
        except Exception as e:
            logger.error(f"Error cleaning up signals: {e}")
        await asyncio.sleep(30)  # Run every 30 seconds

@app.on_event("shutdown")
async def shutdown_db_client():
    global cleanup_task, signal_cleanup_task
    if cleanup_task:
        cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass
    if signal_cleanup_task:
        signal_cleanup_task.cancel()
        try:
            await signal_cleanup_task
        except asyncio.CancelledError:
            pass
    client.close()

async def auto_cleanup_inactive_subgroups():
    """Background task - DISABLED: Groups now persist until manually removed by admin"""
    # This task has been disabled to give groups permanence
    # Groups will only be removed when an admin explicitly deletes them
    while True:
        try:
            await asyncio.sleep(3600)  # Sleep for 1 hour (task is effectively disabled)
            # No auto-cleanup - groups persist until admin removes them
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Error in cleanup task: {e}")
            await asyncio.sleep(3600)
