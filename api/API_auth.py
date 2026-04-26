from flask import Blueprint, jsonify, request

auth_bp = Blueprint('api_auth', __name__)
S = {}

def init_auth(shared):
    global S
    S = shared

@auth_bp.route('/api/login', methods=['POST'])
def api_login():
    data = request.json or {}
    s_id = str(data.get('school_id', '')).strip().lower()
    pwd = data.get('password')
    id_only = bool(data.get('id_only', False))
    user = S['find_any_user'](s_id)
    if not user:
        return jsonify({'success': False, 'message': 'ID not found'}), 404
    if str(user.get('status', 'approved')).lower() == 'pending':
        return jsonify({'success': False, 'message': 'Account pending approval'}), 403
    if str(user.get('status', 'approved')).lower() == 'rejected':
        return jsonify({'success': False, 'message': 'Account not approved'}), 403
    if (id_only and not user.get('is_staff')) or user.get('password') == pwd:
        token = str(S['uuid'].uuid4())
        S['ACTIVE_SESSIONS'][s_id] = {'token': token, 'created_at': S['datetime'].now().strftime('%Y-%m-%d %H:%M')}
        if user.get('is_staff'):
            S['session']['is_admin'] = True
            S['session']['admin_school_id'] = s_id
        S['save_active_sessions']()
        return jsonify({'success': True, 'token': token, 'profile': user})
    return jsonify({'success': False, 'message': 'Invalid Password'}), 401

@auth_bp.route('/api/verify_id', methods=['POST'])
def api_verify_id():
    s_id = str((request.json or {}).get('school_id', '')).strip().lower()
    user = S['find_any_user'](s_id)
    if not user:
        return jsonify({'success': False, 'message': 'ID not found'}), 404
    if user.get('is_staff'):
        return jsonify({'success': False, 'message': 'Use Admin Login'}), 403
    status = str(user.get('status', 'approved')).lower()
    if status == 'pending':
        return jsonify({'success': False, 'message': 'Account pending approval'}), 403
    if status == 'rejected':
        return jsonify({'success': False, 'message': 'Account not approved'}), 403
    token = str(S['uuid'].uuid4())
    S['ACTIVE_SESSIONS'][s_id] = {'token': token, 'created_at': S['datetime'].now().strftime('%Y-%m-%d %H:%M')}
    S['save_active_sessions']()
    return jsonify({'success': True, 'token': token, 'profile': user})

@auth_bp.route('/api/register_request', methods=['POST'])
def api_register_request():
    f = request.form
    name, school_id, email, password = f.get('name','').strip(), f.get('school_id','').strip().lower(), f.get('email','').strip(), f.get('password','').strip()
    if not all([name, school_id, email, password]):
        return jsonify({'success': False, 'message': 'All fields required'}), 400
    if not S['re'].fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email):
        return jsonify({'success': False, 'message': 'Invalid email'}), 400
    if len(password) < 6:
        return jsonify({'success': False, 'message': 'Password must be at least 6 chars'}), 400
    if S['find_any_user'](school_id):
        return jsonify({'success': False, 'message': 'School ID already exists'}), 400
    reqs = S['get_db']('registration_requests')
    if any(str(r.get('school_id','')).lower()==school_id and str(r.get('status','pending')).lower()=='pending' for r in reqs):
        return jsonify({'success': False, 'message': 'Pending request already exists'}), 400
    photo_name = ''
    photo = request.files.get('photo')
    if photo and photo.filename:
        ext = S['os'].path.splitext(photo.filename)[1].lower() or '.png'
        photo_name = f"{school_id}_req{ext}"
        photo.save(S['os'].path.join('Profile', photo_name))
    reqs.append({'request_id': f"REQ-{S['uuid'].uuid4().hex[:10].upper()}", 'name': name, 'school_id': school_id, 'email': email, 'password': password, 'photo': photo_name or 'default.png', 'status': 'pending', 'date_created': S['datetime'].now().strftime('%Y-%m-%d %H:%M'), 'reviewed_by': '', 'reviewed_at': ''})
    S['save_db']('registration_requests', reqs)
    return jsonify({'success': True, 'message': 'Registration request submitted'})

@auth_bp.route('/api/register_student', methods=['POST'])
def api_register_student():
    token_id = S['require_auth']()
    token_user = S['find_any_user'](token_id) if token_id else None
    admin_mode = bool(token_user and token_user.get('is_staff'))
    f = request.form
    users = S['get_db']('users')
    sid = str(f.get('school_id','')).strip().lower()
    if S['find_any_user'](sid):
        return jsonify({'success': False, 'message': 'ID Exists'}), 400
    photo = request.files.get('photo')
    file_name = 'default.png'
    if photo and photo.filename:
        ext = S['os'].path.splitext(photo.filename)[1].lower() or '.png'
        file_name = f"{sid}_profile{ext}"
        photo.save(S['os'].path.join('Profile', file_name))
    users.append({'name': f.get('name','').strip(), 'school_id': sid, 'password': f.get('password',''), 'photo': file_name, 'category': 'Student', 'status': 'approved' if admin_mode else 'pending'})
    S['save_db']('users', users)
    return jsonify({'success': True})

@auth_bp.route('/api/register_librarian', methods=['POST'])
def api_register_librarian():
    f = request.form
    admins = S['get_db']('admins')
    sid = str(f.get('school_id','')).strip().lower()
    if S['find_any_user'](sid):
        return jsonify({'success': False, 'message': 'ID Exists'}), 400
    admins.append({'name': f.get('name','').strip(), 'school_id': sid, 'password': f.get('password',''), 'photo': 'default.png', 'category': 'Staff', 'status': 'approved'})
    S['save_db']('admins', admins)
    return jsonify({'success': True})

@auth_bp.route('/api/logout', methods=['POST'])
def api_logout():
    S['session'].clear()
    token = request.headers.get('Authorization', '').strip()
    for sid, sess in list(S['ACTIVE_SESSIONS'].items()):
        if isinstance(sess, dict) and sess.get('token') == token:
            del S['ACTIVE_SESSIONS'][sid]
    S['save_active_sessions']()
    return jsonify({'success': True})