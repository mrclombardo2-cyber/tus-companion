export const TUS_EXAM_OFFICIAL_URL = "https://tus.ie/exams/midlands/timetables/";
export function examProgrammeForSelection(selection, data) {
  if (!data?.programmes || !selection) return null;
  const keys=Object.keys(data.programmes).sort((a,b)=>b.length-a.length);
  const samples=[selection.group,selection.groupLabel].filter(Boolean).map(s=>String(s).toUpperCase());
  for(const sample of samples)for(const key of keys){
    let pos=sample.indexOf(key.toUpperCase());
    while(pos>=0){
      const before=pos===0?" ":sample[pos-1],after=sample[pos+key.length]||" ";
      if(!/[A-Z0-9_]/.test(before)&&!/[A-Z0-9_]/.test(after))return key;
      pos=sample.indexOf(key.toUpperCase(),pos+1);
    }
  }
  return null; // Never guess an exam programme from a module-name overlap.
}
export function examsForProgramme(data, programmeCode){
  const entry=data?.programmes?.[programmeCode];
  return Array.isArray(entry?.exams)?[...entry.exams].sort((a,b)=>
    (a.date+" "+a.start+" "+a.module_code).localeCompare(b.date+" "+b.start+" "+b.module_code)):[];
}
export function examsForDate(data,programmeCode,date){
  return examsForProgramme(data,programmeCode).filter(e=>e.date===date);
}
export function examSourceFreshness(data,now=Date.now()){
  const ms=Date.parse(data?.last_checked_at||"");
  if(!Number.isFinite(ms))return {fresh:false,label:"Source not verified"};
  const age=Math.max(0,now-ms),h=Math.floor(age/3600000);
  return {fresh:age<24*3600_000,label:h<1?"Source checked less than 1 hour ago":
    "Source checked "+h+" hour"+(h===1?"":"s")+" ago"};
}
export function examProgrammeChoices(data){
  return Object.entries(data?.programmes||{}).map(([code,x])=>({code,name:x.name}))
    .sort((a,b)=>a.name.localeCompare(b.name)||a.code.localeCompare(b.code));
}
