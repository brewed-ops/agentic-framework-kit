from greet import greet


def test_greet():
    assert greet("CI") == "Hello, CI"
