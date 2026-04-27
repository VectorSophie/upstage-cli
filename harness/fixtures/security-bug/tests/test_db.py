import pytest
from db import get_conn, init_db, search_users, get_user_role

@pytest.fixture
def conn():
    c = get_conn()
    init_db(c)
    yield c
    c.close()

def test_search_injection(conn):
    """fail_to_pass: SQL injection must NOT return admin via injected payload"""
    # Classic injection: ' OR '1'='1
    results = search_users(conn, "' OR '1'='1")
    # A vulnerable implementation returns all rows; a fixed one returns []
    assert len(results) == 0, "SQL injection payload returned rows — still vulnerable"

def test_search_normal(conn):
    """pass_to_pass: normal search must still work"""
    results = search_users(conn, "alice")
    assert len(results) == 1
    assert results[0]["name"] == "alice"

def test_auth(conn):
    """pass_to_pass: role lookup must still work"""
    assert get_user_role(conn, "alice") == "admin"
    assert get_user_role(conn, "bob") == "user"
    assert get_user_role(conn, "nobody") is None
