"""Shared transfer metrics backed by Upstash Redis when configured."""

import os

try:
    from upstash_redis import Redis
except ImportError:  # Redis support is optional during local development.
    Redis = None  # type: ignore[assignment,misc]

TRANSFER_COUNT_KEY = "pydrop:transfers:completed"
_local_transfer_count = 0
_redis = None

redis_url = os.getenv("UPSTASH_REDIS_REST_URL")
redis_token = os.getenv("UPSTASH_REDIS_REST_TOKEN")
if Redis and redis_url and redis_token:
    _redis = Redis(url=redis_url, token=redis_token)


def get_transfer_count() -> int:
    if _redis is None:
        return _local_transfer_count
    value = _redis.get(TRANSFER_COUNT_KEY)
    return int(value or 0)


def record_transfer() -> int:
    global _local_transfer_count
    if _redis is None:
        _local_transfer_count += 1
        return _local_transfer_count
    return int(_redis.incr(TRANSFER_COUNT_KEY))
