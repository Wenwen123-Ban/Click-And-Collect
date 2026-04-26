"""
Database access layer for LBAS.
Handles all JSON file I/O operations.
"""
import os
import json
import logging
import threading

logger = logging.getLogger("LBAS")

DB_FILES = {
    "books": "books.json",
    "admins": "admins.json",
    "users": "users.json",
    "transactions": "transactions.json",
    "config": "system_config.json",
    "tickets": "tickets.json",
    "categories": "categories.json",
    "date_restricted": "Date_Restricted.json",
    "reservation_transactions": "reservation_transaction.json",
    "admin_approval_record": "Admin_approval_record.json",
    "registration_requests": "registration_requests.json",
    "log_rec": "log_rec.json",
    "home_cards": "home_cards.json",
    "news_posts": "news_posts.json",
    "courses": "courses.json",
}

_db_write_lock = threading.Lock()


def get_db(key):
    """Safely read a JSON database file."""
    try:
        if key not in DB_FILES:
            logger.warning(f"Unknown database key: {key}")
            return {} if key == "config" else []
        
        filepath = DB_FILES[key]
        if not os.path.exists(filepath):
            return {} if key == "config" else []
        
        with open(filepath, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"DB READ ERROR ({key}): {e}")
        return {} if key == "config" else []


def save_db(key, data):
    """Safely write a JSON database file."""
    if key not in DB_FILES:
        logger.warning(f"Unknown database key: {key}")
        return
    
    try:
        with _db_write_lock:
            filepath = DB_FILES[key]
            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=4, ensure_ascii=False)
    except Exception as e:
        logger.error(f"DB WRITE ERROR ({key}): {e}")


def find_any_user(s_id):
    """Find a user in either admins.json or users.json by school_id."""
    s_id = str(s_id).strip().lower()
    if not s_id:
        return None
    
    # Check admins first
    for admin in get_db("admins"):
        if str(admin.get("school_id", "")).strip().lower() == s_id:
            result = dict(admin)
            result["registry_origin"] = "admins.json"
            result["is_staff"] = True
            return result
    
    # Then check users
    for student in get_db("users"):
        if str(student.get("school_id", "")).strip().lower() == s_id:
            result = dict(student)
            result["registry_origin"] = "users.json"
            result["is_staff"] = False
            return result
    
    return None
