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
