"""Isolated, bounded document parser. The CLI receives bytes on stdin, never paths."""

import csv
import io
import json
import resource
import sys

from pypdf import PdfReader

DOCUMENT_MIME_TYPES = {
    "text/plain",
    "text/markdown",
    "text/csv",
    "text/tab-separated-values",
    "application/pdf",
}
MAX_TEXT_BYTES = 2 * 1024 * 1024
MAX_PDF_BYTES = 10 * 1024 * 1024
MAX_CHARS = 200_000
MAX_ROWS = 5_000
MAX_PAGES = 100


class ExtractionError(Exception):
    def __init__(self, category: str) -> None:
        super().__init__(category)


def extract(data: bytes, mime: str) -> dict[str, object]:
    if (
        mime not in DOCUMENT_MIME_TYPES
        or not data
        or len(data) > (MAX_PDF_BYTES if mime == "application/pdf" else MAX_TEXT_BYTES)
    ):
        raise ExtractionError("extraction limit")
    segments: list[dict[str, str]] = []
    chars = 0
    truncated: str | None = None
    if mime == "application/pdf":
        if not data.startswith(b"%PDF-"):
            raise ExtractionError("invalid signature")
        try:
            reader = PdfReader(io.BytesIO(data), strict=True)
            if reader.is_encrypted:
                raise ExtractionError("encrypted pdf")
            for index, page in enumerate(reader.pages):
                if index >= MAX_PAGES:
                    truncated = "page limit"
                    break
                text = page.extract_text() or ""
                if not text.strip():
                    continue
                text = text.replace("\r\n", "\n").replace("\r", "\n")
                if chars + len(text) > MAX_CHARS:
                    truncated = "character limit"
                    if not segments:
                        segments.append(
                            {"location": f"page {index + 1} (partial)", "text": text[:MAX_CHARS]}
                        )
                        chars = MAX_CHARS
                    break
                segments.append({"location": f"page {index + 1}", "text": text})
                chars += len(text)
        except ExtractionError:
            raise
        except Exception:
            raise ExtractionError("malformed pdf") from None
        if not segments:
            raise ExtractionError("textless pdf")
        method = "pypdf"
    else:
        try:
            text = data.decode("utf-8-sig", errors="strict")
        except UnicodeError:
            raise ExtractionError("invalid text") from None
        if any(
            (ord(char) < 32 and char not in "\t\n\f\r")
            or 0x7F <= ord(char) <= 0x9F
            or char == "\ufeff"
            for char in text
        ):
            raise ExtractionError("invalid text")
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        if not text.strip():
            raise ExtractionError("invalid text")
        if mime in {"text/csv", "text/tab-separated-values"}:
            try:
                rows = csv.reader(
                    io.StringIO(text, newline=""),
                    delimiter="," if mime == "text/csv" else "\t",
                    strict=True,
                )
                for index, row in enumerate(rows):
                    if index >= MAX_ROWS:
                        truncated = "row limit"
                        break
                    # JSON preserves cells as inert strings, including formula-like values.
                    rendered = json.dumps(row, ensure_ascii=False)
                    if chars + len(rendered) > MAX_CHARS:
                        truncated = "character limit"
                        break
                    segments.append({"location": f"row {index + 1}", "text": rendered})
                    chars += len(rendered)
            except (csv.Error, ValueError):
                raise ExtractionError("invalid csv") from None
            method = "csv.reader"
        else:
            # Stop at a complete line when possible; preserve text without reinterpreting markup.
            for index, line in enumerate(text.splitlines(keepends=True)):
                if chars + len(line) > MAX_CHARS:
                    truncated = "character limit"
                    if not segments:
                        segments.append(
                            {"location": f"line {index + 1} (partial)", "text": line[:MAX_CHARS]}
                        )
                        chars = MAX_CHARS
                    break
                segments.append({"location": f"line {index + 1}", "text": line})
                chars += len(line)
            method = "utf-8"
        if not segments:
            raise ExtractionError("extraction limit")
    return {
        "method": method,
        "sourceBytes": len(data),
        "characters": chars,
        "truncated": truncated,
        "segments": segments,
    }


def main() -> None:
    try:
        # Defense in depth alongside the parent's killable wall-clock timeout.
        if sys.platform == "linux":
            resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (12, 12))
        mime = sys.argv[1]
        limit = MAX_PDF_BYTES if mime == "application/pdf" else MAX_TEXT_BYTES
        data = sys.stdin.buffer.read(limit + 1)
        result = extract(data, mime)
    except ExtractionError as error:
        sys.stdout.write(str(error))
        sys.exit(1)
    except Exception:
        sys.stdout.write("extraction failed")
        sys.exit(1)
    sys.stdout.write(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
