#!/usr/bin/env python3
import os, shutil, sys
ROOT = sys.argv[1] if len(sys.argv) > 1 else "/Users/a0000/Desktop/delphi-agent"

def patch(rel, edits):
    p = os.path.join(ROOT, rel)
    t = open(p, encoding="utf8").read(); o = t
    for old, new, label in edits:
        if new in t: print(f"   = already applied: {label}"); continue
        if t.count(old) != 1: raise SystemExit(f"!! {rel}: '{label}' found {t.count(old)}x. Nothing written.")
        t = t.replace(old, new); print(f"   + {label}")
    if t != o:
        if not os.path.exists(p + ".bak"): shutil.copy(p, p + ".bak")
        open(p, "w", encoding="utf8").write(t)

patch("public/dashboard.html", [
    ("no judgments yet — appears once live submission is wired (23 Nov)",
     "no judgments yet — appears once the first live submission is judged", "html: judge panel text"),
])
patch("public/dashboard.js", [
    ('"DRY_RUN · live not wired"', '"DRY_RUN · live not ready"', "js: pill text"),
    ("pill.title = `MODE=${s.mode}`;",
     "pill.title = `MODE=${s.mode}` + ((s.liveReasons || []).length ? \"\\n\" + s.liveReasons.join(\"\\n\") : \"\");",
     "js: pill tooltip shows why"),
    ("opens 23 Nov 17:00 UTC", "opens 25 Nov 17:00 UTC", "js: comment"),
])
patch("src/evidence/loop.ts", [
    ("refreshLiveReadiness, type Submitter }", "refreshLiveReadiness, liveStatus, type Submitter }", "loop: import liveStatus"),
    ("liveSubmitterReady: isLiveReady(), searchProviders: enabledProviders(),",
     "liveSubmitterReady: isLiveReady(), liveReasons: liveStatus().reasons, searchProviders: enabledProviders(),",
     "loop: write liveReasons to status"),
])
print("Done. Run: npx tsc --noEmit")