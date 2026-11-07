import httpx
import pytest
import respx

from audio.source import AudioSourceError, download_mp3, parse_player_page, resolve_mp3_url

PAGE = """<!DOCTYPE html><html><body>
<audio id="myAudio" controls style="width:100%;">
    <source src="https://media.example.test/rec.mp3?a=1&amp;sig=SECRET" type="audio/mpeg">
</audio></body></html>"""


def test_parse_player_page_unescapes_the_link():
    assert parse_player_page(PAGE) == "https://media.example.test/rec.mp3?a=1&sig=SECRET"


def test_parse_player_page_without_source():
    with pytest.raises(AudioSourceError):
        parse_player_page("<html><body>nothing here</body></html>")


@respx.mock
async def test_resolve_mp3_url_reads_the_player_page():
    respx.get("https://player.example.test/p?sig=PAGESECRET").mock(
        return_value=httpx.Response(200, text=PAGE, headers={"content-type": "text/html"}))
    url = await resolve_mp3_url("https://player.example.test/p?sig=PAGESECRET")
    assert url.startswith("https://media.example.test/rec.mp3")


@respx.mock
async def test_errors_never_contain_the_link():
    respx.get("https://player.example.test/p?sig=PAGESECRET").mock(return_value=httpx.Response(403))
    with pytest.raises(AudioSourceError) as e:
        await resolve_mp3_url("https://player.example.test/p?sig=PAGESECRET")
    assert "sig" not in str(e.value) and "player.example.test" in str(e.value)


@respx.mock
async def test_download_mp3_saves_atomically(tmp_path):
    respx.get("https://player.example.test/p?sig=X").mock(
        return_value=httpx.Response(200, text=PAGE, headers={"content-type": "text/html"}))
    respx.get("https://media.example.test/rec.mp3?a=1&sig=SECRET").mock(
        return_value=httpx.Response(200, content=b"ID3" + b"\x00" * 100))
    dest = await download_mp3("https://player.example.test/p?sig=X", tmp_path / "c.mp3")
    assert dest.read_bytes().startswith(b"ID3")
    assert not (tmp_path / "c.mp3.part").exists()


@respx.mock
async def test_download_rejects_non_audio(tmp_path):
    respx.get("https://player.example.test/p?sig=X").mock(
        return_value=httpx.Response(200, text=PAGE, headers={"content-type": "text/html"}))
    respx.get("https://media.example.test/rec.mp3?a=1&sig=SECRET").mock(
        return_value=httpx.Response(200, content=b"<html>expired</html>"))
    with pytest.raises(AudioSourceError):
        await download_mp3("https://player.example.test/p?sig=X", tmp_path / "c.mp3")
    assert not (tmp_path / "c.mp3").exists()
