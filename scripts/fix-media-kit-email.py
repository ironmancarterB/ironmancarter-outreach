"""Correct the contact email in the IronmanCarter media kit without touching anything else.

Usage: python3 -I scripts/fix-media-kit-email.py <original.pdf> <corrected.pdf>

The email is drawn by one small content stream (object 15, the last object in the file) on top of a
white box. This script copies every byte before that object verbatim, rewrites only that stream with
the corrected address, and appends a fresh cross-reference table. Fonts, photo, page 1, all other text
and the layout are unchanged.
"""
import re
import sys
import zlib

OLD = 'Ironmancaerterbusiness@gmail.com'.encode().hex().encode()
NEW = 'ironmancarterbusiness@gmail.com'.encode().hex().encode()
TARGET = 15

src, dst = sys.argv[1], sys.argv[2]
data = open(src, 'rb').read()
assert data.count(b'startxref') == 1, 'file has incremental updates; refusing to edit'

objs = [(int(m.group(1)), m.start(), m.end()) for m in re.finditer(rb'(\d+) 0 obj.*?endobj', data, re.S)]
assert objs[-1][0] == TARGET, 'expected the email object to be the last object'
_, start, end = objs[-1]

body = data[start:end]
stream = body.split(b'stream', 1)[1]
stream = stream[2:] if stream[:2] == b'\r\n' else stream[1:]
stream = stream[:stream.rindex(b'endstream')].rstrip(b'\r\n')
content = zlib.decompress(stream)
assert content.count(b'<' + OLD + b'>') == 1, 'misspelled address not found exactly once'
content = content.replace(b'<' + OLD + b'>', b'<' + NEW + b'>')
comp = zlib.compress(content, 9)

out = bytearray(data[:start])
out += b'%d 0 obj\n<</Length %d/Filter/FlateDecode>>\nstream\n' % (TARGET, len(comp)) + comp + b'\nendstream\nendobj\n\n'

offsets = {num: s for num, s, _ in objs}
size = max(offsets) + 1
trailer = re.search(rb'trailer\s*(<<.*?>>)\s*startxref', data, re.S).group(1)
xref_at = len(out)
out += b'xref\n0 %d\n0000000000 65535 f \n' % size
for n in range(1, size):
    out += b'%010d 00000 n \n' % offsets[n]
out += b'\ntrailer\n' + trailer + b'\nstartxref\n%d\n%%%%EOF\n' % xref_at
open(dst, 'wb').write(out)
print('wrote', dst, len(out), 'bytes')
