from __future__ import annotations

import json
import sys
import threading
import urllib.request
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

import app  # noqa: E402


class RuntimeHealthTests(unittest.TestCase):
    def test_health_endpoint_identifies_reader_instance(self) -> None:
        server = app.ReaderServer(("127.0.0.1", 0), app.ReaderHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = server.server_address[1]
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["app"], app.APP_ID)
            self.assertEqual(payload["instanceId"], server.instance_id)
            self.assertEqual(payload["port"], port)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
