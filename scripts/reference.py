"""Independent Python standard library oracles; deterministic synthetic data."""
import csv, datetime, hashlib, heapq, io, json, math, random, subprocess
from pathlib import Path
root = Path(__file__).resolve().parents[1]
random.seed(20261005)
def run(request):
    result = subprocess.run(['node',str(root/'_build/js/debug/build/cmd/main/main.js'),'-'],
        input=json.dumps(request),capture_output=True,text=True,encoding='utf-8',timeout=30)
    if result.returncode: raise RuntimeError(result.stdout or result.stderr)
    return json.loads(result.stdout)

files = [{'path':str(i)+'.bin','bytes':[random.randrange(256) for _ in range(random.randrange(256))]} for i in range(30)]
result = run({'files':files})
expected = {f['path']:hashlib.sha256(bytes(f['bytes'])).hexdigest() for f in files}
for f in result['snapshot']['files']: assert f['digest'] == expected[f['path']]
restored = run({'operation':'restore','snapshot':result['snapshot']})
assert {f['path']:f['bytes'] for f in restored['files']} == {f['path']:f['bytes'] for f in files}
assert run({'operation':'audit','snapshot':result['snapshot']})['valid']
print('Python hashlib oracle: 30 binary inputs, SHA256, audit and verified restore passed')
