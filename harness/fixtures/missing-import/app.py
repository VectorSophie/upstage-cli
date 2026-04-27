from flask import Flask, request

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
    # BUG: jsonify is used below but not imported
    return jsonify(item)

if __name__ == "__main__":
    app.run(debug=True)
