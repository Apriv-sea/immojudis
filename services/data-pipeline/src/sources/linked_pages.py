"""Bounded traversal of pagination links published by a source."""
from __future__ import annotations

import re
from urllib.parse import parse_qs, urljoin, urlparse

from bs4 import BeautifulSoup

from src.sources.common import is_allowed_origin_url


class LinkedPages:
    def __init__(self, start: str, key: str, first: int, limit: int, paths: tuple[str, ...] = (),
                 path_pattern: str | None = None):
        self.path_pattern = path_pattern
        self.start, self.key, self.first = start, key, first
        self.limit = max(1, limit)
        self.paths = paths or (urlparse(start).path,)
        self.pending = [start]
        self.seen: set[str] = set()
        self.fetched = 0

    def __iter__(self):
        while self.pending and len(self.seen) < self.limit:
            url = self.pending.pop(0)
            self.seen.add(url)
            yield url

    def observe(self, html: str, page_url: str) -> None:
        self.fetched += 1
        for link in BeautifulSoup(html, "html.parser").select("a[href]"):
            url = urljoin(page_url, str(link["href"]))
            parsed = urlparse(url)
            if not is_allowed_origin_url(url, (self.start,)):
                continue
            if self.path_pattern:
                match = re.fullmatch(self.path_pattern, parsed.path)
                if not match:
                    continue
                values = [match[1]]
            else:
                values = parse_qs(parsed.query).get(self.key, [])
                if parsed.path not in self.paths:
                    continue
            if len(values) != 1 or not values[0].isdigit():
                continue
            if int(values[0]) == self.first:
                url = self.start
            else:
                url = parsed._replace(fragment="").geturl()
            if url not in self.seen and url not in self.pending:
                self.pending.append(url)

    def metrics(self) -> dict:
        complete = not self.pending and self.fetched == len(self.seen)
        return {"pages_fetched": self.fetched, "linked_pages_complete": complete,
                "pending_pages": len(self.pending), "coverage_complete": None if complete else False,
                "coverage_basis": "published pagination links; no independent inventory total",
                "stop_reason": "published_links_exhausted" if complete else "page_limit_or_fetch_error"}
