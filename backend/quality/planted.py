"""The violations planted in the DEV chats (design section 4), as the answer each must get.

Used to check the reference answers and, in the model choice, that a model catches every one.
If the team review disagrees with an entry, change it here and give the reason in the PR.
"""

from __future__ import annotations

PLANTED: list[tuple[str, str, str | dict]] = [
    *[(c, "c01", "no") for c in ("p1-ru-014", "p1-kz-008", "p1-en-015")],
    *[(c, "c03", "no") for c in ("p1-ru-009", "p1-kz-015", "p1-en-014")],
    ("p1-ru-029", "c05", "no"),
    *[(c, "c04", {"step": 0}) for c in ("p1-ru-018", "p1-ru-026")],
    ("p1-ru-025", "c04", "na"),
    *[(c, "c07", "no") for c in ("p1-ru-018", "p1-ru-026", "p1-kz-005")],
    *[(c, "c07", "na") for c in ("p1-ru-025", "p1-ru-012", "p1-kz-011", "p1-en-009")],
    *[(c, "c08", "yes") for c in ("p1-ru-022", "p1-ru-023", "p1-kz-013", "p1-en-013", "p1-ru-029",
                                  "p1-ru-009", "p1-kz-015", "p1-en-014")],
]
