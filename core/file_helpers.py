"""
File upload and storage helpers for LBAS.
Handles profile photos and media uploads.
"""
import os
import uuid
from werkzeug.utils import secure_filename

# These will be set by Admin_page1.py
UPLOAD_FOLDER = "Profile"
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".pdf"}


def save_profile_photo(photo, school_id, app):
    """Save uploaded profile pictures in ./Profile using predictable per-ID filenames."""
    saved_photo = "default.png"
    if not (photo and getattr(photo, "filename", "")):
        return saved_photo

    _, ext = os.path.splitext(photo.filename)
    ext = (ext or ".png").lower()
    if len(ext) > 10:
        ext = ".png"

    sid = secure_filename(str(school_id).strip().lower()) or "user"
    filename = f"{sid}_profile{ext}"
    file_path = os.path.join(app.config["UPLOAD_FOLDER"], filename)
    photo.save(file_path)
    return filename


def save_post_image(uploaded_file, app):
    """Save uploaded landing/news media in ./Profile and return the filename."""
    if not (uploaded_file and getattr(uploaded_file, "filename", "")):
        return None

    original_name = secure_filename(uploaded_file.filename)
    if not original_name:
        return None

    _, ext = os.path.splitext(original_name)
    ext = (ext or "").lower()
    if ext not in ALLOWED_EXTENSIONS:
        return None

    filename = f"news_{uuid.uuid4().hex[:16]}{ext}"
    uploaded_file.save(os.path.join(app.config["UPLOAD_FOLDER"], filename))
    return filename
