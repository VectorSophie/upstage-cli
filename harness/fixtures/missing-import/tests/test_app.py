import pytest
from app import app

@pytest.fixture
def client():
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c

def test_startup(client):
    """fail_to_pass: /items/<id> must return JSON without NameError"""
    resp = client.get("/items/1")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["id"] == 1
    assert data["name"] == "widget"

def test_health(client):
    """pass_to_pass: /health must keep working"""
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.get_json()["status"] == "ok"

def test_list(client):
    """pass_to_pass: /items list must keep working"""
    resp = client.get("/items")
    assert resp.status_code == 200
    assert len(resp.get_json()["items"]) == 2
