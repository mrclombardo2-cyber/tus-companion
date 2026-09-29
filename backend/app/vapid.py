from __future__ import annotations
import base64
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization


def generate(private_path: Path, public_path: Path | None = None) -> str:
    private_path.parent.mkdir(parents=True, exist_ok=True)
    key = ec.generate_private_key(ec.SECP256R1())
    private_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    pub = key.public_key().public_numbers()
    raw = b"\x04" + pub.x.to_bytes(32, "big") + pub.y.to_bytes(32, "big")
    public = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
    if public_path:
        public_path.parent.mkdir(parents=True, exist_ok=True)
        public_path.write_text(public, encoding="utf-8")
    return public
