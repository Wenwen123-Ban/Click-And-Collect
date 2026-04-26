"""
Sync engine for LBAS — handles automatic data synchronization.
Manages reservations, ticket cleanup, and queue promotion.
"""
import os
import json
import base64
import logging
from datetime import datetime, timedelta
from core.db import get_db, save_db, DB_FILES

logger = logging.getLogger("LBAS")


def sync_categories_with_books():
    """Ensure categories list includes all book categories."""
    books = get_db("books")
    categories = get_db("categories")
    
    if not isinstance(categories, list):
        categories = []
    
    book_cats = set()
    for book in books:
        cat = str(book.get("category", "")).strip()
        if cat:
            book_cats.add(cat)
    
    changed = False
    for cat in book_cats:
        if cat not in categories:
            categories.append(cat)
            changed = True
    
    if changed:
        save_db("categories", categories)


def ensure_creators_profile_db():
    """Ensure creators_profiles.json exists."""
    filepath = "creators_profiles.json"
    if not os.path.exists(filepath):
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump([], f, indent=4)


def initialize_system_db():
    """Initialize all database files with default data."""
    logger.info("SYSTEM INIT: verifying database integrity...")
    
    # Ensure profile directories exist
    PROFILE_FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "Profile")
    os.makedirs(PROFILE_FOLDER, exist_ok=True)
    
    ensure_creators_profile_db()
    
    # Create default.png if missing
    default_path = os.path.join(PROFILE_FOLDER, "default.png")
    if not os.path.exists(default_path):
        blank = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1"
            "HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAA"
            "SUVORK5CYII="
        )
        with open(default_path, "wb") as f:
            f.write(blank)
    
    # Initialize all database files
    for key, file_path in DB_FILES.items():
        if not os.path.exists(file_path):
            if key == "config":
                initial_data = {
                    "system_version": "7.2 Beta",
                    "last_reboot": datetime.now().strftime("%Y-%m-%d %H:%M"),
                }
            elif key == "categories":
                initial_data = ["General", "Mathematics", "Science", "Literature"]
            elif key == "date_restricted":
                initial_data = {}
            elif key == "log_rec":
                initial_data = {
                    "month": datetime.now().strftime("%Y-%m"),
                    "events": [],
                }
            elif key == "courses":
                initial_data = {
                    "courses": ["BSIT", "BSAM", "BSIS"],
                    "hs_grades": [7, 8, 9, 10],
                    "college_years": [1, 2, 3, 4],
                }
            else:
                initial_data = []
            
            with open(file_path, "w", encoding="utf-8") as f:
                json.dump(initial_data, f, indent=4)
    
    # Remove legacy feedback file
    if os.path.exists("ratings.json"):
        os.remove("ratings.json")
    
    # Sync categories with books
    sync_categories_with_books()
    
    # Ensure status fields exist in user records
    users = get_db("users")
    changed = False
    for u in users:
        if "status" not in u:
            u["status"] = "approved"
            changed = True
    if changed:
        save_db("users", users)
    
    # Ensure phone_number exists for users/admins
    for reg_key in ["users", "admins"]:
        members = get_db(reg_key)
        registry_changed = False
        for member in members:
            if "phone_number" not in member:
                member["phone_number"] = ""
                registry_changed = True
        if registry_changed:
            save_db(reg_key, members)
    
    logger.info("✅ Database initialization complete")


def _pickup_sort_key(tx):
    """Generate sort key for reservation by pickup schedule."""
    raw = str(tx.get("pickup_schedule", "") or "").strip()
    if not raw:
        return (99999, 99999)
    
    try:
        dt = datetime.strptime(raw, "%Y-%m-%d %H:%M")
        return (dt.year, dt.timetuple().tm_yday)
    except ValueError:
        return (99999, 99999)


def promote_next_in_queue(book_no):
    """Move next reservation in queue to 'Reserved' status."""
    transactions = get_db("transactions")
    books = get_db("books")
    
    queue = [
        t
        for t in transactions
        if t.get("book_no") == book_no
        and str(t.get("status", "")).strip().lower() == "reserved"
        and t.get("pickup_schedule")
    ]

    if not queue:
        for b in books:
            if b.get("book_no") == book_no:
                b["status"] = "Available"
        save_db("books", books)
        return

    queue.sort(key=_pickup_sort_key)
    for b in books:
        if b.get("book_no") == book_no:
            b["status"] = "Reserved"
    save_db("books", books)


def check_missed_pickups():
    """Mark reservations as 'Missed' if not picked up by deadline."""
    transactions = get_db("transactions")
    now = datetime.now()
    changed = False
    affected_books = set()

    for tx in transactions:
        if str(tx.get("status", "")).strip().lower() != "reserved":
            continue

        raw = str(tx.get("pickup_schedule", "") or "").strip()
        if not raw:
            continue

        pickup_dt = None
        date_only = False
        for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d"):
            try:
                pickup_dt = datetime.strptime(raw, fmt)
                if fmt == "%Y-%m-%d":
                    date_only = True
                break
            except ValueError:
                continue

        if not pickup_dt:
            continue

        if date_only:
            pickup_dt = pickup_dt.replace(hour=17, minute=0)

        grace = pickup_dt + timedelta(minutes=30)
        if now <= grace:
            continue

        already_borrowed = any(
            t.get("book_no") == tx.get("book_no")
            and str(t.get("school_id", "")).strip().lower()
            == str(tx.get("school_id", "")).strip().lower()
            and str(t.get("status", "")).strip().lower() in ("borrowed", "converted")
            for t in transactions
        )

        if not already_borrowed:
            tx["status"] = "Missed"
            tx["missed_at"] = now.strftime("%Y-%m-%d %H:%M")
            affected_books.add(tx.get("book_no"))
            changed = True

    if changed:
        save_db("transactions", transactions)
        for book_no in affected_books:
            promote_next_in_queue(book_no)


def run_auto_sync_engine():
    """
    CRITICAL SYNC ENGINE:
    1. Checks missed pickups
    2. Expires old reservations
    3. Cleans up malformed tickets
    Returns: Updated books list for dashboard
    """
    check_missed_pickups()
    books = get_db("books")
    transactions = get_db("transactions")
    now = datetime.now()
    changes_made = False

    # 1. Sync Reservations
    for t in transactions:
        if not isinstance(t, dict):
            continue
        if str(t.get("status", "")).strip() != "Reserved":
            continue
        expiry_value = str(t.get("expiry", "")).strip()
        if not expiry_value:
            continue
        try:
            if now > datetime.strptime(expiry_value, "%Y-%m-%d %H:%M"):
                t["status"] = "Expired"
                for b in books:
                    if isinstance(b, dict) and b.get("book_no") == t.get("book_no"):
                        b["status"] = "Available"
                        changes_made = True
        except ValueError:
            continue

    # 2. Safe ticket cleanup — never crash on malformed tickets
    try:
        tickets = get_db("tickets")
        if isinstance(tickets, list):
            valid_tickets = []
            for t in tickets:
                if not isinstance(t, dict):
                    continue
                try:
                    expiry_str = str(t.get("expiry", "") or "").strip()
                    if not expiry_str:
                        continue
                    expiry_dt = datetime.strptime(expiry_str, "%Y-%m-%d %H:%M:%S")
                    if expiry_dt > now:
                        valid_tickets.append(t)
                except (ValueError, TypeError):
                    continue
            if len(valid_tickets) != len(tickets):
                save_db("tickets", valid_tickets)
    except Exception as ticket_err:
        logger.warning(f"Ticket cleanup skipped: {ticket_err}")

    if changes_made:
        save_db("books", books)
        save_db("transactions", transactions)

    return books
