from flask import Blueprint, jsonify, request

admin_bp = Blueprint('api_admin', __name__)
S = {}

def init_admin(shared):
    global S
    S = shared

def _admin_required():
    return S['require_admin_session']()

@admin_bp.route('/api/categories', methods=['POST'])
def add_category():
    if not _admin_required(): return jsonify({'success': False}), 401
    name = str((request.json or {}).get('category') or (request.json or {}).get('name') or '').strip()
    cats = S['get_db']('categories')
    if name and name not in cats:
        cats.append(name); S['save_db']('categories', cats)
    return jsonify({'success': True, 'categories': cats})

@admin_bp.route('/api/delete_category', methods=['POST'])
def del_category():
    if not _admin_required(): return jsonify({'success': False}), 401
    name = str((request.json or {}).get('category','')).strip()
    cats = [c for c in S['get_db']('categories') if c != name]
    S['save_db']('categories', cats)
    return jsonify({'success': True})

@admin_bp.route('/api/home_cards', methods=['POST'])
def save_cards():
    if not _admin_required(): return jsonify({'success': False}), 401
    cards = (request.json or {}).get('cards', [])
    S['save_db']('home_cards', cards)
    return jsonify({'success': True})

@admin_bp.route('/api/news_posts', methods=['POST'])
def save_post():
    if not _admin_required(): return jsonify({'success': False}), 401
    f = request.form
    posts = S['get_db']('news_posts')
    image_name = ''
    up = request.files.get('image')
    if up and up.filename:
        ext = S['os'].path.splitext(up.filename)[1].lower() or '.png'
        image_name = f"news_{S['uuid'].uuid4().hex[:12]}{ext}"
        up.save(S['os'].path.join('LandingUploads', image_name))
    posts.append({'id': S['uuid'].uuid4().hex[:10], 'title': f.get('title',''), 'summary': f.get('summary',''), 'body': f.get('body',''), 'image_filename': image_name, 'date_created': S['datetime'].now().strftime('%Y-%m-%d %H:%M')})
    S['save_db']('news_posts', posts)
    return jsonify({'success': True})

@admin_bp.route('/api/news_posts/<post_id>', methods=['DELETE'])
def del_post(post_id):
    if not _admin_required(): return jsonify({'success': False}), 401
    posts = [p for p in S['get_db']('news_posts') if str(p.get('id')) != str(post_id)]
    S['save_db']('news_posts', posts)
    return jsonify({'success': True})

@admin_bp.route('/api/date_restrictions/check')
def check_date():
    date = request.args.get('date', '')
    try:
        dt = S['datetime'].strptime(date, '%Y-%m-%d')
    except Exception:
        return jsonify({'restricted': False, 'reason': '', 'source': 'invalid'})
    manual = S['get_db']('date_restricted').get(date, {}) if isinstance(S['get_db']('date_restricted'), dict) else {}
    if manual.get('action') == 'lift':
        return jsonify({'restricted': False, 'reason': manual.get('reason',''), 'source': 'manual_lift'})
    if manual.get('action') == 'ban':
        return jsonify({'restricted': True, 'reason': manual.get('reason',''), 'source': 'manual_ban'})
    holidays = {'01-01','04-09','05-01','06-12','08-21','08-26','11-01','11-30','12-08','12-25','12-30'}
    if dt.weekday() >= 5:
        return jsonify({'restricted': True, 'reason': 'Weekend', 'source': 'weekend'})
    if dt.strftime('%m-%d') in holidays:
        return jsonify({'restricted': True, 'reason': 'PH holiday', 'source': 'holiday'})
    return jsonify({'restricted': False, 'reason': '', 'source': 'open'})

@admin_bp.route('/api/date_restrictions')
def restrictions():
    if not _admin_required(): return jsonify({'success': False}), 401
    return jsonify(S['get_db']('date_restricted'))

@admin_bp.route('/api/date_restrictions/set', methods=['POST'])
def set_restriction():
    if not _admin_required(): return jsonify({'success': False}), 401
    d = request.json or {}
    rec = S['get_db']('date_restricted')
    date = d.get('date'); action = d.get('action')
    if action == 'reset': rec.pop(date, None)
    else: rec[date] = {'action': action, 'reason': d.get('reason','')}
    S['save_db']('date_restricted', rec)
    return jsonify({'success': True})

@admin_bp.route('/api/admin/books')
def admin_books():
    if not _admin_required(): return jsonify({'success': False}), 401
    return jsonify(S['get_db']('books'))

@admin_bp.route('/api/admin/users')
def admin_users():
    if not _admin_required(): return jsonify({'success': False}), 401
    return jsonify(S['get_db']('users'))

@admin_bp.route('/api/admin/admins')
def admin_admins():
    if not _admin_required(): return jsonify({'success': False}), 401
    return jsonify(S['get_db']('admins'))

@admin_bp.route('/api/admin/transactions')
def admin_transactions():
    if not _admin_required(): return jsonify({'success': False}), 401
    return jsonify(S['get_db']('transactions'))

@admin_bp.route('/api/admin/approval-records')
def admin_ar():
    if not _admin_required(): return jsonify({'success': False}), 401
    return jsonify(S['get_db']('admin_approval_record'))

@admin_bp.route('/api/admin/registration-requests')
def admin_rr():
    if not _admin_required(): return jsonify({'success': False}), 401
    return jsonify(S['get_db']('registration_requests'))

@admin_bp.route('/api/admin/registration-requests/<rid>/decision', methods=['POST'])
def admin_rr_decide(rid):
    if not _admin_required(): return jsonify({'success': False}), 401
    decision = str((request.json or {}).get('decision','')).lower()
    reqs = S['get_db']('registration_requests')
    req = next((r for r in reqs if str(r.get('request_id')) == str(rid)), None)
    if not req:
        return jsonify({'success': False}), 404
    req['status'] = 'approved' if decision == 'approve' else 'rejected'
    req['reviewed_by'] = _admin_required(); req['reviewed_at'] = S['datetime'].now().strftime('%Y-%m-%d %H:%M')
    if decision == 'approve':
        users = S['get_db']('users')
        users.append({'name': req.get('name',''), 'school_id': req.get('school_id',''), 'password': req.get('password',''), 'photo': req.get('photo','default.png'), 'email': req.get('email',''), 'status': 'approved', 'category': 'Student'})
        S['save_db']('users', users)
    S['save_db']('registration_requests', reqs)
    return jsonify({'success': True})