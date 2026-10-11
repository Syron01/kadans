import asyncio
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI, HTTPException, BackgroundTasks, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from sqlalchemy import create_engine, Column, Integer, String, ForeignKey, Table
from sqlalchemy.orm import declarative_base
from sqlalchemy.orm import sessionmaker, Session, relationship
from ytmusicapi import YTMusic
from yt_dlp import YoutubeDL
import uvicorn
import os
import time
import random
import requests
from functools import partial
from pydantic import BaseModel
from typing import List, Optional

# Discord RPC isteğe bağlıdır; kullanılmıyorsa yorumda kalsın
# from pypresence import Presence
import uuid

# --- CONFIG & OPTIMIZATION ---
executor = ThreadPoolExecutor(max_workers=20) 

# --- DISCORD RPC ---
RPC = None
# try:
#     client_id = "1203666666666666666" # Buraya kendi Discord Client ID'nizi yazabilirsiniz
#     RPC = Presence(client_id)
#     RPC.connect()
#     print("Discord RPC Connected")
# except:
#     print("Discord RPC Failed (Is Discord Open?)")
#     RPC = None

# --- DATABASE SETUP (SQLite) ---
SQLALCHEMY_DATABASE_URL = "sqlite:///./kadans.db"
engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# Models
class SongDB(Base):
    __tablename__ = "songs"
    id = Column(String, primary_key=True, index=True) # YouTube Video ID
    title = Column(String)
    artist = Column(String)
    thumbnail = Column(String)

class PlaylistDB(Base):
    __tablename__ = "playlists"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String)
    share_token = Column(String, unique=True, index=True) # Collaboration Token
    songs = relationship("SongDB", secondary="playlist_songs")

# Association Table (Many-to-Many)
playlist_songs = Table('playlist_songs', Base.metadata,
    Column('playlist_id', Integer, ForeignKey('playlists.id')),
    Column('song_id', String, ForeignKey('songs.id'))
)

# Likes are just a special playlist or separate table? 
# For simplicity, let's keep a dedicated "favorites" table or logic.
# Here we will use a separate table for direct user likes.
class LikedSongDB(Base):
    __tablename__ = "liked_songs"
    song_id = Column(String, ForeignKey("songs.id"), primary_key=True)
    
Base.metadata.create_all(bind=engine)

# Dependency
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# Pydantic Models for Requests
class SongSchema(BaseModel):
    id: str
    title: str
    artist: str
    thumbnail: str

class PlaylistCreate(BaseModel):
    name: str

app = FastAPI(title="Kadans API", version="5.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

yt = YTMusic()

# --- IN-MEMORY CACHE SYSTEM ---
class TTLCache:
    def __init__(self, ttl: int = 3600):
        self.cache = {}
        self.ttl = ttl
    
    def get(self, key):
        if key in self.cache:
            data, timestamp = self.cache[key]
            if time.time() - timestamp < self.ttl:
                return data
            else:
                del self.cache[key]
        return None

    def set(self, key, value):
        self.cache[key] = (value, time.time())

# Cache Instances
search_cache = TTLCache(ttl=1800)  # 30 dk arama cache
url_cache = TTLCache(ttl=3600)     # 1 saat link cache
lyrics_cache = TTLCache(ttl=86400) # 24 saat şarkı sözü cache

# --- ASYNC WRAPPERS ---
async def run_blocking(func, *args, **kwargs):
    """Bloklayan senkron fonksiyonları asenkron thread havuzunda çalıştırır."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(executor, partial(func, *args, **kwargs))

# --- ENDPOINTS ---

@app.get("/")
async def read_root():
    return {"status": "online", "mode": "high-concurrency", "workers": 20}

@app.get("/ana-sayfa")
async def get_home_content():
    cache_key = "home_content"
    cached = search_cache.get(cache_key)
    if cached: return cached

    queries = ["Global Top 50", "Turkey Top 50 Songs", "Viral Hits 2025", "Summer Hits 2024"]
    try:
        query = random.choice(queries)
        results = await run_blocking(yt.search, query, filter="songs", limit=40)
        
        data = []
        for i in results:
            if not i.get("videoId"): continue
            
            thumb = "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=300&h=300&fit=crop"
            if i.get("thumbnails"):
                thumb = i["thumbnails"][-1]["url"]
            
            artist_id = None
            if i.get("artists") and len(i["artists"]) > 0:
                artist_id = i["artists"][0].get("id")

            data.append({
                "id": i["videoId"],
                "title": i["title"],
                "artist": i["artists"][0]["name"] if i.get("artists") else "Bilinmeyen",
                "artistId": artist_id,
                "thumbnail": thumb
            })
        
        search_cache.set(cache_key, data)
        return data
    except Exception as e:
        print(f"Home Error: {e}")
        # Fallback Data
        return [
            {"id": "s3mDdLfmMwY", "title": "Neyim Var Ki", "artist": "Ceza", "thumbnail": "https://i.ytimg.com/vi/s3mDdLfmMwY/hqdefault.jpg"},
            {"id": "Lp2qcCrdBLA", "title": "Bir Derdim Var", "artist": "mor ve ötesi", "thumbnail": "https://i.ytimg.com/vi/Lp2qcCrdBLA/hqdefault.jpg"}
        ]

@app.get("/ara")
async def search_music(q: str):
    cached = search_cache.get(f"search:{q}")
    if cached: return cached

    try:
        results = await run_blocking(yt.search, q, filter="songs", limit=30)
        data = []
        for i in results:
            if not i.get("videoId"): continue
            
            thumb = "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=300&h=300&fit=crop"
            if i.get("thumbnails"):
                thumb = i["thumbnails"][-1]["url"]
            
            artist_id = None
            if i.get("artists") and len(i["artists"]) > 0:
                artist_id = i["artists"][0].get("id")

            data.append({
                "id": i["videoId"],
                "title": i["title"],
                "artist": i["artists"][0]["name"] if i.get("artists") else "Bilinmeyen",
                "artistId": artist_id,
                "thumbnail": thumb
            })
        
        search_cache.set(f"search:{q}", data)
        return data
    except: return []

@app.get("/cal")
async def stream_music(videoId: str, quality: str = "high", request: Request = None):
    # Return the URL to our proxy endpoint with quality option
    return {"url": f"{request.base_url}stream?videoId={videoId}&quality={quality}"}

@app.get("/stream")
async def stream_proxy(videoId: str, quality: str = "high", request: Request = None):
    quality_key = f"{videoId}:{quality}"
    cached_url = url_cache.get(quality_key)
    
    # Format selection according to requested quality
    format_selector = 'bestaudio[abr<=96]/worstaudio' if quality == 'low' else (
        'bestaudio[abr<=160]/bestaudio' if quality == 'medium' else 'bestaudio/best'
    )
    
    if not cached_url:
        ydl_opts = {
            'format': format_selector,
            'quiet': True,
            'no_warnings': True,
            'extractor_retries': 3,
            'geo_bypass': True,
            'source_address': '0.0.0.0',
            'skip_download': True,
        }
        
        def extract_url():
            with YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(f"https://www.youtube.com/watch?v={videoId}", download=False)
                return info.get('url')

        try:
            url = await run_blocking(extract_url)
            if not url:
                raise HTTPException(status_code=500, detail="URL alınamadı")
            url_cache.set(quality_key, url)
            cached_url = url
        except Exception as e:
            print(f"Stream Error: {e}")
            raise HTTPException(status_code=500, detail="Stream URL alınamadı")

    # Forward client Range header to target audio stream
    range_header = request.headers.get("Range") if request else None
    upstream_headers = {}
    if range_header:
        upstream_headers["Range"] = range_header

    try:
        upstream_resp = requests.get(cached_url, headers=upstream_headers, stream=True, timeout=10)
    except Exception as e:
        # Cache might be stale/expired; retry once with refreshed URL
        url_cache.cache.pop(quality_key, None)
        raise HTTPException(status_code=502, detail=f"Upstream stream connection error: {e}")

    # Spotify-style 64KB chunks for fast buffer & latency-free seeking
    def iterfile():
        try:
            for chunk in upstream_resp.iter_content(chunk_size=65536):
                if chunk:
                    yield chunk
        finally:
            upstream_resp.close()

    response_headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": upstream_resp.headers.get("Content-Type", "audio/mp4"),
    }
    if "Content-Range" in upstream_resp.headers:
        response_headers["Content-Range"] = upstream_resp.headers["Content-Range"]
    if "Content-Length" in upstream_resp.headers:
        response_headers["Content-Length"] = upstream_resp.headers["Content-Length"]

    status_code = upstream_resp.status_code if upstream_resp.status_code in [200, 206] else 200
    return StreamingResponse(iterfile(), status_code=status_code, headers=response_headers, media_type=response_headers["Content-Type"])

@app.get("/sanatci-detay")
async def get_artist_full_details(channelId: str):
    cached = search_cache.get(f"artist_full:{channelId}")
    if cached: return cached

    try:
        # Sanatçının tüm bilgilerini (albümler, videolar, benzer sanatçılar) getirir
        details = await run_blocking(yt.get_artist, channelId)
        
        # Sadece ihtiyacımız olan verileri temizleyelim
        data = {
            "name": details.get("name"),
            "description": details.get("description"),
            "thumbnails": details.get("thumbnails"),
            "views": details.get("views"),
            "songs": [{
                "id": s["videoId"],
                "title": s["title"],
                "artist": details.get("name"),
                "thumbnail": s["thumbnails"][-1]["url"] if s.get("thumbnails") else ""
            } for s in details.get("songs", {}).get("results", [])],
            "albums": [{
                "id": a["browseId"],
                "title": a["title"],
                "year": a.get("year"),
                "thumbnail": a["thumbnails"][-1]["url"] if a.get("thumbnails") else ""
            } for a in details.get("albums", {}).get("results", [])],
            "singles": [{
                "id": s["browseId"],
                "title": s["title"],
                "year": s.get("year"),
                "thumbnail": s["thumbnails"][-1]["url"] if s.get("thumbnails") else ""
            } for s in details.get("singles", {}).get("results", [])],
            "related": [{
                "id": r["browseId"],
                "name": r["subscribers"], # ytmusicapi bazen ismi burada döner
                "thumbnail": r["thumbnails"][-1]["url"] if r.get("thumbnails") else ""
            } for r in details.get("related", {}).get("results", [])]
        }
        
        search_cache.set(f"artist_full:{channelId}", data)
        return data
    except Exception as e:
        print(f"Artist Detail Error: {e}")
        return {"error": str(e)}

@app.get("/album-detay")
async def get_album_details(browseId: str):
    cached = search_cache.get(f"album:{browseId}")
    if cached: return cached

    try:
        album = await run_blocking(yt.get_album, browseId)
        data = {
            "title": album.get("title"),
            "artist": album.get("artists", [{}])[0].get("name"),
            "year": album.get("year"),
            "thumbnail": album.get("thumbnails", [{}])[-1].get("url"),
            "songs": [{
                "id": s["videoId"],
                "title": s["title"],
                "artist": album.get("artists", [{}])[0].get("name"),
                "thumbnail": album.get("thumbnails", [{}])[-1].get("url"), # Albüm kapağını kullan
                "index": i + 1
            } for i, s in enumerate(album.get("tracks", []))]
        }
        search_cache.set(f"album:{browseId}", data)
        return data
    except Exception as e:
        print(f"Album Detail Error: {e}")
        return {"error": str(e)}

@app.get("/sanatci")
async def get_artist_top(name: str):
    cached = search_cache.get(f"artist:{name}")
    if cached: return cached

    try:
        results = await run_blocking(yt.search, f"{name} popular songs", filter="songs", limit=40)
        data = []
        for i in results:
            if not i.get("videoId"): continue
            thumb = i["thumbnails"][-1]["url"] if i.get("thumbnails") else "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=300&h=300&fit=crop"
            data.append({
                "id": i["videoId"],
                "title": i["title"],
                "artist": i["artists"][0]["name"] if i.get("artists") else name,
                "thumbnail": thumb
            })
        
        search_cache.set(f"artist:{name}", data)
        return data
    except: return []

@app.get("/sozler")
async def get_lyrics(videoId: str):
    cached = lyrics_cache.get(videoId)
    if cached: return {"lyrics": cached}

    def fetch_lyrics():
        try:
            watch_playlist = yt.get_watch_playlist(videoId=videoId)
            lyrics_id = watch_playlist.get("lyrics")
            if lyrics_id:
                return yt.get_lyrics(lyrics_id)["lyrics"]
        except: pass
        return None

    lyrics = await run_blocking(fetch_lyrics)
    if lyrics:
        lyrics_cache.set(videoId, lyrics)
    return {"lyrics": lyrics}

@app.get("/kategoriler")
async def get_categories():
    return [
        {"id": "tr-pop", "title": "Türkçe Pop", "query": "Türkçe Pop 2025 En İyiler"},
        {"id": "rap", "title": "Hip Hop & Rap", "query": "Turkish Rap 2025"},
        {"id": "rock", "title": "Rock Efsaneleri", "query": "Best Rock Songs Ever"},
        {"id": "mood", "title": "Modunu Yakala", "query": "Chill Vibes 2025"},
        {"id": "global", "title": "Dünya Listeleri", "query": "Global Top 50 2025"},
        {"id": "electronic", "title": "Elektronik", "query": "Electronic Dance Music Hits"}
    ]

# İndirme işlemi sunucuyu en çok yoran işlemdir. 
# Bunu asenkron yaparak sunucunun diğer kullanıcılara cevap vermesini engellemiş oluruz.
@app.get("/indir")
async def download_music(videoId: str, background_tasks: BackgroundTasks):
    download_path = "downloads"
    if not os.path.exists(download_path): os.makedirs(download_path)
    
    ydl_opts = {
        'format': 'bestaudio/best', 
        'outtmpl': f'{download_path}/%(title)s.%(ext)s', 
        'quiet': True,
        'noplaylist': True
    }

    def process_download():
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={videoId}", download=True)
            return ydl.prepare_filename(info)

    try:
        filepath = await run_blocking(process_download)
        filename = os.path.basename(filepath)
        
        # Dosya gönderildikten sonra temizlemek istersek BackgroundTasks kullanabiliriz.
        # Şimdilik kalıcı olarak saklıyoruz.
        return FileResponse(filepath, media_type='application/octet-stream', filename=filename)
    except Exception as e:
        print(f"Download Error: {e}")
        raise HTTPException(status_code=500, detail="İndirme başarısız")

# --- DATABASE ENDPOINTS ---

@app.get("/likes")
async def get_likes(db: Session = Depends(get_db)):
    # Join with SongDB to get details
    likes = db.query(SongDB).join(LikedSongDB, SongDB.id == LikedSongDB.song_id).all()
    return [{"id": s.id, "title": s.title, "artist": s.artist, "thumbnail": s.thumbnail} for s in likes]

@app.post("/likes")
async def toggle_like(song: SongSchema, db: Session = Depends(get_db)):
    # Ensure song exists in SongDB first
    db_song = db.query(SongDB).filter(SongDB.id == song.id).first()
    if not db_song:
        db_song = SongDB(id=song.id, title=song.title, artist=song.artist, thumbnail=song.thumbnail)
        db.add(db_song)
        db.commit()
    
    # Toggle like
    existing_like = db.query(LikedSongDB).filter(LikedSongDB.song_id == song.id).first()
    if existing_like:
        db.delete(existing_like)
        db.commit()
        return {"status": "unliked"}
    else:
        new_like = LikedSongDB(song_id=song.id)
        db.add(new_like)
        db.commit()
        return {"status": "liked"}

@app.get("/playlists")
async def get_playlists(db: Session = Depends(get_db)):
    playlists = db.query(PlaylistDB).all()
    result = []
    for pl in playlists:
        songs = [{"id": s.id, "title": s.title, "artist": s.artist, "thumbnail": s.thumbnail} for s in pl.songs]
        result.append({"id": pl.id, "name": pl.name, "songs": songs})
    return result

@app.post("/playlists")
async def create_playlist(pl: PlaylistCreate, db: Session = Depends(get_db)):
    token = str(uuid.uuid4())[:8] # 8 karakterlik basit bir kod
    new_pl = PlaylistDB(name=pl.name, share_token=token)
    db.add(new_pl)
    db.commit()
    db.refresh(new_pl)
    return new_pl

@app.get("/playlists/join/{share_token}")
async def join_playlist(share_token: str, db: Session = Depends(get_db)):
    playlist = db.query(PlaylistDB).filter(PlaylistDB.share_token == share_token).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist bulunamadı")
    
    songs = [{"id": s.id, "title": s.title, "artist": s.artist, "thumbnail": s.thumbnail} for s in playlist.songs]
    return {"id": playlist.id, "name": playlist.name, "songs": songs, "share_token": playlist.share_token}

class RPCUpdate(BaseModel):
    title: str
    artist: str
    duration: int = 0
    thumbnail: str = ""

@app.post("/rpc/update")
async def update_discord_rpc(data: RPCUpdate):
    if RPC:
        try:
            RPC.update(
                state=f"By {data.artist}",
                details=data.title,
                large_image="kadans_logo", # Discord Developer Portal'da yüklediğiniz asset key
                large_text="Kadans",
                small_image="play_icon",
                small_text="Playing",
                buttons=[{"label": "Birlikte Dinle", "url": "https://kadans"}]
            )
        except: pass
    return {"status": "ok"}

@app.post("/playlists/{playlist_id}/add")
async def add_to_playlist(playlist_id: int, song: SongSchema, db: Session = Depends(get_db)):
    playlist = db.query(PlaylistDB).filter(PlaylistDB.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
        
    # Ensure song exists
    db_song = db.query(SongDB).filter(SongDB.id == song.id).first()
    if not db_song:
        db_song = SongDB(id=song.id, title=song.title, artist=song.artist, thumbnail=song.thumbnail)
        db.add(db_song)
        db.commit()
    
    # Check if already in playlist
    if db_song not in playlist.songs:
        playlist.songs.append(db_song)
        db.commit()
        
    return {"status": "added", "playlist_name": playlist.name}

if __name__ == "__main__":
    # Production modu: workers=4 (veya CPU çekirdek sayısı kadar)
    # Reload sadece geliştirme aşamasında açık olmalı.
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)