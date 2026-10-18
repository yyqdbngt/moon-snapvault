"""Independent follow-up oracles over synthetic deterministic inputs."""
import collections,copy,hashlib,json,math,random,subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[1]
random.seed(20261018)
def run(request, error=False):
    result=subprocess.run(['node',str(root/'_build/js/debug/build/cmd/main/main.js'),'-'],input=json.dumps(request),capture_output=True,text=True,encoding='utf-8',timeout=60)
    if error:
        assert result.returncode==1,(result.returncode,result.stdout); return
    assert result.returncode in (0,2),(result.returncode,result.stdout,result.stderr)
    return json.loads(result.stdout)

for i in range(10):
    shared='shared'+str(i); obsolete='old'+str(i); recent='new'+str(i)
    first=run({'files':[{'path':'a','text':shared},{'path':'b','text':obsolete}]})['snapshot']
    second=run({'files':[{'path':'a','text':shared},{'path':'b','text':recent}]})['snapshot']
    request={'operation':'retention','snapshots':[{'id':'old','snapshot':first},{'id':'new','snapshot':second}],'keep':['new']}
    report=run(request)
    digest=lambda s:hashlib.sha256(s.encode()).hexdigest()
    assert set(report['reachable_objects'])=={digest(shared),digest(recent)}
    assert report['collectible_objects']==[digest(obsolete)] and report['collectible_bytes']==len(obsolete.encode())
    corrupted=copy.deepcopy(request); key=next(iter(corrupted['snapshots'][0]['snapshot']['objects'])); corrupted['snapshots'][0]['snapshot']['objects'][key][0]^=1
    run(corrupted,error=True)
print('Retention: 10 independent SHA-256 reachability sets and corruption rejection passed')
