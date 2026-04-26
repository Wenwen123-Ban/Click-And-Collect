"""
Authentication and session management for LBAS.
Supports both Flask cookies and Bearer tokens.
"""
from datetime import datetime, timedelta
from flask import request, session
from core.db import find_any_user

ACTIVE_SESSIONS = {}
SESSION_TIMEOUT_HOURS = 2

# In-memory PIN-based password reset system
_RESET_PINS = {}  # { school_id: { "pin": "ABC123", "created_at": datetime, "status": "pending|approved" } }
RESET_PIN_TTL_MINUTES = 10


def _cleanup_reset_pins():
    """Remove pins older than TTL. Called inline — no background thread needed."""
    now = datetime.now()
    expired = [
        sid for sid, data in _RESET_PINS.items()
        if (now - data.get("created_at", datetime.max)).total_seconds() > RESET_PIN_TTL_MINUTES * 60
    ]
    for sid in expired:
        del _RESET_PINS[sid]


def require_admin_session():
    """
    Dual-auth: Accept BOTH Flask session cookies AND Bearer tokens.
    Method 1: Flask session (browser form login)
    Method 2: Bearer token in Authorization header (admin_dashboard.js)
    """
    # Method 1: Flask session cookie
    admin_id = str(session.get("admin_school_id", "")).strip().lower()
    if admin_id and session.get("is_admin", False):
        profile = find_any_user(admin_id)
        if profile and profile.get("is_staff", False):
            return admin_id
        session.clear()

    # Method 2: Bearer token in Authorization header
    token = request.headers.get("Authorization", "").strip()
    if token:
        for user_id, sess_data in list(ACTIVE_SESSIONS.items()):
            if isinstance(sess_data, dict) and sess_data.get("token") == token:
                if datetime.now() < sess_data.get("expires", datetime.min):
                    # Verify this token belongs to a staff member
                    profile = find_any_user(user_id)
                    if profile and profile.get("is_staff", False):
                        return user_id
                else:
                    del ACTIVE_SESSIONS[user_id]

    return None


def require_auth():
    """Accept Bearer token for student-facing endpoints."""
    token = request.headers.get("Authorization", "").strip()
    if not token:
        return None

    to_delete = []
    for user_id, sess_data in list(ACTIVE_SESSIONS.items()):
        if isinstance(sess_data, dict) and sess_data.get("token") == token:
            if datetime.now() < sess_data.get("expires", datetime.min):
                return user_id
            to_delete.append(user_id)

    for uid in to_delete:
        del ACTIVE_SESSIONS[uid]

    return None


def is_session_valid(user_id, token):
    """Check if a session token is valid."""
    sess = ACTIVE_SESSIONS.get(str(user_id).strip().lower())
    if not isinstance(sess, dict) or sess.get("token") != token:
        return False
    if datetime.now() >= sess.get("expires", datetime.min):
        del ACTIVE_SESSIONS[str(user_id).strip().lower()]
        return False
    return True
