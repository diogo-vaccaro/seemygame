/** PowerShell Get-Content -Raw may return pretty JSON rather than JSONL. */
export function parseSshMessages(output){
 const value=String(output).replace(/^\uFEFF/,'').trim();
 try{return [JSON.parse(value)];}catch{}
 return value.split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
}
