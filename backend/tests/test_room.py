from app.room import normalize_room, mappedin_directions_url


def test_room_normalization_and_route():
    assert normalize_room("C1164 Earl of Rosse") == ("C1164", "Earl of Rosse")
    url = mappedin_directions_url("C1164", "C74", accessible=True)
    assert "/directions?location=C1164" in url
    assert "departure=C74" in url
    assert "accessible=true" in url
