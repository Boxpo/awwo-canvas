"""python -m unittest test_worker.py — exercises the protocol surface over real HTTP, stdlib only."""
import json
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

import worker


def call(url, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return response.status, response.headers.get("Content-Type", ""), response.read().decode()


def events(text):
    return [json.loads(frame[len("data: "):]) for frame in text.split("\n\n") if frame.strip()]


class WorkerProtocolTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), worker.Handler)
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_health_declares_its_runtime_on_every_model(self):
        status, _, text = call(f"{self.url}/health")
        health = json.loads(text)
        self.assertEqual(status, 200)
        self.assertTrue(health["ready"])
        self.assertEqual(health["model"], "py-echo")
        self.assertTrue(all(model["runtime"] == worker.RUNTIME for model in health["models"]))

    def test_run_answers_in_the_frozen_contract_shape(self):
        contract = [{"id": "summary", "label": "Summary", "type": "markdown"}, {"id": "score", "label": "Score", "type": "number"}]
        status, kind, text = call(f"{self.url}/internal/runs", "POST", {
            "runId": "py-1", "sessionId": "s", "prompt": "Summarise the brief", "messages": [], "model": "py-echo", "runtime": worker.RUNTIME,
            "systemPrompt": f"Deliver.\n{worker.CONTRACT_HEADER}\n{json.dumps(contract)}\n"})
        self.assertEqual(status, 200)
        self.assertTrue(kind.startswith("text/event-stream"))
        stream = events(text)
        self.assertEqual(stream[-1]["type"], "completed")
        self.assertEqual("".join(e["delta"] for e in stream if e["type"] == "text_delta"), stream[-1]["text"])
        self.assertEqual(set(json.loads(stream[-1]["text"])), {"summary", "score"})

    def test_wrong_runtime_and_unknown_model_are_refused(self):
        for body in ({"runId": "a", "prompt": "x", "runtime": "mock"}, {"runId": "b", "prompt": "x", "model": "gpt"}):
            with self.assertRaises(urllib.error.HTTPError) as caught:
                call(f"{self.url}/internal/runs", "POST", body)
            self.assertEqual(caught.exception.code, 422)

    def test_cancel_is_idempotent(self):
        status, _, text = call(f"{self.url}/internal/runs/missing", "DELETE")
        self.assertEqual((status, json.loads(text)), (200, {"cancelled": False}))

    def test_router_completion(self):
        _, _, text = call(f"{self.url}/internal/completions", "POST", {
            "runId": "r", "model": "py-echo", "completion": {"messages": [{"role": "system", "content": "You route one message"}, {"role": "user", "content": "hi"}]}})
        content = json.loads(text)["completion"]["choices"][0]["message"]["content"]
        self.assertEqual(json.loads(content), {"route": "plan"})


if __name__ == "__main__":
    unittest.main()
