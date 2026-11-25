#!/usr/bin/env python3
import os, shutil, sys

p = sys.argv[1] if len(sys.argv) > 1 else "/Users/a0000/Desktop/delphi-agent/src/evidence/submit.ts"
t = open(p, encoding="utf8").read()

old = "async function api<T>(label: string, fn: () => Promise<T>): Promise<T> {"
new = "async function api<T = any>(label: string, fn: () => Promise<T>): Promise<T> {"

if new in t:
    print("= already applied")
elif t.count(old) != 1:
    raise SystemExit(f"!! anchor found {t.count(old)}x (expected 1). Nothing written.")
else:
    if not os.path.exists(p + ".bak"):
        shutil.copy(p, p + ".bak")
    open(p, "w", encoding="utf8").write(t.replace(old, new))
    print("+ api<T = any>")