import {it,expect} from 'vitest';
import {parseSshMessages} from '../tools/e2e/harness/ssh-messages.mjs';
it('accepts pretty PowerShell ready JSON and existing JSONL without exposing capabilities',()=>{
 const ready={kind:'seemygame-e2e-viewer-ready',controlEndpoint:'private-test-value'};
 expect(parseSshMessages('\uFEFF'+JSON.stringify(ready,null,2)+'\r\n')).toEqual([ready]);
 expect(parseSshMessages('diagnostic\n'+JSON.stringify({status:'starting'})+'\n'+JSON.stringify(ready))).toEqual([{status:'starting'},ready]);
 expect(parseSshMessages('not JSON')).toEqual([]);
});
