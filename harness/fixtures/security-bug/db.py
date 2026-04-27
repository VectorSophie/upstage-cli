import sqlite3

DB_PATH = ":memory:"

def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user'
        )
    """)
    conn.execute("INSERT INTO users (name, role) VALUES ('alice', 'admin')")
    conn.execute("INSERT INTO users (name, role) VALUES ('bob', 'user')")
    conn.commit()

def search_users(conn, name):
    # BUG: SQL injection via f-string interpolation
    query = f"SELECT * FROM users WHERE name='{name}'"
    return [dict(row) for row in conn.execute(query).fetchall()]

def get_user_role(conn, name):
    rows = search_users(conn, name)
    if not rows:
        return None
    return rows[0]["role"]
