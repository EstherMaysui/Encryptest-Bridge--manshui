import requests

resp = requests.post(
    "http://127.0.0.1:18080/encrypt",
    json={
        "data": "123456",
        "trace_id": "demo-1"
    },
    timeout=30
)

print(resp.json())