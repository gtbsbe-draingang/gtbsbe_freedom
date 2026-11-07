"""Send requests serialized by the real JS adapter through the assembled backend."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="Node is needed to exercise the frontend adapter")


def adapter_request(operation, *args):
    script = """
import { createHttpApi } from './web/src/api/http.js';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { operation, args } = JSON.parse(input);
const api = createHttpApi({
  apiBase: '/api', role: () => 'reviewer',
  fetchImpl: async (url, init) => {
    console.log(JSON.stringify({ url, body: JSON.parse(init.body) }));
    return new Response('{}', { status: 201 });
  },
});
await api[operation](...args);
"""
    result = subprocess.run(
        [NODE, "--input-type=module", "-e", script],
        cwd=ROOT, input=json.dumps({"operation": operation, "args": args}),
        text=True, capture_output=True, check=True,
    )
    return json.loads(result.stdout)


def test_real_adapter_can_create_and_version_an_official_copy(client):
    original = client.get("/api/checklists/official-chat/versions/1").json()
    checklist = {**original, "name": "HTTP integration copy", "based_on": {
        "checklist_id": "official-chat", "version": 1,
    }}
    request = adapter_request("createChecklist", checklist)
    response = client.post(request["url"], json=request["body"])
    assert response.status_code == 201, response.text
    created = response.json()
    assert created["author_role"] == "reviewer"
    assert created["based_on"] == {"checklist_id": "official-chat", "version": 1}

    request = adapter_request("saveChecklistVersion", created["checklist_id"], {
        **checklist, "name": "HTTP integration version 2",
    })
    response = client.post(request["url"], json=request["body"])
    assert response.status_code == 201, response.text
    assert response.json()["version"] == 2
    assert response.json()["name"] == "HTTP integration version 2"
    assert client.get("/api/checklists/official-chat/versions/1").json() == original
