# missing-import fixture

## Bug

`app.py` calls `jsonify()` in the `get_item` route but never imports it from `flask`.
This causes a `NameError: name 'jsonify' is not defined` at runtime.

## Expected Fix

Add `jsonify` to the flask import on line 1.

### file: app.py
```
from flask import Flask, request, jsonify

app = Flask(__name__)

ITEMS = [{"id": 1, "name": "widget"}, {"id": 2, "name": "gadget"}]

@app.route("/health")
def health():
    return {"status": "ok"}

@app.route("/items")
def list_items():
    return {"items": ITEMS}

@app.route("/items/<int:item_id>")
def get_item(item_id):
    item = next((i for i in ITEMS if i["id"] == item_id), None)
    if item is None:
        return {"error": "not found"}, 404
    return jsonify(item)

if __name__ == "__main__":
    app.run(debug=True)
```

## Test Split

- **fail_to_pass**: `tests/test_app.py::test_startup`
- **pass_to_pass**: `tests/test_app.py::test_health`, `tests/test_app.py::test_list`
