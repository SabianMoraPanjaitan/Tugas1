import numpy as np
LENS = [2, 3, 3, 3, 3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]      # code length of categories 0..16
def table():
    code, codes, prev = 0, {}, LENS[0]
    for sym, ln in enumerate(LENS):
        code <<= (ln - prev); prev = ln; codes[sym] = (code, ln); code += 1
    return codes
def encode(a, sel, ri=0, pt=0, P=16):
    H, W = a.shape; a = a >> pt; codes = table(); bits = []; segs = []
    def put(v, n):
        for i in range(n - 1, -1, -1): bits.append((v >> i) & 1)
    def flush():
        while len(bits) % 8: bits.append(1)
        b = bytearray()
        for i in range(0, len(bits), 8):
            v = 0
            for x in bits[i:i + 8]: v = (v << 1) | x
            b.append(v)
            if v == 0xFF: b.append(0)
        bits.clear(); return bytes(b)
    first, left, rst = True, ri, 0
    for y in range(H):
        for x in range(W):
            if ri and left == 0:
                segs.append(flush() + bytes([0xFF, 0xD0 + rst])); rst = (rst + 1) % 8; left = ri; first = True
            if first: pred = a[y, x - 1] if x else 1 << (P - pt - 1)
            elif x == 0: pred = a[y - 1, x]
            else:
                A, B, C = a[y, x - 1], a[y - 1, x], a[y - 1, x - 1]
                pred = [A, B, C, A + B - C, A + ((B - C) >> 1), B + ((A - C) >> 1), (A + B) >> 1][sel - 1]
            d = int(a[y, x] - pred) & 0xFFFF
            if d > 32768: d -= 65536
            s = 16 if d == 32768 else abs(d).bit_length()
            put(*codes[s])
            if 0 < s < 16: put(d if d >= 0 else d + (1 << s) - 1, s)
            if ri: left -= 1
        first = False
    segs.append(flush())
    dht = bytes([0]) + bytes([LENS.count(n) for n in range(1, 17)]) + bytes(sorted(range(17), key=lambda s: (LENS[s], s)))
    j = b'\xFF\xD8' + b'\xFF\xC4' + (len(dht) + 2).to_bytes(2, 'big') + dht
    j += b'\xFF\xC3' + (11).to_bytes(2, 'big') + bytes([P]) + H.to_bytes(2, 'big') + W.to_bytes(2, 'big') + bytes([1, 1, 0x11, 0])
    if ri: j += b'\xFF\xDD' + (4).to_bytes(2, 'big') + ri.to_bytes(2, 'big')
    j += b'\xFF\xDA' + (8).to_bytes(2, 'big') + bytes([1, 1, 0x00, sel, 0, pt])
    return j + b''.join(segs) + b'\xFF\xD9'
