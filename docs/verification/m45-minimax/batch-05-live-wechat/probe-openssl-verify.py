#!/usr/bin/env python3
"""直接调用 OpenSSL 的 X509_verify_cert，打印它实际构建出的链与错误码。

只处理公开证书，不涉及任何凭据。
"""

from __future__ import annotations

import ctypes
import ctypes.util
import pathlib
import ssl
import tempfile
import urllib.request

HOST = "data.wxrank.com"


def load_libcrypto():
    candidates = [
        "/Library/Frameworks/Python.framework/Versions/3.12/lib/libcrypto.3.dylib",
        "/usr/local/opt/openssl/lib/libcrypto.3.dylib",
        "/opt/homebrew/opt/openssl/lib/libcrypto.3.dylib",
        ctypes.util.find_library("crypto"),
    ]
    for candidate in candidates:
        if candidate and pathlib.Path(candidate).exists():
            return ctypes.CDLL(candidate)
    raise SystemExit("找不到 libcrypto")


def x509_of(der: bytes, lib):
    lib.d2i_X509.restype = ctypes.c_void_p
    lib.d2i_X509.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ubyte)]
    buf = ctypes.create_string_buffer(der, len(der))
    pointer = ctypes.cast(buf, ctypes.POINTER(ctypes.c_ubyte))
    handle = lib.d2i_X509(None, pointer)
    if not handle:
        raise SystemExit("解析证书失败")
    return handle


def _name_oneline(lib, name) -> str:
    lib.X509_NAME_oneline.restype = ctypes.c_char_p
    lib.X509_NAME_oneline.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    buf = ctypes.create_string_buffer(1024)
    lib.X509_NAME_oneline(name, buf, 1024)
    return buf.value.decode("utf-8", "replace")


def subject_cn(lib, x509) -> str:
    lib.X509_get_subject_name.restype = ctypes.c_void_p
    return _name_oneline(lib, lib.X509_get_subject_name(x509))


def issuer_cn(lib, x509) -> str:
    lib.X509_get_issuer_name.restype = ctypes.c_void_p
    return _name_oneline(lib, lib.X509_get_issuer_name(x509))


def verify(lib, leaf_der: bytes, ca_blocks: list[str], label: str) -> None:
    lib.X509_STORE_new.restype = ctypes.c_void_p
    lib.X509_STORE_add_cert.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    lib.X509_STORE_CTX_new.restype = ctypes.c_void_p
    lib.X509_STORE_CTX_init.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    lib.X509_verify_cert.argtypes = [ctypes.c_void_p]
    lib.X509_verify_cert.restype = ctypes.c_int
    lib.X509_STORE_CTX_get_error.restype = ctypes.c_int
    lib.X509_STORE_CTX_get_error.argtypes = [ctypes.c_void_p]
    lib.X509_verify_cert_error_string.restype = ctypes.c_char_p
    lib.X509_verify_cert_error_string.argtypes = [ctypes.c_int]
    lib.X509_STORE_CTX_get0_chain.restype = ctypes.c_void_p
    lib.X509_STORE_CTX_get0_chain.argtypes = [ctypes.c_void_p]
    lib.OPENSSL_sk_num.restype = ctypes.c_int
    lib.OPENSSL_sk_num.argtypes = [ctypes.c_void_p]
    lib.OPENSSL_sk_value.restype = ctypes.c_void_p
    lib.OPENSSL_sk_value.argtypes = [ctypes.c_void_p, ctypes.c_int]

    store = lib.X509_STORE_new()
    for block in ca_blocks:
        ca = x509_of(block.encode(), lib)
        lib.X509_STORE_add_cert(store, ca)
    leaf = x509_of(leaf_der, lib)
    ctx = lib.X509_STORE_CTX_new()
    lib.X509_STORE_CTX_init(ctx, store, leaf, None)
    result = lib.X509_verify_cert(ctx)
    error = lib.X509_STORE_CTX_get_error(ctx)
    message = lib.X509_verify_cert_error_string(error).decode("utf-8", "replace")
    chain = lib.X509_STORE_CTX_get0_chain(ctx)
    names = []
    if chain:
        for index in range(lib.OPENSSL_sk_num(chain)):
            item = lib.OPENSSL_sk_value(chain, index)
            names.append(f"{subject_cn(lib, item)} <- {issuer_cn(lib, item)}")
    print(f"  [{label}] 结果={result} 错误码={error} ({message})")
    for name in names:
        print(f"        链上证书: {name}")


def main() -> int:
    lib = load_libcrypto()
    print(f"libcrypto: {lib._name}")

    leaf_pem = ssl.get_server_certificate((HOST, 443), timeout=15)
    import base64

    leaf_der = base64.decodebytes("".join(
        line for line in leaf_pem.splitlines() if not line.startswith("-----")).encode("ascii"))

    import certifi

    text = pathlib.Path(certifi.where()).read_text(encoding="utf-8", errors="replace")
    marker = "-----BEGIN CERTIFICATE-----"
    blocks = [
        marker + part.split("-----END CERTIFICATE-----")[0] + "-----END CERTIFICATE-----\n"
        for part in text.split(marker)[1:]
    ]
    by_cn = {}
    for index, block in enumerate(blocks):
        path = pathlib.Path(tempfile.mkdtemp()) / f"c{index}.pem"
        path.write_text(block)
        try:
            decoded = ssl._ssl._test_decode_cert(str(path))
        except Exception:  # noqa: BLE001
            continue
        by_cn.setdefault(dict(x[0] for x in decoded["subject"]).get("commonName", ""), block)

    system = ""
    system_path = pathlib.Path("/etc/ssl/cert.pem")
    if system_path.is_file():
        system_text = system_path.read_text(encoding="utf-8", errors="replace")
        system_blocks = [
            marker + part.split("-----END CERTIFICATE-----")[0] + "-----END CERTIFICATE-----\n"
            for part in system_text.split(marker)[1:]
        ]
        for index, block in enumerate(system_blocks):
            path = pathlib.Path(tempfile.mkdtemp()) / f"s{index}.pem"
            path.write_text(block)
            try:
                decoded = ssl._ssl._test_decode_cert(str(path))
            except Exception:  # noqa: BLE001
                continue
            cn = dict(x[0] for x in decoded["subject"]).get("commonName", "")
            if "YE" in cn.upper():
                system = block
                print(f"系统包里找到 YE 系证书: {cn}")

    print("\n--- OpenSSL 验签结果 ---")
    verify(lib, leaf_der, [], "空 store")
    verify(lib, leaf_der, [by_cn.get("ISRG Root X1", "")], "仅 X1")
    verify(lib, leaf_der, [by_cn.get("ISRG Root X2", "")], "仅 X2")
    if system:
        verify(lib, leaf_der, [system], "仅系统包里的 YE 系证书")
    verify(lib, leaf_der, list(by_cn.values()), "全部 certifi")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
