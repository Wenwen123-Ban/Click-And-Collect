from flask import Blueprint, jsonify, request

books_bp = Blueprint('api_books', __name__)
S = {}

def init_books(shared):
    global S
    S = shared

def _date_check(date_str):
    try:
        dt = S['datetime'].strptime(date_str, '%Y-%m-%d')
    except Exception:
        return True, 'Invalid pickup date', 'input'
    manual = S['get_db']('date_restricted')
    record = manual.get(date_str, {}) if isinstance(manual, dict) else {}
    if record.get('action') == 'lift':
        return False, '', 'manual_lift'
    if dt.weekday() >= 5:
        return True, 'Weekend is restricted', 'weekend'
    ph = {'01-01','04-09','05-01','06-12','08-21','08-26','11-01','11-30','12-08','12-25','12-30'}
    if dt.strftime('%m-%d') in ph:
        return True, 'Philippine holiday', 'holiday'
    if record.get('action') == 'ban':
        return True, record.get('reason','Restricted date'), 'manual_ban'
    return False, '', 'open'

@books_bp.route('/api/reserve', methods=['POST'])
def api_reserve():
    auth_id = S['require_auth']()
    if not auth_id:
        return jsonify({'success': False, 'message': 'Unauthorized'}), 401
    d = request.json or {}
    b_no = d.get('book_no')
    s_id = str(auth_id).lower()
    pickup = str(d.get('pickup_schedule','')).strip()
    date_only = pickup.split(' ')[0] if pickup else ''
    restricted, reason, _ = _date_check(date_only)
    if restricted:
        return jsonify({'success': False, 'message': reason}), 400
    ctype = str(d.get('contact_type','')).lower()
    cval = str(d.get('phone_number','')).strip()
    if ctype == 'phone' and not S['re'].fullmatch(r'\d{11}', cval):
        return jsonify({'success': False, 'message': 'Phone must be 11 digits'}), 400
    if ctype == 'email' and not S['re'].fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', cval):
        return jsonify({'success': False, 'message': 'Invalid email'}), 400
    txs = S['get_db']('transactions'); books = S['get_db']('books')
    if sum(1 for t in txs if str(t.get('school_id','')).lower()==s_id and str(t.get('status','')).lower()=='reserved') >= 5:
        return jsonify({'success': False, 'message': 'Reservation limit reached'}), 400
    if any(str(t.get('school_id','')).lower()==s_id and str(t.get('book_no'))==str(b_no) and str(t.get('status','')).lower()=='reserved' for t in txs):
        return jsonify({'success': False, 'message': 'Already reserved'}), 400
    book = next((b for b in books if str(b.get('book_no'))==str(b_no)), None)
    if not book:
        return jsonify({'success': False, 'message': 'Book not found'}), 404
    if str(book.get('status','available')).lower() not in {'available','reserved'}:
        return jsonify({'success': False, 'message': 'Book unavailable'}), 409
    book['status'] = 'reserved'
    req_id = d.get('request_id') or f"REQ-{S['uuid'].uuid4().hex[:8].upper()}"
    rec = {'book_no': b_no, 'title': book.get('title',''), 'school_id': s_id, 'status': 'reserved', 'date': S['datetime'].now().strftime('%Y-%m-%d %H:%M'), 'expiry': None, 'return_by': '', 'return_date': '', 'borrower_name': d.get('borrower_name',''), 'phone_number': cval, 'contact_type': ctype, 'pickup_schedule': pickup, 'pickup_location': d.get('pickup_location',''), 'request_id': req_id, 'reservation_note': f"{b_no} - {book.get('title','')}", 'approved_by': '', 'reserved_at': S['datetime'].now().strftime('%Y-%m-%d %H:%M')}
    txs.append(rec)
    rtx = S['get_db']('reservation_transactions'); rtx.append(rec)
    S['save_db']('books', books); S['save_db']('transactions', txs); S['save_db']('reservation_transactions', rtx)
    return jsonify({'success': True, 'request_id': req_id})

@books_bp.route('/api/cancel_reservation', methods=['POST'])
def cancel_res():
    if not S['require_auth']():
        return jsonify({'success': False}), 401
    d = request.json or {}
    txs = S['get_db']('transactions')
    for t in reversed(txs):
        if str(t.get('book_no')) == str(d.get('book_no')) and str(t.get('request_id','')) == str(d.get('request_id','')) and str(t.get('status','')).lower()=='reserved':
            t['status'] = 'cancelled'
            S['save_db']('transactions', txs)
            S['promote_next_in_queue'](d.get('book_no'))
            return jsonify({'success': True})
    return jsonify({'success': False, 'message': 'Not found'}), 404

@books_bp.route('/api/process_transaction', methods=['POST'])
def process_transaction():
    if not S['require_auth']():
        return jsonify({'success': False}), 401
    d = request.json or {}
    action, b_no = d.get('action'), d.get('book_no')
    txs = S['get_db']('transactions'); books = S['get_db']('books')
    book = next((b for b in books if str(b.get('book_no'))==str(b_no)), None)
    if not book:
        return jsonify({'success': False, 'message': 'Book not found'}), 404
    if action == 'borrow':
        body_sid = str(d.get('school_id','')).strip().lower()
        req_id = str(d.get('request_id','')).strip()
        sid = body_sid
        reserved = [t for t in txs if str(t.get('book_no'))==str(b_no) and str(t.get('status','')).lower()=='reserved']
        if not sid and req_id:
            m = next((t for t in reserved if str(t.get('request_id',''))==req_id), None)
            sid = str((m or {}).get('school_id','')).lower()
        if not sid and reserved:
            sid = str(reserved[0].get('school_id','')).lower()
        if not sid:
            return jsonify({'success': False, 'message': 'Unable to borrow for now', 'reason': 'missing_school_id'}), 400
        if str(book.get('status','')).lower() not in {'available','reserved'}:
            return jsonify({'success': False, 'message': 'invalid_book_status'}), 409
        match = next((t for t in reserved if (req_id and str(t.get('request_id',''))==req_id) or str(t.get('school_id','')).lower()==sid), None)
        if str(book.get('status','')).lower()=='reserved' and not match:
            return jsonify({'success': False, 'message': 'reserved_for_other_user'}), 409
        if match:
            match['status'] = 'converted'
        book['status'] = 'borrowed'
        txs.append({**(match or {}), 'book_no': b_no, 'school_id': sid, 'status': 'borrowed', 'expiry': d.get('return_due_date'), 'approved_by': d.get('approved_by',''), 'reserved_at': (match or {}).get('reserved_at',''), 'date': S['datetime'].now().strftime('%Y-%m-%d %H:%M'), 'proof_borrow_photo': d.get('proof_borrow_photo',''), 'mobile_scanner_ready': bool(d.get('mobile_scanner_ready', False))})
        ar = S['get_db']('admin_approval_record'); ar.append({'book_no': b_no, 'school_id': sid, 'request_id': d.get('request_id',''), 'action': 'borrow', 'approved_by': d.get('approved_by',''), 'date': S['datetime'].now().strftime('%Y-%m-%d %H:%M'), 'proof_borrow_photo': d.get('proof_borrow_photo',''), 'mobile_scanner_ready': bool(d.get('mobile_scanner_ready', False))})
        S['save_db']('admin_approval_record', ar)
    elif action == 'return':
        book['status'] = 'available'
        req_id = str(d.get('request_id','')).strip(); sid = str(d.get('school_id','')).strip().lower()
        for t in reversed(txs):
            if str(t.get('book_no'))==str(b_no) and str(t.get('status','')).lower()=='borrowed' and ((req_id and str(t.get('request_id',''))==req_id) or (sid and str(t.get('school_id','')).lower()==sid) or True):
                t['status'] = 'returned'; t['return_date'] = S['datetime'].now().strftime('%Y-%m-%d %H:%M'); break
        ar = S['get_db']('admin_approval_record'); ar.append({'book_no': b_no, 'request_id': req_id, 'action': 'return', 'date': S['datetime'].now().strftime('%Y-%m-%d %H:%M')}); S['save_db']('admin_approval_record', ar)
        S['promote_next_in_queue'](b_no)
    elif action == 'cancel':
        for t in txs:
            if str(t.get('book_no'))==str(b_no) and str(t.get('status','')).lower()=='reserved':
                t['status'] = 'cancelled'
        S['promote_next_in_queue'](b_no)
    else:
        return jsonify({'success': False, 'message': 'Invalid action'}), 400
    S['save_db']('transactions', txs); S['save_db']('books', books)
    return jsonify({'success': True})