"""File bytes on disk. PostgreSQL's `storage` table says which files exist; this module only moves bytes.

Layout (content-addressed: the path comes from the file's SHA-256):
    storage/tmp/<random>                    uploads while they are being received and checked
    storage/dicom/ab/cd/<sha256>.dcm        received DICOM objects
    storage/derived/ab/cd/<sha256>.dcm      DICOM slices made from a NIfTI volume
    storage/nifti/ab/cd/<sha256>.nii[.gz]   uploaded NIfTI volumes, unchanged
Short paths (about 150 characters with the folder) stay under Windows' 260-character limit, and the
hash doubles as an integrity check: re-hash a file and compare with storage.sha256.
"""
import hashlib
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

from app.core.config import get_settings

CHUNK = 1024 * 1024


class TooLarge(ValueError):
    pass


@dataclass
class Received:
    """An upload saved to storage/tmp, with its size and hash worked out while it was written."""
    path: Path
    original_name: str
    size: int
    sha256: str


def root() -> Path:
    return get_settings().storage_path


def absolute(relative_path: str) -> Path:
    path = (root() / relative_path).resolve()
    if root().resolve() not in path.parents:
        raise ValueError("path outside storage")
    return path


def receive(stream, original_name: str) -> Received:
    """Copy an upload stream to storage/tmp in 1 MB chunks, hashing as it goes (never all in memory)."""
    limit = get_settings().max_upload_mb * 1024 * 1024
    tmp_dir = root() / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    path = tmp_dir / secrets.token_hex(16)
    digest, size = hashlib.sha256(), 0
    try:
        with open(path, "wb") as out:
            while chunk := stream.read(CHUNK):
                size += len(chunk)
                if size > limit:
                    raise TooLarge(f"{original_name}: lebih besar dari {get_settings().max_upload_mb} MB")
                digest.update(chunk)
                out.write(chunk)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return Received(path=path, original_name=os.path.basename(original_name or "upload"), size=size,
                    sha256=digest.hexdigest())


def receive_bytes(data: bytes, original_name: str) -> Received:
    import io
    return receive(io.BytesIO(data), original_name)


def relative_path_for(kind: str, sha256: str, suffix: str) -> str:
    folder = {"dicom": "dicom", "derived": "derived", "nifti_source": "nifti"}[kind]
    return f"{folder}/{sha256[:2]}/{sha256[2:4]}/{sha256}{suffix}"


def place(received: Received, relative_path: str) -> bool:
    """Move a received file to its final place. Returns True if this call created the file
    (so it must be deleted again if the database transaction fails), False if it was already there."""
    target = absolute(relative_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():                 # same hash = same bytes: keep the copy we have
        received.path.unlink(missing_ok=True)
        return False
    os.replace(received.path, target)
    return True


def discard(paths) -> None:
    for p in paths:
        try:
            Path(p).unlink(missing_ok=True)
        except OSError:
            pass
