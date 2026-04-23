from arrsync.services.arr_client import ArrClient


def test_validate_webhook_secret():
    assert ArrClient.validate_webhook_secret("abc", "abc")
    assert not ArrClient.validate_webhook_secret("abc", "abcd")
