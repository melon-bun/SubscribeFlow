"""Offline, explicit-ABI libcrypto verification of frozen public certificates."""
import argparse
import ctypes as C
import json
import re
from pathlib import Path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--lib', required=True)
    args = ap.parse_args()
    lib = C.CDLL(args.lib)
    P, I, U, S = C.c_void_p, C.c_int, C.c_uint, C.c_char_p

    def bind(name, result, *parameters):
        fn = getattr(lib, name)
        fn.restype, fn.argtypes = result, list(parameters)
        return fn

    version = bind('OpenSSL_version', S, I)
    bio_new = bind('BIO_new_mem_buf', P, P, I)
    bio_free = bind('BIO_free', I, P)
    pem_read = bind('PEM_read_bio_X509', P, P, P, P, P)
    cert_free = bind('X509_free', None, P)
    subject = bind('X509_get_subject_name', P, P)
    issuer = bind('X509_get_issuer_name', P, P)
    name_line = bind('X509_NAME_oneline', P, P, P, I)
    digest = bind('X509_digest', I, P, P, P, C.POINTER(U))
    sha256 = bind('EVP_sha256', P)
    public_key = bind('X509_get_pubkey', P, P)
    key_free = bind('EVP_PKEY_free', None, P)
    verify_signature = bind('X509_verify', I, P, P)
    store_new = bind('X509_STORE_new', P)
    store_free = bind('X509_STORE_free', None, P)
    store_add = bind('X509_STORE_add_cert', I, P, P)
    ctx_new = bind('X509_STORE_CTX_new', P)
    ctx_free = bind('X509_STORE_CTX_free', None, P)
    ctx_init = bind('X509_STORE_CTX_init', I, P, P, P, P)
    ctx_purpose = bind('X509_STORE_CTX_set_purpose', I, P, I)
    ctx_param = bind('X509_STORE_CTX_get0_param', P, P)
    set_host = bind('X509_VERIFY_PARAM_set1_host', I, P, S, C.c_size_t)
    verify = bind('X509_verify_cert', I, P)
    error_code = bind('X509_STORE_CTX_get_error', I, P)
    error_depth = bind('X509_STORE_CTX_get_error_depth', I, P)
    error_text = bind('X509_verify_cert_error_string', S, C.c_long)
    get_chain = bind('X509_STORE_CTX_get1_chain', P, P)
    sk_new = bind('OPENSSL_sk_new_null', P)
    sk_push = bind('OPENSSL_sk_push', I, P, P)
    sk_num = bind('OPENSSL_sk_num', I, P)
    sk_value = bind('OPENSSL_sk_value', P, P, I)
    sk_free = bind('OPENSSL_sk_free', None, P)

    directory = Path(__file__).resolve().parent
    owned = []

    def read_pem(pem):
        buf = C.create_string_buffer(pem)
        bio = bio_new(buf, len(pem))
        if not bio:
            raise RuntimeError('BIO_new_mem_buf failed')
        try:
            cert = pem_read(bio, None, None, None)
        finally:
            bio_free(bio)
        if not cert:
            raise RuntimeError('PEM_read_bio_X509 failed')
        owned.append(cert)
        return cert

    def name(ptr):
        buf = C.create_string_buffer(2048)
        if not name_line(ptr, buf, len(buf)):
            raise RuntimeError('X509_NAME_oneline failed')
        return buf.value.decode('utf-8', 'replace')

    def describe(cert):
        buf, length = (C.c_ubyte * 64)(), U()
        if digest(cert, sha256(), buf, C.byref(length)) != 1:
            raise RuntimeError('X509_digest failed')
        return {'subject': name(subject(cert)), 'issuer': name(issuer(cert)),
                'sha256_der': bytes(buf[:length.value]).hex().upper()}

    certs = {name: read_pem((directory / name).read_bytes()) for name in
             ['leaf.pem', 'aia-intermediate.pem', 'root-x1.pem', 'root-x2.pem']}
    leaf = certs['leaf.pem']
    intermediate = certs['aia-intermediate.pem']
    report = {'library': args.lib, 'version': version(0).decode(),
              'input_certificates': {n: describe(p) for n, p in certs.items()},
              'direct_signatures': {}, 'scenarios': []}
    for filename in ['aia-intermediate.pem', 'root-x1.pem', 'root-x2.pem']:
        key = public_key(certs[filename])
        try:
            report['direct_signatures']['leaf <- ' + filename] = verify_signature(leaf, key)
        finally:
            key_free(key)

    def scenario(label, trusted, untrusted):
        store, ctx, stack = store_new(), ctx_new(), sk_new()
        if not store or not ctx or not stack:
            raise RuntimeError('allocation failed')
        chain = None
        try:
            for cert in trusted:
                if store_add(store, cert) != 1:
                    raise RuntimeError('X509_STORE_add_cert failed')
            for cert in untrusted:
                if sk_push(stack, cert) <= 0:
                    raise RuntimeError('OPENSSL_sk_push failed')
            if ctx_init(ctx, store, leaf, stack) != 1:
                raise RuntimeError('X509_STORE_CTX_init failed')
            if ctx_purpose(ctx, 2) != 1:  # X509_PURPOSE_SSL_SERVER
                raise RuntimeError('setting server verification purpose failed')
            if set_host(ctx_param(ctx), b'data.wxrank.com', 0) != 1:
                raise RuntimeError('setting verification hostname failed')
            result = verify(ctx)
            code = error_code(ctx)
            chain = get_chain(ctx)
            built = [describe(sk_value(chain, i)) for i in range(sk_num(chain))] if chain else []
            report['scenarios'].append({'label': label, 'result': result,
                'error': code, 'error_depth': error_depth(ctx),
                'error_text': error_text(code).decode(), 'built_chain': built})
        finally:
            if chain:
                for i in range(sk_num(chain)):
                    cert_free(sk_value(chain, i))
                sk_free(chain)
            ctx_free(ctx)
            store_free(store)
            sk_free(stack)

    try:
        for root_name in ['root-x1.pem', 'root-x2.pem']:
            scenario(root_name + ' only, no intermediate', [certs[root_name]], [])
            scenario(root_name + ' plus untrusted YE1', [certs[root_name]], [intermediate])
        # Adding an intermediate to the store does not enable PARTIAL_CHAIN.
        # Keep the normal full-chain policy; this is not a production trust change.
        scenario('YE1 in store, default full-chain policy', [intermediate], [])
        roots = [read_pem(block) for block in re.findall(
            rb'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----',
            (directory / 'node-roots.pem').read_bytes(), re.S)]
        scenario('Node root store plus untrusted YE1', roots, [intermediate])
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        for cert in owned:
            cert_free(cert)


if __name__ == '__main__':
    main()
