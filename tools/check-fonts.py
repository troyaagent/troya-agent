# Glyph outlines of the site's own self-hosted fonts (public/fonts, SIL OFL) for the Troya Check card (server/check.mjs).
# The card is an SVG that sharp turns into a PNG. sharp's SVG text goes through Pango, which picks system fonts (CoreText on
# a Mac, fontconfig on the server) and cannot read WOFF2, so the words on the card are drawn as paths instead: each face the
# card uses is cut once from the same files the site serves, and its outlines, advances and kerning pairs are kept as JSON.
#   python3 -m venv /tmp/ftv && /tmp/ftv/bin/pip install fonttools brotli && /tmp/ftv/bin/python tools/check-fonts.py
#   → server/check-assets/glyphs.json
# Run it again only if public/fonts or the faces below change. Nothing is downloaded: the inputs are the files in public/fonts.
import os, json, shutil
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "public", "fonts")
OUT = os.path.join(HERE, "..", "server", "check-assets")
os.makedirs(OUT, exist_ok=True)

ASCII = "".join(chr(c) for c in range(32, 127))
EXTRA = "·–—…→’‘“”×−•▲▼" + "".join(chr(c) for c in range(0xC0, 0x100))
CHARS = ASCII + EXTRA
FACES = [
    ("sans400", "instrument-sans-latin.woff2", 400),
    ("sans500", "instrument-sans-latin.woff2", 500),
    ("sans600", "instrument-sans-latin.woff2", 600),
    ("sans700", "instrument-sans-latin.woff2", 700),
    ("mono500", "jetbrains-mono-500.woff2", None),
]

def kern_pairs(font, cmap_rev):
    """Pair kerning (x advance) between the glyphs we keep, from GPOS PairPos lookups of the 'kern' feature."""
    out = {}
    if "GPOS" not in font: return out
    gpos = font["GPOS"].table
    keep = set(cmap_rev)
    lookups = set()
    for fr in gpos.FeatureList.FeatureRecord:
        if fr.FeatureTag == "kern": lookups.update(fr.Feature.LookupListIndex)
    for li in sorted(lookups):
        lk = gpos.LookupList.Lookup[li]
        subs = lk.SubTable
        if lk.LookupType == 9: subs = [s.ExtSubTable for s in subs]
        for st in subs:
            if getattr(st, "LookupType", 2) != 2 and lk.LookupType not in (2, 9): continue
            if not hasattr(st, "Format"): continue
            cov = st.Coverage.glyphs
            if st.Format == 1:
                for i, g1 in enumerate(cov):
                    if g1 not in keep: continue
                    for pvr in st.PairSet[i].PairValueRecord:
                        g2 = pvr.SecondGlyph
                        if g2 in keep and pvr.Value1 is not None and abs(getattr(pvr.Value1, "XAdvance", 0)) >= 6:
                            out.setdefault(cmap_rev[g1] + cmap_rev[g2], pvr.Value1.XAdvance)
            elif st.Format == 2:
                cd1 = st.ClassDef1.classDefs; cd2 = st.ClassDef2.classDefs
                for g1 in cov:
                    if g1 not in keep: continue
                    c1 = cd1.get(g1, 0)
                    for g2 in keep:
                        c2 = cd2.get(g2, 0)
                        v = st.Class1Record[c1].Class2Record[c2].Value1
                        x = getattr(v, "XAdvance", 0) if v is not None else 0
                        if abs(x) >= 6: out.setdefault(cmap_rev[g1] + cmap_rev[g2], x)
    return out

faces = {}
for key, file, wght in FACES:
    f = TTFont(os.path.join(SRC, file))
    if wght: f = instancer.instantiateVariableFont(f, {"wght": wght})
    cmap = f.getBestCmap(); gs = f.getGlyphSet(); hmtx = f["hmtx"]
    rev = {}
    glyphs = {}
    for ch in CHARS:
        gn = cmap.get(ord(ch))
        if not gn: continue
        rev.setdefault(gn, ch)
        pen = SVGPathPen(gs, ntos=lambda v: ("%.1f" % v).rstrip("0").rstrip("."))
        gs[gn].draw(TransformPen(pen, (1, 0, 0, -1, 0, 0)))            # y down, as in SVG
        glyphs[ch] = {"a": hmtx[gn][0], "d": pen.getCommands()}
    # every char mapped to a kept glyph name, so pairs reach chars that share a glyph
    names = {cmap[ord(ch)]: ch for ch in CHARS if cmap.get(ord(ch))}
    faces[key] = {"upm": f["head"].unitsPerEm, "asc": f["hhea"].ascent, "desc": f["hhea"].descent,
                  "glyphs": glyphs, "kern": kern_pairs(f, names)}
    print(key, len(glyphs), "glyphs", len(faces[key]["kern"]), "kern pairs")

with open(os.path.join(OUT, "glyphs.json"), "w") as fh: json.dump({"faces": faces}, fh, separators=(",", ":"), ensure_ascii=False)
shutil.copy(os.path.join(SRC, "OFL.txt"), os.path.join(OUT, "OFL.txt"))
print("ok", os.path.getsize(os.path.join(OUT, "glyphs.json")), "bytes")
