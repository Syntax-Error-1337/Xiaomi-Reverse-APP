"""miIO UDP wire format: packet crypto + minimal JSON-RPC session.

Port of openhome-server/lib/src/scene_runner.dart (MiioPacket/MiioSession).
Stdlib only: AES-128-CBC is implemented here (FIPS-197) so the pinned
known-answer vector holds on any machine with no extra dependencies.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import socket
import struct
import time

_SBOX = tuple(
    b
    for row in (
        (0x63, 0x7C, 0x77, 0x7B, 0xF2, 0x6B, 0x6F, 0xC5, 0x30, 0x01, 0x67, 0x2B, 0xFE, 0xD7, 0xAB, 0x76),
        (0xCA, 0x82, 0xC9, 0x7D, 0xFA, 0x59, 0x47, 0xF0, 0xAD, 0xD4, 0xA2, 0xAF, 0x9C, 0xA4, 0x72, 0xC0),
        (0xB7, 0xFD, 0x93, 0x26, 0x36, 0x3F, 0xF7, 0xCC, 0x34, 0xA5, 0xE5, 0xF1, 0x71, 0xD8, 0x31, 0x15),
        (0x04, 0xC7, 0x23, 0xC3, 0x18, 0x96, 0x05, 0x9A, 0x07, 0x12, 0x80, 0xE2, 0xEB, 0x27, 0xB2, 0x75),
        (0x09, 0x83, 0x2C, 0x1A, 0x1B, 0x6E, 0x5A, 0xA0, 0x52, 0x3B, 0xD6, 0xB3, 0x29, 0xE3, 0x2F, 0x84),
        (0x53, 0xD1, 0x00, 0xED, 0x20, 0xFC, 0xB1, 0x5B, 0x6A, 0xCB, 0xBE, 0x39, 0x4A, 0x4C, 0x58, 0xCF),
        (0xD0, 0xEF, 0xAA, 0xFB, 0x43, 0x4D, 0x33, 0x85, 0x45, 0xF9, 0x02, 0x7F, 0x50, 0x3C, 0x9F, 0xA8),
        (0x51, 0xA3, 0x40, 0x8F, 0x92, 0x9D, 0x38, 0xF5, 0xBC, 0xB6, 0xDA, 0x21, 0x10, 0xFF, 0xF3, 0xD2),
        (0xCD, 0x0C, 0x13, 0xEC, 0x5F, 0x97, 0x44, 0x17, 0xC4, 0xA7, 0x7E, 0x3D, 0x64, 0x5D, 0x19, 0x73),
        (0x60, 0x81, 0x4F, 0xDC, 0x22, 0x2A, 0x90, 0x88, 0x46, 0xEE, 0xB8, 0x14, 0xDE, 0x5E, 0x0B, 0xDB),
        (0xE0, 0x32, 0x3A, 0x0A, 0x49, 0x06, 0x24, 0x5C, 0xC2, 0xD3, 0xAC, 0x62, 0x91, 0x95, 0xE4, 0x79),
        (0xE7, 0xC8, 0x37, 0x6D, 0x8D, 0xD5, 0x4E, 0xA9, 0x6C, 0x56, 0xF4, 0xEA, 0x65, 0x7A, 0xAE, 0x08),
        (0xBA, 0x78, 0x25, 0x2E, 0x1C, 0xA6, 0xB4, 0xC6, 0xE8, 0xDD, 0x74, 0x1F, 0x4B, 0xBD, 0x8B, 0x8A),
        (0x70, 0x3E, 0xB5, 0x66, 0x48, 0x03, 0xF6, 0x0E, 0x61, 0x35, 0x57, 0xB9, 0x86, 0xC1, 0x1D, 0x9E),
        (0xE1, 0xF8, 0x98, 0x11, 0x69, 0xD9, 0x8E, 0x94, 0x9B, 0x1E, 0x87, 0xE9, 0xCE, 0x55, 0x28, 0xDF),
        (0x8C, 0xA1, 0x89, 0x0D, 0xBF, 0xE6, 0x42, 0x68, 0x41, 0x99, 0x2D, 0x0F, 0xB0, 0x54, 0xBB, 0x16),
    )
    for b in row
)

_INV_SBOX = tuple(
    b
    for row in (
        (0x52, 0x09, 0x6A, 0xD5, 0x30, 0x36, 0xA5, 0x38, 0xBF, 0x40, 0xA3, 0x9E, 0x81, 0xF3, 0xD7, 0xFB),
        (0x7C, 0xE3, 0x39, 0x82, 0x9B, 0x2F, 0xFF, 0x87, 0x34, 0x8E, 0x43, 0x44, 0xC4, 0xDE, 0xE9, 0xCB),
        (0x54, 0x7B, 0x94, 0x32, 0xA6, 0xC2, 0x23, 0x3D, 0xEE, 0x4C, 0x95, 0x0B, 0x42, 0xFA, 0xC3, 0x4E),
        (0x08, 0x2E, 0xA1, 0x66, 0x28, 0xD9, 0x24, 0xB2, 0x76, 0x5B, 0xA2, 0x49, 0x6D, 0x8B, 0xD1, 0x25),
        (0x72, 0xF8, 0xF6, 0x64, 0x86, 0x68, 0x98, 0x16, 0xD4, 0xA4, 0x5C, 0xCC, 0x5D, 0x65, 0xB6, 0x92),
        (0x6C, 0x70, 0x48, 0x50, 0xFD, 0xED, 0xB9, 0xDA, 0x5E, 0x15, 0x46, 0x57, 0xA7, 0x8D, 0x9D, 0x84),
        (0x90, 0xD8, 0xAB, 0x00, 0x8C, 0xBC, 0xD3, 0x0A, 0xF7, 0xE4, 0x58, 0x05, 0xB8, 0xB3, 0x45, 0x06),
        (0xD0, 0x2C, 0x1E, 0x8F, 0xCA, 0x3F, 0x0F, 0x02, 0xC1, 0xAF, 0xBD, 0x03, 0x01, 0x13, 0x8A, 0x6B),
        (0x3A, 0x91, 0x11, 0x41, 0x4F, 0x67, 0xDC, 0xEA, 0x97, 0xF2, 0xCF, 0xCE, 0xF0, 0xB4, 0xE6, 0x73),
        (0x96, 0xAC, 0x74, 0x22, 0xE7, 0xAD, 0x35, 0x85, 0xE2, 0xF9, 0x37, 0xE8, 0x1C, 0x75, 0xDF, 0x6E),
        (0x47, 0xF1, 0x1A, 0x71, 0x1D, 0x29, 0xC5, 0x89, 0x6F, 0xB7, 0x62, 0x0E, 0xAA, 0x18, 0xBE, 0x1B),
        (0xFC, 0x56, 0x3E, 0x4B, 0xC6, 0xD2, 0x79, 0x20, 0x9A, 0xDB, 0xC0, 0xFE, 0x78, 0xCD, 0x5A, 0xF4),
        (0x1F, 0xDD, 0xA8, 0x33, 0x88, 0x07, 0xC7, 0x31, 0xB1, 0x12, 0x10, 0x59, 0x27, 0x80, 0xEC, 0x5F),
        (0x60, 0x51, 0x7F, 0xA9, 0x19, 0xB5, 0x4A, 0x0D, 0x2D, 0xE5, 0x7A, 0x9F, 0x93, 0xC9, 0x9C, 0xEF),
        (0xA0, 0xE0, 0x3B, 0x4D, 0xAE, 0x2A, 0xF5, 0xB0, 0xC8, 0xEB, 0xBB, 0x3C, 0x83, 0x53, 0x99, 0x61),
        (0x17, 0x2B, 0x04, 0x7E, 0xBA, 0x77, 0xD6, 0x26, 0xE1, 0x69, 0x14, 0x63, 0x55, 0x21, 0x0C, 0x7D),
    )
    for b in row
)

_RCON = (0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36)


def _xtime(a: int) -> int:
    return (((a << 1) ^ 0x1B) & 0xFF) if a & 0x80 else ((a << 1) & 0xFF)


def _gmul(a: int, b: int) -> int:
    p = 0
    for _ in range(8):
        if b & 1:
            p ^= a
        hi = a & 0x80
        a = (a << 1) & 0xFF
        if hi:
            a ^= 0x1B
        b >>= 1
    return p


def _expand_key(key: bytes) -> list:
    ek = list(key)
    for i in range(16, 176, 4):
        t = ek[i - 4 : i]
        if i % 16 == 0:
            t = t[1:] + t[:1]
            t = [_SBOX[b] for b in t]
            t[0] ^= _RCON[i // 16 - 1]
        ek += [a ^ b for a, b in zip(t, ek[i - 16 : i])]
    return ek


def _add(s: list, ek: list, rnd: int) -> None:
    base = rnd * 16
    for i in range(16):
        s[i] ^= ek[base + i]


def _sub(s: list) -> None:
    for i in range(16):
        s[i] = _SBOX[s[i]]


def _inv_sub(s: list) -> None:
    for i in range(16):
        s[i] = _INV_SBOX[s[i]]


def _shift(s: list) -> None:
    s[1], s[5], s[9], s[13] = s[5], s[9], s[13], s[1]
    s[2], s[6], s[10], s[14] = s[10], s[14], s[2], s[6]
    s[3], s[7], s[11], s[15] = s[15], s[3], s[7], s[11]


def _inv_shift(s: list) -> None:
    s[1], s[5], s[9], s[13] = s[13], s[1], s[5], s[9]
    s[2], s[6], s[10], s[14] = s[10], s[14], s[2], s[6]
    s[3], s[7], s[11], s[15] = s[7], s[11], s[15], s[3]


def _mix(s: list) -> None:
    for c in range(4):
        o = 4 * c
        a0, a1, a2, a3 = s[o], s[o + 1], s[o + 2], s[o + 3]
        s[o] = _xtime(a0) ^ (_xtime(a1) ^ a1) ^ a2 ^ a3
        s[o + 1] = a0 ^ _xtime(a1) ^ (_xtime(a2) ^ a2) ^ a3
        s[o + 2] = a0 ^ a1 ^ _xtime(a2) ^ (_xtime(a3) ^ a3)
        s[o + 3] = (_xtime(a0) ^ a0) ^ a1 ^ a2 ^ _xtime(a3)


def _inv_mix(s: list) -> None:
    for c in range(4):
        o = 4 * c
        a0, a1, a2, a3 = s[o], s[o + 1], s[o + 2], s[o + 3]
        s[o] = _gmul(a0, 0x0E) ^ _gmul(a1, 0x0B) ^ _gmul(a2, 0x0D) ^ _gmul(a3, 0x09)
        s[o + 1] = _gmul(a0, 0x09) ^ _gmul(a1, 0x0E) ^ _gmul(a2, 0x0B) ^ _gmul(a3, 0x0D)
        s[o + 2] = _gmul(a0, 0x0D) ^ _gmul(a1, 0x09) ^ _gmul(a2, 0x0E) ^ _gmul(a3, 0x0B)
        s[o + 3] = _gmul(a0, 0x0B) ^ _gmul(a1, 0x0D) ^ _gmul(a2, 0x09) ^ _gmul(a3, 0x0E)


def _encrypt_block(block: bytes, ek: list) -> bytes:
    s = list(block)
    _add(s, ek, 0)
    for rnd in range(1, 10):
        _sub(s)
        _shift(s)
        _mix(s)
        _add(s, ek, rnd)
    _sub(s)
    _shift(s)
    _add(s, ek, 10)
    return bytes(s)


def _decrypt_block(block: bytes, ek: list) -> bytes:
    s = list(block)
    _add(s, ek, 10)
    for rnd in range(9, 0, -1):
        _inv_shift(s)
        _inv_sub(s)
        _add(s, ek, rnd)
        _inv_mix(s)
    _inv_shift(s)
    _inv_sub(s)
    _add(s, ek, 0)
    return bytes(s)


def aes128_cbc_encrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    """AES-128-CBC encrypt. data must be non-empty and block-aligned."""
    if len(key) != 16 or len(iv) != 16 or not data or len(data) % 16 != 0:
        raise ValueError("AES-CBC needs 16-byte key/iv and block-aligned input")
    ek = _expand_key(key)
    out = bytearray()
    prev = iv
    for off in range(0, len(data), 16):
        enc = _encrypt_block(bytes(a ^ b for a, b in zip(data[off : off + 16], prev)), ek)
        out += enc
        prev = enc
    return bytes(out)


def aes128_cbc_decrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    """AES-128-CBC decrypt. data must be non-empty and block-aligned."""
    if len(key) != 16 or len(iv) != 16 or not data or len(data) % 16 != 0:
        raise ValueError("AES-CBC needs 16-byte key/iv and block-aligned input")
    ek = _expand_key(key)
    out = bytearray()
    prev = iv
    for off in range(0, len(data), 16):
        blk = data[off : off + 16]
        dec = _decrypt_block(blk, ek)
        out += bytes(a ^ b for a, b in zip(dec, prev))
        prev = blk
    return bytes(out)


class MiioPacket:
    """miIO packet framing. Byte-identical to the app + Dart server."""

    MAGIC = 0x2131
    HEADER_LEN = 32
    PORT = 54321

    @staticmethod
    def hello() -> bytes:
        return struct.pack(">HH", MiioPacket.MAGIC, MiioPacket.HEADER_LEN) + b"\xff" * 28

    @staticmethod
    def _md5(data: bytes) -> bytes:
        return hashlib.md5(data).digest()

    @staticmethod
    def encrypt(payload: bytes, token: bytes, *, device_id: int, timestamp: int) -> bytes:
        key = MiioPacket._md5(token)
        iv = MiioPacket._md5(key + token)
        pad = 16 - (len(payload) % 16)
        ct = aes128_cbc_encrypt(key, iv, payload + bytes([pad]) * pad)
        header = struct.pack(
            ">HHIII",
            MiioPacket.MAGIC,
            MiioPacket.HEADER_LEN + len(ct),
            0,
            device_id & 0xFFFFFFFF,
            timestamp & 0xFFFFFFFF,
        )
        checksum = MiioPacket._md5(header[:16] + token + ct)
        return header + checksum + ct

    @staticmethod
    def decrypt(packet: bytes, token: bytes) -> bytes:
        if len(packet) < MiioPacket.HEADER_LEN:
            raise ValueError("miIO packet shorter than header")
        magic, length = struct.unpack(">HH", packet[:4])
        if magic != MiioPacket.MAGIC:
            raise ValueError("bad miIO magic")
        if length != len(packet):
            raise ValueError("miIO length mismatch")
        key = MiioPacket._md5(token)
        iv = MiioPacket._md5(key + token)
        ct = packet[MiioPacket.HEADER_LEN :]
        want = MiioPacket._md5(packet[:16] + token + ct)
        if not hmac.compare_digest(packet[16:32], want):
            raise ValueError("miIO checksum mismatch")
        padded = aes128_cbc_decrypt(key, iv, ct)
        if not padded:
            raise ValueError("empty miIO payload")
        pad = padded[-1]
        if pad < 1 or pad > 16 or pad > len(padded):
            raise ValueError("bad PKCS7 padding")
        return padded[:-pad]

    @staticmethod
    def device_id_of(packet: bytes) -> int:
        return struct.unpack(">I", packet[8:12])[0]

    @staticmethod
    def timestamp_of(packet: bytes) -> int:
        return struct.unpack(">I", packet[12:16])[0]


class MiioSession:
    """Minimal miIO UDP session (HELLO + JSON-RPC), same semantics as Dart."""

    def __init__(self, ip: str, token: bytes) -> None:
        self._ip = ip
        self._token = bytes(token)
        self._id = 1
        self._did = None
        self._stamp_base = None
        self._stamp_epoch = None

    def connect(self) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(3)
        try:
            sock.sendto(MiioPacket.hello(), (self._ip, MiioPacket.PORT))
            while True:
                try:
                    data, addr = sock.recvfrom(65535)
                except socket.timeout:
                    raise RuntimeError("handshake timed out (%s)" % self._ip)
                if addr[0] == self._ip and len(data) >= MiioPacket.HEADER_LEN:
                    self._did = MiioPacket.device_id_of(data)
                    self._stamp_base = MiioPacket.timestamp_of(data)
                    self._stamp_epoch = time.monotonic()
                    return
        finally:
            sock.close()

    def call(self, method: str, params) -> object:
        if self._did is None or self._stamp_base is None or self._stamp_epoch is None:
            self.connect()
        payload = json.dumps({"id": self._id, "method": method, "params": params}).encode("utf-8")
        self._id += 1
        stamp = self._stamp_base + int(time.monotonic() - self._stamp_epoch)
        packet = MiioPacket.encrypt(payload, self._token, device_id=self._did, timestamp=stamp)
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(5)
        try:
            sock.sendto(packet, (self._ip, MiioPacket.PORT))
            while True:
                try:
                    data, addr = sock.recvfrom(65535)
                except socket.timeout:
                    raise RuntimeError("request %s timed out (%s)" % (method, self._ip))
                if addr[0] != self._ip or len(data) <= MiioPacket.HEADER_LEN:
                    continue
                try:
                    plain = MiioPacket.decrypt(data, self._token)
                except ValueError:
                    continue  # not our reply; keep waiting
                try:
                    msg = json.loads(plain.decode("utf-8"))
                except ValueError:
                    continue
                if isinstance(msg, dict) and msg.get("id") == self._id - 1:
                    if "error" in msg:
                        raise RuntimeError("device error: %s" % (msg["error"],))
                    return msg.get("result")
        finally:
            sock.close()
