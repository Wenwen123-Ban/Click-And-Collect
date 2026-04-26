from flask import Blueprint, jsonify, request

content_bp = Blueprint('api_content', __name__)
S = {}

def init_content(shared):
    global S
    S = shared

@content_bp.route('/api/categories')
def get_categories():
    return jsonify(S['get_db']('categories'))

@content_bp.route('/api/home_cards')
def get_cards():
    cards = S['get_db']('home_cards')
    while len(cards) < 4:
        cards.append({'id': len(cards)+1, 'title': '', 'body': ''})
    return jsonify(cards[:4])

@content_bp.route('/api/news_posts')
def get_news():
    posts = S['get_db']('news_posts')
    posts.sort(key=lambda x: x.get('date_created',''), reverse=True)
    return jsonify(posts)

@content_bp.route('/api/monthly_leaderboard')
def monthly_leaderboard():
    txs = S['get_db']('transactions')
    now = S['datetime'].now()
    borrows = [t for t in txs if str(t.get('status','')).lower() in {'borrowed','returned'}]
    monthly = []
    for t in borrows:
        try:
            dt = S['datetime'].strptime(str(t.get('date',''))[:16], '%Y-%m-%d %H:%M')
            if dt.year == now.year and dt.month == now.month:
                monthly.append(t)
        except Exception:
            pass
    rows = monthly or borrows
    uc, bc = {}, {}
    books = {str(b.get('book_no')): b for b in S['get_db']('books')}
    for t in rows:
        sid = str(t.get('school_id','')).lower(); bno = str(t.get('book_no',''))
        uc[sid] = uc.get(sid, 0) + 1
        bc[bno] = bc.get(bno, 0) + 1
    top_u = []
    for i, (sid, total) in enumerate(sorted(uc.items(), key=lambda x: x[1], reverse=True)[:10], 1):
        u = S['find_any_user'](sid) or {}
        top_u.append({'rank': i, 'school_id': sid, 'name': u.get('name', sid), 'photo': u.get('photo','default.png'), 'total_borrowed': total})
    top_b = [{'rank': i, 'book_no': b, 'title': books.get(b,{}).get('title','Unknown'), 'total_borrowed': t} for i, (b,t) in enumerate(sorted(bc.items(), key=lambda x: x[1], reverse=True)[:10],1)]
    return jsonify({'top_borrowers': top_u, 'top_books': top_b})

@content_bp.route('/api/leaderboard_profile/<school_id>')
def profile_lb(school_id):
    txs = S['get_db']('transactions')
    sid = str(school_id).lower()
    user = S['find_any_user'](sid) or {}
    total = sum(1 for t in txs if str(t.get('school_id','')).lower()==sid and str(t.get('status','')).lower() in {'borrowed','returned'})
    return jsonify({'school_id': sid, 'name': user.get('name',''), 'photo': user.get('photo','default.png'), 'total_borrowed': total})