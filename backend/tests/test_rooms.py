import unittest
from unittest.mock import patch

from app import rooms
from app.ws import _is_valid_signal


class RoomSecurityTests(unittest.TestCase):
    def setUp(self):
        rooms.rooms.clear()

    def tearDown(self):
        rooms.rooms.clear()

    def test_room_code_has_eight_characters(self):
        room = rooms.create_room()

        self.assertEqual(len(room["code"]), 8)
        self.assertEqual(room["code"], room["code"].upper())

    def test_expired_room_is_removed_and_rejected(self):
        with patch("app.rooms.time.time", return_value=1000):
            room = rooms.create_room()

        with patch("app.rooms.time.time", return_value=1000 + rooms.ROOM_LIFETIME_SECONDS + 1):
            with self.assertRaises(Exception):
                rooms.get_room(room["code"])

        self.assertNotIn(room["code"], rooms.rooms)

    def test_cleanup_expired_removes_only_expired_rooms(self):
        with patch("app.rooms.time.time", return_value=1000):
            active_room = rooms.create_room()

        with patch("app.rooms.time.time", return_value=1000 + rooms.ROOM_LIFETIME_SECONDS + 1):
            expired_count = rooms.cleanup_expired()

        self.assertEqual(expired_count, 1)
        self.assertNotIn(active_room["code"], rooms.rooms)

    def test_signaling_validation_accepts_expected_payloads(self):
        self.assertTrue(_is_valid_signal({"type": "offer", "description": {}}))
        self.assertTrue(_is_valid_signal({"type": "answer", "description": {}}))
        self.assertTrue(_is_valid_signal({"type": "ice-candidate", "candidate": {}}))

    def test_signaling_validation_rejects_unknown_or_malformed_payloads(self):
        self.assertFalse(_is_valid_signal({"type": "file", "data": {}}))
        self.assertFalse(_is_valid_signal({"type": "offer"}))
        self.assertFalse(_is_valid_signal("not an object"))


if __name__ == "__main__":
    unittest.main()


class SignalingHandshakeTests(unittest.TestCase):
    """Guards the two-device handshake — the unit tests above never open a socket."""

    def setUp(self):
        rooms.rooms.clear()

    def tearDown(self):
        rooms.rooms.clear()

    def test_two_devices_connect_and_signaling_is_forwarded(self):
        from fastapi.testclient import TestClient

        from app.main import app

        client = TestClient(app)
        code = client.post("/rooms").json()["code"]

        with client.websocket_connect(f"/rooms/{code}/ws") as first:
            self.assertEqual(
                first.receive_json(),
                {"type": "room_state", "sessions": 1, "initiator": True},
            )
            with client.websocket_connect(f"/rooms/{code}/ws") as second:
                self.assertEqual(
                    second.receive_json(),
                    {"type": "room_state", "sessions": 2, "initiator": False},
                )
                self.assertEqual(first.receive_json(), {"type": "user_joined", "sessions": 2})

                second.send_json({"type": "offer", "description": {"sdp": "x", "type": "offer"}})
                self.assertEqual(first.receive_json()["type"], "offer")
